import type { Request, Response } from "express";
import { createChildLogger } from "../utils/logger.js";
import {
  selectBestAccount,
  markAccountRateLimited,
  updateAccountUsage,
  clearExpiredRateLimits,
} from "./pool.js";
import { materializeAccountHome, invalidateAccountHome } from "./claudeHome.js";
import {
  runClaudeStream,
  type ClaudeMessage,
  type ClaudeStreamEvent,
} from "./claudeCli.js";
import type { User } from "../types/index.js";

const logger = createChildLogger("proxy");

// ── Request body → CLI input ─────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface MessagesRequestBody {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
}

interface AdaptedRequest {
  model: string;
  messages: ClaudeMessage[];
  stream: boolean;
  conversationId?: string;
}

class BadRequestError extends Error {
  constructor(message: string, public code: string = "INVALID_REQUEST") {
    super(message);
  }
}

/**
 * Flatten an Anthropic content-block array (or string) into plain text.
 * Rejects image/tool blocks — the CLI path only supports text today.
 * Silently drops `thinking` blocks (assistant-only reasoning artifacts).
 */
function flattenContent(
  content: string | AnthropicContentBlock[],
  role: "system" | "user" | "assistant"
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new BadRequestError(
      `content must be a string or array of blocks (got ${typeof content})`
    );
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      throw new BadRequestError("content block must be an object");
    }
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "thinking":
      case "redacted_thinking":
        // assistant internal state — not part of the prompt
        break;
      case "image":
        throw new BadRequestError(
          "image content blocks are not supported by the CLI proxy path",
          "UNSUPPORTED_CONTENT"
        );
      case "tool_use":
      case "tool_result":
        throw new BadRequestError(
          `${block.type} content blocks are not supported by the CLI proxy path`,
          "UNSUPPORTED_CONTENT"
        );
      default:
        throw new BadRequestError(
          `unsupported content block type: ${block.type}`,
          "UNSUPPORTED_CONTENT"
        );
    }
  }
  // role unused here but kept so future handling (e.g. assistant tool diffs)
  // can branch without resignaturing callers.
  void role;
  return parts.join("");
}

function adaptMessagesRequest(
  body: MessagesRequestBody,
  conversationId?: string
): AdaptedRequest {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("request body must be a JSON object");
  }
  if (typeof body.model !== "string" || !body.model) {
    throw new BadRequestError("model is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequestError("messages must be a non-empty array");
  }

  const out: ClaudeMessage[] = [];

  // system channel: string OR content-block array OR omitted
  if (body.system !== undefined && body.system !== null) {
    const systemText = flattenContent(
      body.system as string | AnthropicContentBlock[],
      "system"
    );
    if (systemText) {
      out.push({ role: "system", content: systemText });
    }
  }

  for (const raw of body.messages as AnthropicMessage[]) {
    if (!raw || (raw.role !== "user" && raw.role !== "assistant")) {
      throw new BadRequestError(
        `message role must be "user" or "assistant"`
      );
    }
    const text = flattenContent(raw.content, raw.role);
    out.push({ role: raw.role, content: text });
  }

  return {
    model: body.model,
    messages: out,
    stream: body.stream === true,
    conversationId,
  };
}

// ── stream-json envelope handling ────────────────────────────────────────

interface RateLimitInfo {
  status?: string;
  resetsAt?: string;
  rateLimitType?: string;
  overageStatus?: string;
}

/**
 * Per-request state collected while the CLI streams events. Streaming mode
 * writes each Anthropic event straight to the wire; non-streaming mode
 * assembles the final Message from the same event sequence.
 */
interface EventCollector {
  rateLimit: RateLimitInfo | null;
  // Only populated in non-streaming mode.
  messageStart: Record<string, unknown> | null;
  contentBlocks: Map<number, { type: string; text: string; raw: Record<string, unknown> }>;
  stopReason: string | null;
  stopSequence: string | null;
  usage: Record<string, unknown> | null;
  sawMessageStop: boolean;
}

