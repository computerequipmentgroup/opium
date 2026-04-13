# OCP Integration Plan

## Context

Opium's current proxy path (`server/src/services/proxy.ts` → `https://api.anthropic.com/v1/messages` with OAuth bearer tokens) is broken on Anthropic's side and cannot be fixed from here. OCP (`ocp/`) sidesteps the problem by spawning the `claude` CLI, which still works.

This plan ports OCP's CLI-spawning approach into Opium's server while preserving:
- Opium's multi-account pool and load balancing
- The Anthropic Messages API surface (`/v1/messages`)
- Cloud deployability (single Linux instance, 5–10 users)

Out of scope: horizontal scaling, Postgres migration, sticky routing, OpenAI-compatible surface.

## Design decisions

- **D1.** Keep the Anthropic Messages API surface. Bridge via `claude -p --output-format stream-json`. Fallback: `--output-format text` non-streaming if stream-json proves unstable.
- **D2.** Port OCP's spawn logic into TypeScript inside `server/src/services/`. No embedded Node subprocess.
- **D3.** Per-account credential isolation via per-account `HOME` directories. Linux deployment only (avoids macOS Keychain fallback concern).
- **D4.** Replace Opium's header-scraping usage sync with OCP's `/v1/oauth/usage` probe.

## Risks to resolve in Phase 0

1. `stream-json` format stability — undocumented; pin CLI version in the deployment image.
2. CLI headless operation in containers — confirm `claude -p` runs without a TTY.
3. Per-process spawn overhead — measure to size `CLAUDE_MAX_CONCURRENT`.

---

## Phase 0 — Verify prerequisites (read-only)

- [x] Confirm `claude -p --output-format stream-json --session-id <uuid>` exists on the target CLI version and emits usable NDJSON
- [x] Confirm `HOME` override isolates credentials (tested on macOS: empty HOME → "Not logged in" despite keychain having creds; confirmed even on macOS the `-p` path does not fall back to keychain)
- [x] Confirm usage endpoint still returns 5h/7d utilization — corrected URL: `https://api.anthropic.com/api/oauth/usage` (GET, `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`)
- [x] Quick benchmark: ~0.95s pure CLI startup, ~1.9s non-API overhead per request (acceptable for 5–10 users)
- [x] Decide on CLI version to pin: **2.1.104**

### Findings applied to later phases

- **stream-json → Anthropic SSE translation is trivial.** The CLI emits `{"type":"stream_event","event":{...}}` envelopes where the inner `event` IS the Anthropic streaming event (`message_start`, `content_block_delta` with `text_delta`, etc.). Translation = unwrap and re-emit as SSE.
- **Bonus signal:** `{"type":"rate_limit_event","rate_limit_info":{"status","resetsAt","rateLimitType","overageStatus"}}` is emitted inline. Gives reset timing per request without an extra probe. Does NOT include 0.0–1.0 utilization, so the oauth/usage probe is still needed for that.
- **System prompt trap:** default Claude Code system prompt is ~23k tokens. Must spawn with `--system-prompt <user's system>` (replaces default) instead of `--append-system-prompt` to avoid burning 23k cached tokens per request. Critical for Phase 3.
- **macOS keychain fallback is a non-issue in practice** for the `-p` code path — HOME override is honored. Plan no longer depends on Linux-only deployment for isolation correctness (still recommended for prod).
- **Not verified from macOS:** containerized headless run (low risk — OCP does this in prod) and a file-based credential write with a real token (will happen naturally in Phase 3).

**Approval gate:** review findings before proceeding. ✅ complete

---

## Phase 1 — Per-account credential materialization

- [x] New file: `server/src/services/claudeHome.ts`
- [x] `materializeAccountHome(accountId)`: decrypt via existing `getValidAccessToken`, write `<OPIUM_HOME_ROOT>/<id>/.claude/.credentials.json` in the shape OCP reads (`{claudeAiOauth: {accessToken, refreshToken, expiresAt, scopes}}`), return path
- [x] Per-account async lock to prevent concurrent writes during token refresh
- [x] Rewrite the credentials file on token refresh (via access-token mismatch in `writtenTokens` cache)
- [x] Config: `OPIUM_HOME_ROOT` env var, default `~/.opium/accounts`
- [x] Type-check clean (`tsc --noEmit`)

