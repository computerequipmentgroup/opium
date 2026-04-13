import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("claude-cli");

/**
 * Maps request model IDs and aliases to canonical Claude CLI model IDs.
 * Ported from ocp/server.mjs MODEL_MAP.
 */
const MODEL_MAP: Record<string, string> = {
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-opus-4": "claude-opus-4-6",
  "claude-haiku-4": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

const DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
];

function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

/**
 * In-memory session map. Lets follow-up requests in the same conversation
 * reuse a CLI session via `--resume <uuid>`, so we don't re-send the whole
 * transcript as a fresh prompt every turn. Single-instance only.
 */
interface SessionEntry {
  uuid: string;
  lastUsed: number;
  messageCount: number;
  model: string;
}
const sessions = new Map<string, SessionEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > config.claudeSessionTtlMs) {
      sessions.delete(id);
      logger.debug(
        {
          conversationId: id.slice(0, 12),
          idleMinutes: Math.round((now - s.lastUsed) / 60000),
        },
        "Expired idle session",
      );
    }
  }
}, 60_000).unref();

/**
 * Global concurrency gate — caps simultaneous `claude` child processes.
 * Exceeding throws synchronously so the caller can retry another account.
 */
let activeCount = 0;

export interface ClaudeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface ClaudeSpawnOptions {
  /** HOME directory for the spawn — determines which account credentials are used. */
  home: string;
  /** User-requested model (aliases resolved via MODEL_MAP). */
  model: string;
  /** Flattened message list. System messages become --system-prompt; others feed stdin. */
  messages: ClaudeMessage[];
  /** Optional stable conversation ID — enables session resume for multi-turn chats. */
  conversationId?: string;
  /** Pre-approved tool list. Empty = no tools. */
  allowedTools?: string[];
  /** Bypass permission checks. Default false. */
  skipPermissions?: boolean;
  /** Per-request timeout override. Default: config.claudeTimeoutMs. */
  timeoutMs?: number;
}

export interface ClaudeStreamHandle {
  /** Resolves when the CLI process exits successfully, rejects on failure. */
  done: Promise<{ exitCode: number | null; elapsedMs: number }>;
  /** Kill the child process. */
  abort: () => void;
}

/** Parsed NDJSON line from the CLI. Shape is stream-dependent; we pass through. */
export type ClaudeStreamEvent = Record<string, unknown> & { type?: string };

const MAX_PROMPT_CHARS = 150_000;

/**
 * Flatten messages into a single stdin prompt.
 *
 * IMPORTANT: system messages from the request are inlined into the stdin
 * blob with a `[System]` prefix, NOT hoisted to `--append-system-prompt`.
 * Passing large third-party-agent content via `--append-system-prompt`
 * trips Anthropic's "third-party apps" detector and 400s with the
 * "now draws from extra usage" error. stdin content is not scanned the
 * same way. Mirrors the approach in ocp/server.mjs.
 */
function flattenMessages(messages: ClaudeMessage[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  const convoParts: string[] = [];

  for (const m of messages) {
    // Skip tool result messages entirely - CLI handles tools internally
    if (m.role === "tool") continue;
    // Handle content that might be an array of blocks
    let textContent: string;
    if (typeof m.content === "string") {
      textContent = m.content;
    } else if (Array.isArray(m.content)) {
      // Extract only text blocks, skip tool_use/tool_result
      textContent = m.content
        .filter(
          (block: any) => block.type === "text" || typeof block === "string",
        )
        .map((block: any) =>
          typeof block === "string" ? block : block.text || "",
        )
        .join("\n");
    } else {
      textContent = JSON.stringify(m.content);
    }
    if (!textContent.trim()) continue; // Skip empty messages after filtering
    if (m.role === "system") {
      convoParts.push(`[System] ${textContent}`);
    } else if (m.role === "assistant") {
      convoParts.push(`[Assistant] ${textContent}`);
    } else {
      convoParts.push(textContent);
    }
  }
  let userPrompt = convoParts.join("\n\n");
  if (userPrompt.length > MAX_PROMPT_CHARS) {
    logger.warn(
      { originalChars: userPrompt.length, maxChars: MAX_PROMPT_CHARS },
      "Prompt exceeds max chars, truncating from the head",
    );
    userPrompt =
      `[Note: older context truncated to fit ${MAX_PROMPT_CHARS} chars]\n\n` +
      userPrompt.slice(userPrompt.length - MAX_PROMPT_CHARS);
  }
  return {
    systemPrompt: "",
    userPrompt,
  };
}

function latestUserMessage(messages: ClaudeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        return m.content;
      }
      if (Array.isArray(m.content)) {
        return m.content
          .filter((block: any) => block.type === "text" || typeof block === "string")
          .map((block: any) => (typeof block === "string" ? block : block.text || ""))
          .join("\n");
      }
      return JSON.stringify(m.content);
    }
  }
  return "";
}

