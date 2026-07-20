# AGENTS.md

Notes for agents working in this repo. User-facing docs (install, config, provider/tool usage) live in [README.md](README.md) — don't duplicate that here.

## What this is

An `oh-my-pi` (`omp`) extension bridging to Claude Code via `@anthropic-ai/claude-agent-sdk`. Two entry points share the same plumbing:

- **Provider** (`createStreamClaudeAgentSdk` in `provider.ts`) — registers `claude-bridge` as an omp model provider.
- **AskClaude tool** (`promptAndWait` + `registerAskClaudeTool` in `askclaude.ts`) — a delegation tool available to other providers.

It's a fork of [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) (targets the `pi` agent), adapted to omp's extension API. Files/functions commented "Ported from pi-claude-bridge verbatim" should stay behaviorally identical to upstream unless omp's API forces a change — check upstream before diverging on those.

## File map

Entry point and orchestration:

- `index.ts` — thin entry: config load, `BridgeRuntime` construction, session lifecycle hooks, provider + tool registration. The provider is registered unconditionally on every extension load: oh-my-pi's `createAgentSession` clears each extension source's provider registrations before flushing the newly queued ones, so skipping re-registration (the old `ACTIVE_STREAM_SIMPLE_KEY` guard) stranded the shared ModelRegistry without claude-bridge when subagent sessions re-loaded the extension ("No API key for provider: claude-bridge", hit in ACP mode).
- `runtime.ts` — `BridgeRuntime`, the shared mutable state bag (provider settings, `SessionStore`, UI handle, cached system prompt) threaded into the two entry points. Replaces the module-level globals the pre-refactor `index.ts` had.
- `provider.ts` — the provider orchestration: fresh-query setup, tool-result delivery to waiting MCP handlers, abort handling, deferred-user-message replay. Owns the `activeQueryContexts` set (closure state per `createStreamClaudeAgentSdk` call).
- `askclaude.ts` — AskClaude tool: mode gating constants (`MODE_DISALLOWED_TOOLS`, `ASKCLAUDE_ALWAYS_BLOCKED`), `promptAndWait`, tool registration incl. TUI renderers.

Supporting modules (pure or near-pure, unit-tested in `test/`):