### Notes
- Atomic write via tmp + rename to avoid the CLI reading a half-written file.
- `writtenTokens` cache skips disk I/O when the access token hasn't changed since last materialization; a refresh naturally invalidates it because `getValidAccessToken` returns a new string.
- Modes: dir `0o700`, file `0o600`.
- Exported `invalidateAccountHome()` for external signals (Phase 3 will wire it when the CLI rejects the token mid-stream).

**Approval gate:** review before Phase 2. ✅ complete

---

## Phase 2 — CLI spawn layer

- [x] New file: `server/src/services/claudeCli.ts`
- [x] Port `buildCliArgs` (`ocp/server.mjs:276-306`) — uses `--output-format stream-json --verbose --include-partial-messages` instead of `text`
- [x] Port `spawnClaudeProcess` (`ocp/server.mjs:372-479`), parameterized with `env.HOME` via `buildChildEnv`
- [x] Port session map (in-memory, per-instance — fine for single instance); idle-expiry sweeper driven by `claudeSessionTtlMs`
- [x] Port `MAX_CONCURRENT` gate, timeout (SIGTERM → SIGKILL after 5s), process cleanup, `ANTHROPIC_*` env var stripping
- [x] Export: `runClaudeStream(opts, onEvent)` — errors surface via the `done` promise instead of a separate `onError` callback; abort handle returned
- [x] Config: `CLAUDE_BIN` (auto-detect), `CLAUDE_MAX_CONCURRENT` (default 8), `CLAUDE_TIMEOUT_MS`, `CLAUDE_SESSION_TTL_MS`
- [x] Type-check clean (`tsc --noEmit`)

### Notes
- System prompt split off in `flattenMessages` so it can be passed via `--system-prompt` (replaces the 23k-token Claude Code default per Phase 0 finding), not `--append-system-prompt`.
- Stream parser is line-buffered NDJSON; trailing partial line is flushed on `close`. Passes raw events through — Phase 3 does the SSE translation.
- Resume failures drop the stale session entry so the next call creates a fresh one.
- Truncation strategy differs from OCP's: simple head-truncation with a note, since Phase 3 will own its own flattening against the full Anthropic content-block shape anyway.

**Approval gate:** review before Phase 3. ✅ complete

---

## Phase 3 — Replace `forwardRequest` in `proxy.ts`

- [x] Rewrite `forwardRequest` to use the CLI path instead of `fetch(ANTHROPIC_API_BASE)` — new helper `forwardRequestViaCli`
- [x] Parse Anthropic Messages request body → extract `model`, `system`, `messages` (`adaptMessagesRequest`)
- [x] Flatten content blocks to prompt: string → as-is; arrays → concat text blocks, drop `thinking`/`redacted_thinking`
- [x] Reject unsupported blocks: `image`, `tool_use`, `tool_result` return 400 with `UNSUPPORTED_CONTENT`
- [x] Opt-in session resume via `x-opium-conversation-id` header (passed through to `runClaudeStream.conversationId`)
- [x] Map stream-json events → Anthropic SSE: unwrap `{type: "stream_event", event}` envelopes and re-emit each inner event as `event: <type>\ndata: <json>\n\n`
- [x] Non-streaming: accumulate the same event sequence into a Messages response object via `EventCollector` / `assembleMessageResponse`
- [x] Surface inline `rate_limit_event` as `markAccountRateLimited` with a reset-derived retry-after
- [x] On CLI auth failure (stderr matches auth patterns) → `invalidateAccountHome` + `markAccountRateLimited`, loop retries next account; rate-limit patterns handled the same way
- [x] Concurrency-gate throw → retry with a different account
- [x] Client disconnect → `handle.abort()` via `res.once("close", …)` so the CLI child is killed
- [x] Existing retry/account-selection loop preserved; only transport changed
- [x] Route surface narrowed: only `POST /v1/messages` flows through the CLI; other paths → 404/405
- [x] Type-check clean (`tsc --noEmit`)

### Notes
- Error classification lives in `classifyCliError` and is deliberately loose — the CLI's stderr wording isn't a stable contract, so patterns cover the common surfaces (`not logged in`, 401/403, `unauthorized`, `rate limit`, `quota`).
- If the CLI fails *after* SSE headers have been flushed we can't retry (client already got a 200), so we just `res.end()` and return `done`. Pre-header failures fall through to the retry loop.
- `updateAccountUsage` is still called on success with the existing values — it just bumps `updated_at` for now. Phase 4 replaces this with a real utilization signal from the oauth/usage probe.
- Bad request body → 400 with `INVALID_REQUEST` / `UNSUPPORTED_CONTENT`. These are client errors, so we don't spin through the retry loop.