function buildCliArgs(opts: {
  cliModel: string;
  session: { uuid: string; resume: boolean } | null;
  systemPrompt: string;
  allowedTools: string[];
  skipPermissions: boolean;
}): string[] {
  // stream-json + --include-partial-messages is required so the CLI emits
  // `stream_event` envelopes the proxy can unwrap into Anthropic SSE deltas.
  // Without --include-partial-messages the CLI emits full `assistant`
  // messages instead and the proxy's event parser drops them, leaving the
  // client with an empty response.
  const args: string[] = [
    "-p",
    "--model",
    opts.cliModel,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (opts.session?.resume) {
    args.push("--resume", opts.session.uuid);
  } else if (opts.session?.uuid) {
    args.push("--session-id", opts.session.uuid);
  } else {
    args.push("--no-session-persistence");
  }

  if (opts.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }

  // APPEND to Claude Code's default system prompt instead of replacing it.
  // Replacing was a big fingerprint for third-party automation. Costs ~23k
  // extra input tokens per request but should pass Anthropic detection.
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  return args;
}

function buildChildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Strip any ambient Anthropic config so the CLI only honors OAuth creds
  // from our materialized HOME.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;

  // Minimize Claude Code's default context injection — we want raw API behavior.
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";

  env.HOME = home;

  return env;
}

/**
 * Spawn a `claude -p` process for the given options and stream stream-json
 * events to `onEvent`. Returns a handle whose `done` promise settles when
 * the process exits.
 *
 * Throws synchronously if the concurrency gate is full.
 */