function newCollector(): EventCollector {
  return {
    rateLimit: null,
    messageStart: null,
    contentBlocks: new Map(),
    stopReason: null,
    stopSequence: null,
    usage: null,
    sawMessageStop: false,
  };
}

/**
 * Turn a collected event stream into an Anthropic Messages response body.
 * Mirrors what api.anthropic.com would return for a non-streaming request.
 */
function assembleMessageResponse(
  collector: EventCollector,
  fallbackModel: string
): Record<string, unknown> {
  const base = (collector.messageStart ?? {}) as Record<string, unknown>;
  const content: Record<string, unknown>[] = [];
  const indices = Array.from(collector.contentBlocks.keys()).sort((a, b) => a - b);
  for (const i of indices) {
    const block = collector.contentBlocks.get(i)!;
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else {
      content.push(block.raw);
    }
  }

  return {
    id: base.id ?? `msg_${Date.now()}`,
    type: "message",
    role: base.role ?? "assistant",
    model: base.model ?? fallbackModel,
    content,
    stop_reason: collector.stopReason,
    stop_sequence: collector.stopSequence,
    usage: collector.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Pull an inner Anthropic SSE event out of a CLI stream-json envelope.
 * Returns null for envelope types we don't care about (system, result, …).
 * Also records rate_limit_event info on the collector as a side effect.
 */
function unwrapCliEvent(
  event: ClaudeStreamEvent,
  collector: EventCollector
): Record<string, unknown> | null {
  const t = event.type;
  if (t === "stream_event") {
    const inner = (event as { event?: unknown }).event;
    if (inner && typeof inner === "object") {
      return inner as Record<string, unknown>;
    }
    return null;
  }
  if (t === "rate_limit_event") {
    const info = (event as { rate_limit_info?: RateLimitInfo }).rate_limit_info;
    if (info) collector.rateLimit = info;
    return null;
  }
  return null;
}

/**
 * Apply an Anthropic SSE event to the non-streaming collector.
 */
function applyEventToCollector(
  ev: Record<string, unknown>,
  collector: EventCollector
): void {
  switch (ev.type) {
    case "message_start": {
      const msg = ev.message as Record<string, unknown> | undefined;
      if (msg) {
        collector.messageStart = msg;
        if (msg.usage) collector.usage = msg.usage as Record<string, unknown>;
      }
      return;
    }
    case "content_block_start": {
      const index = ev.index as number;
      const block = (ev.content_block as Record<string, unknown>) ?? {};
      const type = (block.type as string) ?? "text";
      collector.contentBlocks.set(index, {
        type,
        text: typeof block.text === "string" ? block.text : "",
        raw: block,
      });
      return;
    }
    case "content_block_delta": {
      const index = ev.index as number;
      const delta = (ev.delta as Record<string, unknown>) ?? {};
      const existing =
        collector.contentBlocks.get(index) ?? {
          type: "text",
          text: "",
          raw: { type: "text", text: "" },
        };
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        existing.text += delta.text;
      }
      collector.contentBlocks.set(index, existing);
      return;
    }
    case "content_block_stop":
      return;
    case "message_delta": {
      const delta = (ev.delta as Record<string, unknown>) ?? {};
      if (typeof delta.stop_reason === "string") {
        collector.stopReason = delta.stop_reason;
      }
      if (typeof delta.stop_sequence === "string") {
        collector.stopSequence = delta.stop_sequence;
      }
      if (ev.usage && typeof ev.usage === "object") {
        collector.usage = { ...(collector.usage ?? {}), ...(ev.usage as object) };
      }
      return;
    }
    case "message_stop":
      collector.sawMessageStop = true;
      return;
    default:
      return;
  }
}

function writeSseEvent(res: Response, ev: Record<string, unknown>): void {
  const type = typeof ev.type === "string" ? ev.type : "message";
  res.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

// ── Error classification ─────────────────────────────────────────────────

const AUTH_ERROR_PATTERNS = [
  /not logged in/i,
  /unauthori[sz]ed/i,
  /invalid[_ -]?(api[_ -]?key|token|credentials)/i,
  /authentication[_ ]failed/i,
  /oauth/i,
  /credentials/i,
  /403/,
  /401/,
];

const RATE_LIMIT_PATTERNS = [/rate[_ -]?limit/i, /429/, /quota/i, /usage limit/i];

function classifyCliError(message: string): "auth" | "rate_limit" | "other" {
  if (RATE_LIMIT_PATTERNS.some((r) => r.test(message))) return "rate_limit";
  if (AUTH_ERROR_PATTERNS.some((r) => r.test(message))) return "auth";
  return "other";
}

// ── Forward through the CLI ──────────────────────────────────────────────

type ForwardOutcome =
  | { kind: "done" }
  | { kind: "retry"; reason: "auth" | "rate_limit" | "concurrency" | "spawn_error"; retryAfter?: number }
  | { kind: "error"; status: number; message: string; code: string };

async function forwardRequestViaCli(
  req: Request,
  res: Response,
  account: User,
  adapted: AdaptedRequest
): Promise<ForwardOutcome> {
  const home = await materializeAccountHome(account.id);
  if (!home) {
    return { kind: "retry", reason: "auth" };
  }

  const collector = newCollector();
  let headersSent = false;
  const isStreaming = adapted.stream;

  const ensureSseHeaders = (): boolean => {
    if (headersSent) return true;
    if (res.writableEnded || res.destroyed) return false;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("x-opium-account-id", account.id);
    headersSent = true;
    return true;
  };

  let handle;
  try {
    handle = runClaudeStream(
      {
        home,
        model: adapted.model,
        messages: adapted.messages,
        conversationId: adapted.conversationId,
      },
      (event) => {
        const inner = unwrapCliEvent(event, collector);
        if (!inner) return;

        applyEventToCollector(inner, collector);

        if (isStreaming) {
          if (!ensureSseHeaders()) return;
          writeSseEvent(res, inner);
        }
      }
    );
  } catch (err) {
    const message = (err as Error).message ?? "spawn failed";
    if (/concurrency limit/i.test(message)) {
      return { kind: "retry", reason: "concurrency" };
    }
    logger.error({ accountId: account.id, err: message }, "Failed to spawn claude CLI");
    return { kind: "retry", reason: "spawn_error" };
  }

  // Kill the CLI if the client disconnects mid-stream.
  const onClose = () => handle.abort();
  res.once("close", onClose);

  try {
    await handle.done;
  } catch (err) {
    res.removeListener("close", onClose);
    const message = (err as Error).message ?? "CLI error";
    const kind = classifyCliError(message);

    logger.warn(
      { accountId: account.id, err: message, kind },
      "Claude CLI request failed"
    );

    if (kind === "auth") {
      // Stored credentials rejected by the CLI. Force a rewrite on next use
      // and treat this account as temporarily unusable so the retry loop
      // moves on.
      invalidateAccountHome(account.id);
      markAccountRateLimited(account.id, 300);
      if (!headersSent) {
        return { kind: "retry", reason: "auth" };
      }
      // Headers already flushed — can't retry; close stream.
      res.end();
      return { kind: "done" };
    }

    if (kind === "rate_limit") {
      markAccountRateLimited(account.id, 300);
      if (!headersSent) {
        return { kind: "retry", reason: "rate_limit" };
      }
      res.end();
      return { kind: "done" };
    }

    if (!headersSent) {
      return {
        kind: "error",
        status: 502,
        message: message.slice(0, 300),
        code: "CLI_ERROR",
      };
    }
    res.end();
    return { kind: "done" };
  }

  res.removeListener("close", onClose);

  // Apply rate-limit signal from the inline rate_limit_event, if any.
  if (collector.rateLimit) {
    const resetsAt = collector.rateLimit.resetsAt;
    if (collector.rateLimit.status === "rate_limited") {
      const retryAfter = resetsAt
        ? Math.max(60, Math.round((new Date(resetsAt).getTime() - Date.now()) / 1000))
        : 300;
      markAccountRateLimited(account.id, retryAfter);
    }
  }

  // Bookkeeping: keep Opium's existing usage row in sync. Detailed
  // utilization still comes from the oauth/usage probe (Phase 4), so we
  // only bump the "updated_at" timestamp here if we have no better signal.
  updateAccountUsage(
    account.id,
    account.usage_5h,
    account.usage_7d,
    account.reset_5h ?? undefined,
    account.reset_7d ?? undefined
  );

  if (isStreaming) {
    if (!collector.sawMessageStop && headersSent) {
      // Defensive: CLI exited cleanly but never emitted message_stop.
      writeSseEvent(res, { type: "message_stop" });
    }
    if (headersSent && !res.writableEnded) {
      res.end();
    } else if (!headersSent) {
      // No events ever arrived — surface as an empty 200 so clients don't hang.
      res.status(200).setHeader("x-opium-account-id", account.id);
      res.json(assembleMessageResponse(collector, adapted.model));
    }
    return { kind: "done" };
  }

  // Non-streaming
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("x-opium-account-id", account.id);
  res.send(JSON.stringify(assembleMessageResponse(collector, adapted.model)));
  return { kind: "done" };
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Proxy a request to Anthropic's Messages API via the Claude CLI. Keeps the
 * multi-account retry loop from the old direct-fetch path; only the
 * transport has changed.
 */
export async function proxyRequest(
  req: Request,
  res: Response,
  requesterId: string
): Promise<void> {
  // Only /v1/messages is supported on the CLI path. The router is mounted at
  // /v1, so req.path is "/messages" here.
  if (!/^\/messages\/?$/.test(req.path)) {
    res.status(404).json({
      success: false,
      error: `Path ${req.path} is not supported by the CLI proxy`,
      code: "UNSUPPORTED_PATH",
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({
      success: false,
      error: `Method ${req.method} is not supported`,
      code: "METHOD_NOT_ALLOWED",
    });
    return;
  }

  let adapted: AdaptedRequest;
  try {
    const conversationId = (req.headers["x-opium-conversation-id"] as string) || undefined;
    adapted = adaptMessagesRequest(req.body as MessagesRequestBody, conversationId);
  } catch (err) {
    if (err instanceof BadRequestError) {
      res.status(400).json({
        success: false,
        error: err.message,
        code: err.code,
      });
      return;
    }
    throw err;
  }

  clearExpiredRateLimits();

  const maxRetries = 3;
  let attempts = 0;
  const triedAccounts = new Set<string>();

  while (attempts < maxRetries) {
    attempts++;

    const selection = await selectBestAccount(requesterId);
    if (!selection) {
      logger.warn({ requesterId, attempts }, "No accounts available for proxy request");
      res.status(503).json({
        success: false,
        error: "No accounts available. All accounts may be rate limited.",
        code: "NO_ACCOUNTS_AVAILABLE",
      });
      return;
    }

    const { user: account } = selection;
    if (triedAccounts.has(account.id)) {
      continue;
    }
    triedAccounts.add(account.id);

    const outcome = await forwardRequestViaCli(req, res, account, adapted);

    if (outcome.kind === "done") return;

    if (outcome.kind === "error") {
      // Non-recoverable error from this account — don't retry with a different
      // account because the cause (bad request body, unexpected parse error)
      // will repeat.
      res.status(outcome.status).json({
        success: false,
        error: outcome.message,
        code: outcome.code,
      });
      return;
    }

    // kind === "retry" — loop around to the next account.
    logger.info(
      { accountId: account.id, reason: outcome.reason, attempts },
      "Retrying with a different account"
    );
  }

  res.status(503).json({
    success: false,
    error: "All available accounts are rate limited or unavailable",
    code: "ALL_ACCOUNTS_EXHAUSTED",
  });
}