**Approval gate:** end-to-end smoke test with one account before Phase 4.

---

## Phase 4 — Usage sync rewrite

- [x] Replace `syncAccountUsage` in `server/src/services/pool.ts`
- [x] Call `https://api.anthropic.com/api/oauth/usage` (GET) with `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` (note: corrected URL from the plan text — this is the endpoint that actually works, as validated in Phase 0)
- [x] Parse 5h/7d utilization (0-100 → divide by 100) and `resets_at` ISO strings from `five_hour` / `seven_day` buckets
- [x] Feed into existing `updateAccountUsage` (no changes to drain/load-score logic)
- [x] Preserve 429-on-probe fallback: mark account rate-limited with retry-after, bump utilization to 100%
- [x] Verify pool selection: smoke test hit `/api/v1/account/sync` → 5h=100%/7d=18% for the test account, `is_rate_limited=true`, pool excluded the member from available pool
- [x] Fix `updateAccountUsage` reset-time parse: it previously did `parseInt(reset) * 1000` (Unix-epoch ints from header path) and produced 1970 dates for the ISO strings returned by the probe — now handles both shapes
- [x] Type-check clean (`tsc --noEmit`)

### Notes
- The probe endpoint is ~free to call (no inference), so we can sync more often than the old path allowed without burning tokens. Existing cadence is left untouched.
- Removed the `SYNC_MODEL` / `ANTHROPIC_BETA_HEADER` / `ANTHROPIC_API_BASE` constants that only served the old header-scrape path.
- `updateAccountUsage` now tolerates both ISO timestamps and numeric-epoch strings in its reset fields — avoids a hard break if any legacy rows or third-party callers still feed the numeric form.

**Approval gate:** review before Phase 5. ✅ complete

---

## Phase 5 — Housekeeping & deployment

- [x] Startup health check: `checkClaudeCli()` in `server/src/index.ts` runs `claude --version` at boot, throws on failure, warns loudly if version drifts from the pinned `EXPECTED_CLAUDE_VERSION = 2.1.104`
- [x] Delete the old direct-API code path — verified via grep: no lingering `fetch(api.anthropic.com/v1/messages)` calls; old `forwardRequest`, `parseRateLimitHeaders`, `SYNC_MODEL`, `ANTHROPIC_API_BASE` constants all removed during Phase 3/4 rewrites
- [x] Dockerfile: install `@anthropic-ai/claude-code@2.1.104` in the production stage, set `CLAUDE_BIN=/usr/local/bin/claude` and `OPIUM_HOME_ROOT=/app/data/accounts`, version passed via `ARG CLAUDE_CLI_VERSION`
- [x] Volume mount: `opium-data` volume (already in compose) covers both `/app/data/opium.db` and `/app/data/accounts`, so materialized credentials survive restarts without new config
- [x] compose: added `CLAUDE_BIN`, `OPIUM_HOME_ROOT`, `CLAUDE_MAX_CONCURRENT`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_SESSION_TTL_MS` to the service's env
- [x] README update: new "Standalone Server Deployment" subsection covering CLI dependency, version pinning rationale, env var table, and a Docker quick-start
- [x] Type-check clean (`tsc --noEmit`); dev server auto-reloaded and reported the new CLI health check line

### Notes
- `EXPECTED_CLAUDE_VERSION` and the Dockerfile `ARG CLAUDE_CLI_VERSION` are intentionally duplicated — they should be bumped together, but keeping them in two places means a forgotten image rebuild can't silently ship an unpinned binary. The startup warning catches the mismatch.
- No separate volume for `OPIUM_HOME_ROOT` — it's a subdirectory of `/app/data`, which is already on the `opium-data` volume, so credentials and DB share a persistence boundary (they're semantically one unit anyway: losing one without the other wedges the pool).
- `ripgrep` is added to the image as a nudge for future CLI features that rely on it; cheap install and Claude Code itself wants it available.

**Approval gate:** review before Phase 6. ✅ complete

---

## Phase 6 — Testing

- [ ] Single account, non-streaming `/v1/messages`
- [ ] Single account, streaming `/v1/messages`
- [ ] Two accounts, parallel requests → verify HOME isolation (distinct credential files in use)
- [ ] Drain/pool selection works against the new usage probe
- [ ] Failure modes: CLI missing, token expired and unrefreshable, concurrency cap hit, CLI auth rejection mid-stream
- [ ] Tauri app unchanged — verify it still works against the new server

**Done when:** all checks pass, old code path removed, deployed image runs cleanly.