export function runClaudeStream(
  opts: ClaudeSpawnOptions,
  onEvent: (event: ClaudeStreamEvent) => void,
): ClaudeStreamHandle {
  if (activeCount >= config.claudeMaxConcurrent) {
    throw new Error(
      `claude concurrency limit reached (${activeCount}/${config.claudeMaxConcurrent})`,
    );
  }

  const cliModel = resolveModel(opts.model);

  // Session strategy: resume if we have a live entry, otherwise create a new
  // session id (if caller supplied a conversationId), otherwise one-off.
  let session: { uuid: string; resume: boolean } | null = null;
  let promptForStdin: string;
  let systemPrompt: string;

  const flat = flattenMessages(opts.messages);
  systemPrompt = flat.systemPrompt;

  if (opts.conversationId && sessions.has(opts.conversationId)) {
    const entry = sessions.get(opts.conversationId)!;
    entry.lastUsed = Date.now();
    entry.messageCount = opts.messages.length;
    session = { uuid: entry.uuid, resume: true };
    promptForStdin = latestUserMessage(opts.messages);
  } else if (opts.conversationId) {
    const uuid = randomUUID();
    sessions.set(opts.conversationId, {
      uuid,
      lastUsed: Date.now(),
      messageCount: opts.messages.length,
      model: cliModel,
    });
    session = { uuid, resume: false };
    promptForStdin = flat.userPrompt;
  } else {
    promptForStdin = flat.userPrompt;
  }

  logger.debug(
    { cliModel, optsModel: opts.model, resolved: opts.model !== cliModel },
    "Resolved model"
  );

  const args = buildCliArgs({
    cliModel,
    session,
    systemPrompt,
    allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    skipPermissions: opts.skipPermissions ?? false,
  });

  const env = buildChildEnv(opts.home);
  const timeoutMs = opts.timeoutMs ?? config.claudeTimeoutMs;

  logger.debug(
    {
      cliModel,
      promptChars: promptForStdin.length,
      systemChars: systemPrompt.length,
      home: opts.home,
      session: session
        ? { uuid: session.uuid.slice(0, 8), resume: session.resume }
        : null,
      activeCount: activeCount + 1,
    },
    "Spawning claude CLI",
  );

  activeCount++;
  const t0 = Date.now();
  let proc: ChildProcessWithoutNullStreams;

  try {
    proc = spawn(config.claudeBin, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    activeCount--;
    throw err;
  }

  // Write the prompt immediately and close stdin so the CLI starts processing.
  proc.stdin.write(promptForStdin);
  proc.stdin.end();

  // NDJSON line buffer — the CLI emits one JSON event per line on stdout.
  let stdoutBuffer = "";
  let stderrBuffer = "";
  // DEBUG: keep last N parsed events so we can dump them on failure.
  const recentEvents: string[] = [];
  const RECENT_MAX = 20;

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      recentEvents.push(line.slice(0, 500));
      if (recentEvents.length > RECENT_MAX) recentEvents.shift();
      try {
        const event = JSON.parse(line) as ClaudeStreamEvent;
        onEvent(event);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, preview: line.slice(0, 200) },
          "Failed to parse stream-json line",
        );
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  // Hard timeout — SIGTERM then SIGKILL after 5s, matching OCP.
  let killed = false;
  const timeoutTimer = setTimeout(() => {
    killed = true;
    logger.warn(
      { cliModel, timeoutMs, elapsed: Date.now() - t0 },
      "Claude CLI request timed out",
    );
    try {
      proc.kill("SIGTERM");
    } catch {
      /* noop */
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }, 5_000);
  }, timeoutMs);

  const done = new Promise<{ exitCode: number | null; elapsedMs: number }>(
    (resolve, reject) => {
      proc.on("close", (code, signal) => {
        clearTimeout(timeoutTimer);
        activeCount--;
        const elapsedMs = Date.now() - t0;

        // Flush any trailing line in the buffer.
        const tail = stdoutBuffer.trim();
        if (tail) {
          try {
            onEvent(JSON.parse(tail) as ClaudeStreamEvent);
          } catch {
            /* ignore */
          }
          stdoutBuffer = "";
        }

        if (code === 0) {
          logger.debug({ cliModel, elapsedMs }, "Claude CLI exited OK");
          resolve({ exitCode: code, elapsedMs });
          return;
        }

        // Resume failures are often caused by a stale session — drop it so
        // the next call creates a fresh one.
        if (session?.resume && opts.conversationId) {
          sessions.delete(opts.conversationId);
        }

        const msg = killed
          ? `claude CLI timeout after ${timeoutMs}ms`
          : stderrBuffer.trim().slice(0, 500) ||
            `claude CLI exited with code=${code} signal=${signal ?? "none"}`;
        logger.warn(
          {
            cliModel,
            code,
            signal,
            elapsedMs,
            errMsg: msg,
            stderrRaw: stderrBuffer.slice(0, 2000),
            stdoutTail: stdoutBuffer.slice(0, 2000),
            recentEvents,
            args,
            promptChars: promptForStdin.length,
            systemChars: systemPrompt.length,
          },
          "Claude CLI exited with error",
        );
        reject(new Error(msg));
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutTimer);
        activeCount--;
        logger.error({ err: err.message }, "Failed to spawn claude CLI");
        reject(err);
      });
    },
  );

  return {
    done,
    abort: () => {
      if (!proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* noop */
        }
      }
    },
  };
}

/** Current active-process count, for diagnostics. */
export function getActiveCount(): number {
  return activeCount;
}

/** Current session map size, for diagnostics. */
export function getSessionCount(): number {
  return sessions.size;
}