- `convert.ts` — pi message array → Anthropic API format; pi→SDK tool name mapping (`PI_TO_SDK_TOOL_NAME`, falls back to `pascalCase`); `<system-notice>` retagging.
- `tool-mapping.ts` — the reverse direction: SDK→pi tool names (`mapToolName`), arg key renames (`SDK_KEY_RENAMES`, `mapToolArgs`), reasoning→effort map.
- `session-store.ts` — `SessionStore` class: the shared CC session state + cursor-based sync (Cases 1–4, see gotchas). Wraps cc-session-io writes and post-write verification.
- `stream-processing.ts` — SDK stream events → pi `AssistantMessageEventStream` events: `processStreamEvent`, `processAssistantMessage` (non-streaming fallback), `consumeQuery`, usage accounting.
- `prompt.ts` — last-user-prompt extraction (`extractUserPrompt`/`extractUserPromptBlocks`), `TOOL_NAMING_CLARIFICATION`, system-prompt-append assembly.
- `mcp-bridge.ts` — `resolveMcpTools` (two-way name maps), `buildMcpServers` (handler queue plumbing), `contextForToolResults`.
- `models.ts` — hand-copied model catalog (from oh-my-pi's `models.json` anthropic entries at port time, zero import dependency on the catalog package) plus 1M-context eligibility logic.
- `config.ts` — `Config` type + loader for `~/.omp/agent/claude-bridge.json` / `.omp/claude-bridge.json`.
- `agents-md.ts` — finds and sanitizes AGENTS.md for forwarding to Claude Code as `CLAUDE.md`.
- `skills.ts` — extracts the `<available_skills>` block from omp's system prompt for forwarding; MCP naming constants.
- `query-state.ts` — `QueryContext`, the per-query mutable state container, plus a stack for isolated/nested queries.
- `extract-tool-results.ts` — walks context tail to collect a turn's tool results as MCP content blocks.
- `typebox-to-zod.ts` — converts TypeBox/JSON-Schema tool params to Zod (Claude Agent SDK's MCP server wants Zod shapes).
- `session-verify.ts` — post-write sanity check on the JSONL session file.
- `askclaude-ui.ts` — status-line/action-summary rendering for the AskClaude tool's TUI output.
- `debug.ts` — `CLAUDE_BRIDGE_DEBUG` logging, diag dumps, CC CLI debug-file plumbing.

No build step (plain `.ts`, loaded directly by omp/Bun).

## Testing

`bun test` runs the unit suite in `test/` (one file per supporting module). Tests pin the observable behavior of each module — message conversion output, session sync cases against a temp `CLAUDE_CONFIG_DIR`, emitted pi event sequences from a fake stream sink — not internal call sequences. `provider.ts`/`askclaude.ts` orchestration is intentionally untested (would require faking the Claude Agent SDK subprocess); verify those by running the extension.

Run `bun run typecheck` (plain `tsc --noEmit`) and `bun test` before committing — there's no CI for this yet.

## Running / debugging

```sh
omp -e /path/to/omp-claude-bridge/index.ts
```

Set `CLAUDE_BRIDGE_DEBUG=1` for a play-by-play in `~/.omp/agent/claude-bridge.log` (every provider call, session-sync case taken, tool result delivery, CC stderr) and `~/.omp/agent/claude-bridge-diag.log` for structured dumps. When touching session sync or stream processing, this log is the fastest way to confirm which code path actually ran.

## Findings / gotchas

- **Session sync is cursor-based, not full-replay.** `SessionStore.sync` (session-store.ts) diffs the incoming message array against the cached cursor and picks one of four paths logged as `Case 1`–`Case 4`: clean start, reuse-as-is, rebuild-preserving-id, or rebuild-with-rotated-id (post-abort, to avoid racing an orphaned writer for the old session id). If you change message-array shape assumptions here, all four cases need re-checking, not just the common one — `test/session-store.test.ts` covers each.
- **Tool name/arg translation is two-way and asymmetric.** pi→SDK uses `PI_TO_SDK_TOOL_NAME` + `pascalCase` fallback (convert.ts); SDK→pi uses a separate `SDK_TO_PI_TOOL_NAME` map + custom-tool map + `MCP_TOOL_PREFIX` stripping (`mapToolName` in tool-mapping.ts). Built-in tool arg keys also get renamed both ways (`SDK_KEY_RENAMES`): Claude's `file_path`/`old_string`/`new_string` vs omp's `path`/`oldText`/`newText`.
- **Bash gets an injected 120s timeout** (`mapToolArgs` in tool-mapping.ts) when the SDK doesn't send one, matching Claude Code's own default — omp's bash tool has no default timeout, so without this the two disagree.
- **Custom/omp tools are exposed to Claude Code as MCP tools** named `mcp__custom-tools__<name>` (`MCP_SERVER_NAME`/`MCP_TOOL_PREFIX` in skills.ts), built via `buildMcpServers` (mcp-bridge.ts) using the TypeBox→Zod conversion. `TOOL_NAMING_CLARIFICATION` (prompt.ts) exists specifically because Claude Code otherwise gets confused about whether `mcp__custom-tools__read` etc. are "real" tools distinct from its built-ins — it's injected into the system prompt for this reason.
- **AskClaude tool mode gating** (`MODE_DISALLOWED_TOOLS` in askclaude.ts) blocks write/bash/etc. tools per mode (`full`/`read`/`none`); `ASKCLAUDE_ALWAYS_BLOCKED` unconditionally blocks plan-mode/interactive-only tools (`AskUserQuestion`, `EnterPlanMode`, etc.) since AskClaude runs headless with no way to surface those to the omp user.
- **AGENTS.md forwarding sanitizes omp-specific references** before handing it to Claude as `CLAUDE.md` (`agents-md.ts`): `~/.omp` → `~/.claude`, `.omp/` → `.claude/`, and the bare word `omp` → `environment`. If a project's AGENTS.md talks about "omp" as a concept (not the CLI), it'll get mangled by that last blanket rewrite — that's a known rough edge, not a bug to silently "fix" without checking upstream intent.
- **1M-context eligibility is measured, not derived from the catalog.** `resolveClaudeCodeRuntimeModel` (models.ts) hardcodes which models actually serve 1M context under which plan, because the SDK's real behavior doesn't match models.json's advertised `contextWindow` (e.g. bare Opus 4.7 serves 1M, bare Opus 4.8 doesn't). Don't "reconcile" this function against the catalog — the catalog is the thing that's wrong for this purpose; `test/models.test.ts` pins the measured table.
- **`QueryContext` + the context stack** (`query-state.ts`) exist so a nested/isolated AskClaude call (or plan-mode sub-query) doesn't clobber the outer provider stream's in-flight state — `pushContext`/`popContext` swap the active context rather than mutating it in place.
- **omp sends a `developer` message role alongside `user`.** pi-ai's published `Message` role union omits it, but role checks in `convert.ts`/`prompt.ts`/`provider.ts` (extracting the last user prompt, tool results, streaming trigger conditions) accept `"developer"` too — grep for `"developer"` if similar role-comparison bugs show up elsewhere.
- **oh-my-pi's steered `<system-notice>`/`<system-interrupt>` framework notices get retagged to `<system-reminder>` for Claude.** These are hidden messages oh-my-pi "steers" into the live conversation (xd:// mount deltas, thinking-loop redirects, etc.) that arrive here flattened to plain `user`-role text — oh-my-pi's own tag names carry no special weight in Claude's training, so Claude (correctly) can't structurally distinguish a genuine one from an attacker forging the same text, even with an in-band "this is not a prompt injection" disclaimer. `SYSTEM_NOTICE_TAG_RE` (convert.ts, applied in `convertPiMessages`) rewrites both tags to `<system-reminder>`, a convention Claude Code models are actually trained to trust as framework-injected. If oh-my-pi adds new steered-notice tag names, extend the regex.
