# omp-claude-bridge

An [oh-my-pi](https://github.com/earendil-works/oh-my-pi) (`omp`) extension that integrates Claude Code via the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

1. **Provider** — use Opus/Sonnet/Haiku as models in `omp`, with all tool calls flowing through omp's TUI, billed against your Claude Pro/Max subscription instead of API credits
2. **AskClaude tool** — delegate tasks or questions to Claude Code when using another provider

> **FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how tools built on the Agent SDK (like this one) would be billed. As of June 15, 2026 it uses subscription quota just like Claude Code direct does.

## Attribution

This is a port of [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) by [Eli Dickinson](https://github.com/elidickinson), which targets the [`pi`](https://pi.dev) coding agent. This fork adapts it to `oh-my-pi`'s extension API, event names, and config paths.

The initial port was performed by an AI coding agent (Deepseek V4 Pro), driven by a human maintainer reviewing and directing the work. If something looks off, that's likely why — issues and corrections are welcome.

## Install

Clone (or copy) this repo into omp's extensions directory and install dependencies:

```sh
git clone https://github.com/barisdemirdelen/omp-claude-bridge.git ~/.omp/agent/extensions/claude-bridge
cd ~/.omp/agent/extensions/claude-bridge
npm install
```

`omp` auto-discovers extensions under `~/.omp/agent/extensions/`. Alternatively, load it explicitly for a single run:

```sh
omp -e /path/to/claude-bridge/index.ts
```

## Provider

Use `/model` to select `claude-bridge/claude-fable-5`, `claude-bridge/claude-opus-4-8`, `claude-bridge/claude-opus-4-7`, `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-5`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, omp's tools are bridged to Claude Code but it should all work like normal in omp. Bash commands get a 120-second default timeout (matching Claude Code's default) since omp's bash has no timeout by default. Skills in omp are copied over to Claude Code's system prompt so should work as they would with any other omp provider.

**1M Context:** Opus 4.7 and Opus 4.8 get 1M context by default. Opus 4.6 only gets 1M if you're on a Max plan or pay for Extra Usage. Sonnet 4.6 only gets 1M if you pay for Extra Usage. You will need to set `provider.plan` and/or `provider.longContextExtraUsage` for 1M context in Opus 4.6/Sonnet 4.6 as described in [Configuration](#configuration).

## AskClaude Tool

Available when using any non-claude-bridge provider. omp's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to `AGENTS.md` to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.omp/agent/claude-bridge.json` (global) or the project's `.omp/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `true`)
- `name` — override the tool's omp-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward omp's skills block into the system prompt (default `true`)

`provider`:
- `plan` (default `"pro"`) — set to `"max"` for Max (or Team Premium/Enterprise) to enable Opus 4.6 with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M models that cost money through Extra Usage. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `appendSystemPrompt` — append omp's AGENTS.md and skills (default `true`)
- `settingSources` — CC filesystem settings to load; only applied when `appendSystemPrompt: false`
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.omp/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Diagnostics log** at `~/.omp/agent/claude-bridge-diag.log` — structured dumps for deeper debugging.

## License

MIT — see [LICENSE](LICENSE). Portions ported from [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), also MIT licensed.
