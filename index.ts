// oh-my-pi claude-bridge extension.
// Ported from pi-claude-bridge. Uses @earendil-works/* import paths
// (oh-my-pi's compat shim rewrites them at load time).

import {
  calculateCost,
  StringEnum,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createSdkMcpServer,
  query,
  type EffortLevel,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  createSession,
  deleteSession,
  repairToolPairing,
} from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import {
  PROVIDER_ID,
  messageContentToText,
  convertPiMessages,
} from "./convert.js";
import {
  MODELS,
  applyLongContext,
  claudeCodeModelId,
  resolveModel as _resolveModel,
  type LongContextSettings,
} from "./models.js";
import {
  MCP_SERVER_NAME,
  MCP_TOOL_PREFIX,
  extractSkillsBlock,
} from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import {
  extractAllToolResults as _extractAllToolResults,
  type McpResult,
} from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { loadConfig, type Config } from "./config.js";
import { extractAgentsAppend } from "./agents-md.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import {
  buildActionSummary,
  type ToolCallState,
} from "./askclaude-ui.js";

// Compat: use factory if available, else fall back to constructor
const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
  typeof _piAi.createAssistantMessageEventStream === "function"
    ? _piAi.createAssistantMessageEventStream
    : () => new _piAi.AssistantMessageEventStream();

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.omp/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH =
  process.env.CLAUDE_BRIDGE_DEBUG_PATH ||
  join(homedir(), ".omp", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "claude-bridge-diag.log",
);

if (DEBUG) {
  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
  } catch {
    // If directory creation fails, debug functions will throw on first use
  }
}

const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error)
      return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
    return JSON.stringify(a);
  };
  const msg = args.map(fmt).join(" ");
  appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

let nextCliDebugSeq = 1;
function makeCliDebugOptions(
  tag: string,
): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
  if (!DEBUG) return {};
  const seq = nextCliDebugSeq++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
  debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
  return {
    debug: true,
    debugFile,
    stderr: (data: string) => {
      for (const line of data.split(/\r?\n/)) {
        if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
      }
    },
  };
}

function diagDump(label: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const entry = { ts, moduleInstanceId, label, ...data };
  appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
  debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for(
  "claude-bridge:activeStreamSimple",
);

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
};

const TOOL_NAMING_CLARIFICATION =
  "Your Read, Write, Edit, Bash, Grep, and Glob tools (and all other tools) are exposed as MCP functions with an `mcp__custom-tools__` prefix (e.g. `mcp__custom-tools__edit` IS your Edit tool, `mcp__custom-tools__bash` IS your Bash tool). There is no separate built-in tool alongside them — always call the `mcp__custom-tools__*` function from your tool list.";

let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = {
  plan: "pro",
  longContextExtraUsage: false,
};

function resolveModel(input: string) {
  return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {}
  }
  return String(err);
}

const ASKCLAUDE_ALWAYS_BLOCKED = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
  "ScheduleWakeup",
];
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
  full: [...ASKCLAUDE_ALWAYS_BLOCKED],
  read: [
    ...ASKCLAUDE_ALWAYS_BLOCKED,
    "Write",
    "Edit",
    "Bash",
    "NotebookEdit",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "TeamCreate",
    "TeamDelete",
  ],
  none: [
    ...ASKCLAUDE_ALWAYS_BLOCKED,
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "Agent",
    "NotebookEdit",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "TeamCreate",
    "TeamDelete",
    "WebFetch",
    "WebSearch",
  ],
};

// --- Session persistence ---

interface SessionState {
  sessionId: string;
  cursor: number;
  cwd: string;
  needsRebuild?: boolean;
  forceRotate?: boolean;
}

let sharedSession: SessionState | null = null;

function convertAndImportMessages(
  session: ReturnType<typeof createSession>,
  messages: Context["messages"],
  customToolNameToSdk?: Map<string, string>,
): void {
  const { anthropicMessages, sanitizedIds } = convertPiMessages(
    messages,
    customToolNameToSdk,
  );

  debug(
    `convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`,
  );
  debug(
    `convertAndImportMessages: imported roles:`,
    anthropicMessages
      .map((m, i) => {
        const c = m.content;
        if (typeof c === "string") return `[${i}]${m.role}:text`;
        if (Array.isArray(c))
          return `[${i}]${m.role}:${c.map((b: any) => b.type).join("+")}`;
        return `[${i}]${m.role}:?`;
      })
      .join(" "),
  );
  if (sanitizedIds.size > 0) {
    debug(
      `convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds.entries()]
        .map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`))
        .join(", "),
    );
  }
  const repaired = repairToolPairing(anthropicMessages);
  if (repaired.length !== anthropicMessages.length) {
    debug(
      `convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`,
    );
  }
  if (repaired.length) session.importMessages(repaired);
}

function extractAllToolResults(context: Context): McpResult[] {
  const { results, stopIdx } = _extractAllToolResults(
    context.messages as unknown as Array<{
      role: string;
      [key: string]: unknown;
    }>,
  );
  debug(
    `extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`,
  );
  debug(
    `extractAllToolResults: all msg roles:`,
    context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
  );
  for (let r = 0; r < results.length; r++) {
    debug(
      `extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`,
      JSON.stringify(results[r].content).slice(0, 150),
    );
  }
  return results;
}

function extractUserPrompt(messages: Context["messages"]): string | null {
  const last = messages[messages.length - 1];
  // pi-ai's published Message role union omits "developer", which oh-my-pi's
  // runtime does send; role is a plain string at runtime regardless.
  const lastRole = last?.role as string | undefined;
  if (!last || (lastRole !== "user" && lastRole !== "developer")) return null;
  if (typeof last.content === "string") return last.content;
  return messageContentToText(last.content) || "";
}

function extractUserPromptBlocks(
  messages: Context["messages"],
): ContentBlockParam[] | null {
  const last = messages[messages.length - 1];
  const lastRole = last?.role as string | undefined;
  if (!last || (lastRole !== "user" && lastRole !== "developer")) return null;
  if (typeof last.content === "string") {
    debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
    return null;
  }
  if (!Array.isArray(last.content)) {
    debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
    return null;
  }
  debug(
    `extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b: any) => b.type).join(",")}`,
  );
  let hasImage = false;
  const blocks: ContentBlockParam[] = [];
  for (const block of last.content) {
    if (block.type === "text" && block.text) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      debug(
        `image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`,
      );
      if (!(block as any).data || !(block as any).mimeType) {
        debug(`image block missing data or mimeType, skipping`);
        continue;
      }
      hasImage = true;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType as Base64ImageSource["media_type"],
          data: block.data,
        },
      });
    }
  }
  return hasImage ? blocks : null;
}

async function* wrapPromptStream(
  blocks: ContentBlockParam[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: blocks } as MessageParam,
    parent_tool_use_id: null,
  };
}


function verifyWrittenSession(
  jsonlPath: string,
  expectedSessionId: string,
  expectedRecordCount: number,
  cwd: string,
): void {
  const warnings = _verifyWrittenSession(
    jsonlPath,
    expectedSessionId,
    expectedRecordCount,
  );
  for (const msg of warnings) {
    debug(`WARNING session verify: ${msg}`);
    piUI?.notify(
      `Session file issue: ${msg}\n` +
        `cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
        `Please copy and paste this message into a new issue.` +
        (DEBUG
          ? ` and attach ${DEBUG_LOG_PATH}`
          : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
      "warning",
    );
    diagDump("session_verify_fail", {
      msg,
      jsonlPath,
      cwd,
      realpath: safeRealpath(cwd),
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    });
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    return `<failed: ${(e as Error).message}>`;
  }
}

function debugSessionPaths(
  label: string,
  cwd: string,
  jsonlPath: string,
): void {
  const realCwd = safeRealpath(cwd);
  let fileSize: number | null = null;
  let fileExists = false;
  try {
    const st = statSync(jsonlPath);
    fileExists = true;
    fileSize = st.size;
  } catch {
    /* file may not exist yet */
  }
  debug(`${label}: cwd=${cwd}`);
  if (realCwd !== cwd)
    debug(
      `${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`,
    );
  debug(`${label}: jsonlPath=${jsonlPath}`);
  debug(
    `${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`,
  );
  debug(
    `${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`,
  );
}

function syncSharedSession(
  messages: Context["messages"],
  cwd: string,
  customToolNameToSdk?: Map<string, string>,
  modelId?: string,
): { sessionId: string | null; preserveSharedSession?: boolean } {
  const priorMessages = messages.slice(0, -1);

  // REUSE path
  if (
    sharedSession &&
    !sharedSession.needsRebuild &&
    priorMessages.length >= sharedSession.cursor
  ) {
    const missed = priorMessages.slice(sharedSession.cursor);
    const trailingAssistantOnly =
      missed.length === 1 &&
      (missed[0] as { role?: string }).role === "assistant";
    if (missed.length === 0 || trailingAssistantOnly) {
      if (trailingAssistantOnly) {
        sharedSession = {
          ...sharedSession,
          cursor: priorMessages.length,
          cwd,
        };
      }
      debug(
        `Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`,
      );
      debug(
        `syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`,
      );
      return { sessionId: sharedSession.sessionId };
    }
  }

  if (
    sharedSession &&
    !sharedSession.needsRebuild &&
    priorMessages.length < sharedSession.cursor
  ) {
    debug(
      `Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`,
    );
    debug(
      `syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`,
    );
    return { sessionId: null, preserveSharedSession: true };
  }

  // REBUILD path
  if (priorMessages.length === 0) {
    debug(`Case 1: clean start, ${messages.length} total messages`);
    debug(`syncResult: path=clean-start`);
    return { sessionId: null };
  }

  const previousSessionId = sharedSession?.sessionId;
  const previousCursor = sharedSession?.cursor ?? 0;
  const preserveId =
    previousSessionId !== undefined && !sharedSession?.forceRotate;
  if (preserveId) {
    deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
  }
  const session = createSession({
    projectPath: cwd,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    ...(preserveId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  });
  convertAndImportMessages(session, priorMessages, customToolNameToSdk);
  session.save();
  verifyWrittenSession(
    session.jsonlPath,
    session.sessionId,
    session.messages.length,
    cwd,
  );
  sharedSession = {
    sessionId: session.sessionId,
    cursor: priorMessages.length,
    cwd,
  };
  if (previousSessionId === undefined) {
    debug(
      `Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`,
    );
  } else if (preserveId) {
    const missedCount = priorMessages.length - previousCursor;
    debug(
      `Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`,
    );
  } else {
    debug(
      `Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`,
    );
  }
  debugSessionPaths(
    `${session.sessionId.slice(0, 8)}`,
    cwd,
    session.jsonlPath,
  );
  debug(
    `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
  );
  return { sessionId: session.sessionId };
}

// --- Tool name mapping ---

function mapToolName(
  name: string,
  customToolNameToPi?: Map<string, string>,
): string {
  const normalized = name.toLowerCase();
  const builtin = SDK_TO_PI_TOOL_NAME[normalized];
  if (builtin) return builtin;
  if (customToolNameToPi) {
    const mapped =
      customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
    if (mapped) return mapped;
  }
  if (normalized.startsWith(MCP_TOOL_PREFIX))
    return name.slice(MCP_TOOL_PREFIX.length);
  return name;
}

const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: {
    file_path: "path",
    old_string: "oldText",
    new_string: "newText",
    old_text: "oldText",
    new_text: "newText",
  },
};

function mapToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const input = args ?? {};
  const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key;
    if (!(piKey in result)) result[piKey] = value;
  }
  if (toolName.toLowerCase() === "bash" && result.timeout == null) {
    result.timeout = 120;
  }
  return result;
}

// --- Query state (global) ---

let piUI: ExtensionUIContext | null = null;
const activeQueryContexts = new Set<QueryContext>();

function contextForToolResults(
  results: McpResult[],
): QueryContext | undefined {
  for (const result of results) {
    const id = result.toolCallId;
    if (!id) continue;
    for (const queryCtx of activeQueryContexts) {
      if (
        queryCtx.pendingToolCalls.has(id) ||
        queryCtx.pendingResults.has(id) ||
        queryCtx.turnToolCallIds.includes(id)
      ) {
        return queryCtx;
      }
    }
  }
  return undefined;
}

function resolveMcpTools(
  context: Context,
  excludeToolName?: string,
): {
  mcpTools: Tool[];
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
} {
  const mcpTools: Tool[] = [];
  const customToolNameToSdk = new Map<string, string>();
  const customToolNameToPi = new Map<string, string>();

  if (!context.tools)
    return { mcpTools, customToolNameToSdk, customToolNameToPi };

  // omp's own MCP tool flattening already prefixes external MCP tools as
  // `mcp__<server>_<tool>`. Re-wrapping that verbatim as an inner tool name of
  // our own `custom-tools` MCP server would double the `mcp__` prefix on the
  // wire (`mcp__custom-tools__mcp__<server>_<tool>`), so strip one layer here.
  for (const tool of context.tools) {
    if (tool.name === excludeToolName) continue;
    const wireName = tool.name.startsWith("mcp__")
      ? tool.name.slice("mcp__".length)
      : tool.name;
    const sdkName = `${MCP_TOOL_PREFIX}${wireName}`;
    mcpTools.push(tool);
    customToolNameToSdk.set(tool.name, sdkName);
    customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
    customToolNameToPi.set(sdkName, tool.name);
    customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
  }

  return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

function buildMcpServers(
  tools: Tool[],
  queryCtx: QueryContext,
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (!tools.length) return undefined;
  const mcpTools = tools.map((tool) => ({
    name: tool.name.startsWith("mcp__")
      ? tool.name.slice("mcp__".length)
      : tool.name,
    description: tool.description,
    inputSchema: jsonSchemaToZodShape(tool.parameters),
    handler: async () => {
      const toolCallId =
        queryCtx.turnToolCallIds[queryCtx.nextHandlerIdx++];
      if (!toolCallId)
        debug(
          `WARNING: mcp handler ${tool.name} has no toolCallId (idx=${queryCtx.nextHandlerIdx - 1}, available=${queryCtx.turnToolCallIds.length})`,
        );
      if (toolCallId && queryCtx.pendingResults.has(toolCallId)) {
        const result = queryCtx.pendingResults.get(toolCallId)!;
        queryCtx.pendingResults.delete(toolCallId);
        debug(
          `mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`,
        );
        return result;
      }
      debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
      return new Promise<McpResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, {
          toolName: tool.name,
          resolve,
        });
      });
    },
  }));
  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: mcpTools,
  });
  return { [MCP_SERVER_NAME]: server };
}

// --- Usage helpers ---

function updateUsage(
  output: AssistantMessage,
  usage: Record<string, number | undefined>,
  model: Model<any>,
): void {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null)
    output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null)
    output.usage.cacheWrite = usage.cache_creation_input_tokens;
  const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
  if (reasoning != null)
    (output.usage as typeof output.usage & { reasoning?: number }).reasoning =
      reasoning;
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite;
  calculateCost(model, output.usage);
  const promptTokens =
    output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
  const cachePct =
    promptTokens > 0
      ? Math.round((output.usage.cacheRead / promptTokens) * 100)
      : 0;
  const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
  debug(
    `usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`,
  );
}

function logServedContextWindow(
  label: string,
  message: SDKMessage,
  model: Model<any>,
): void {
  const modelUsage = (message as any).modelUsage as
    | Record<string, { contextWindow?: number; maxOutputTokens?: number }>
    | undefined;
  if (!modelUsage) return;
  for (const [k, v] of Object.entries(modelUsage)) {
    debug(
      `${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`,
    );
  }
}

// --- Effort level mapping ---

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// --- Stream helpers ---

function mapStopReason(
  reason: string | undefined,
): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    default:
      return "stop";
  }
}

function parsePartialJson(
  input: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!input) return fallback;
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
  if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(
  stream: AssistantMessageEventStream,
  label: string,
  c: QueryContext,
): void {
  if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
    debug(
      `WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`,
    );
  }
  c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
  if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
    c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
    c.turnStarted = true;
  }
}

function finalizeCurrentStream(
  c: QueryContext,
  stopReason?: string,
): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  debug(
    `provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({ stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage })}`,
  );
  if (!c.turnStarted) ensureTurnStarted(c);
  const reason = stopReason === "length" ? "length" : "stop";
  const stream = c.currentPiStream;
  stream!.push({ type: "done", reason, message: c.turnOutput });
  markStreamComplete(stream);
  stream!.end();
  c.currentPiStream = null;
}

function processStreamEvent(
  message: SDKMessage,
  customToolNameToPi: Map<string, string>,
  model: Model<any>,
  c: QueryContext,
): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  c.turnSawStreamEvent = true;
  const event = (message as SDKMessage & { event: any }).event;

  if (event?.type === "message_start") {
    c.turnToolCallIds = [];
    c.nextHandlerIdx = 0;
    if (event.message?.usage)
      updateUsage(c.turnOutput, event.message.usage, model);
    return;
  }

  if (event?.type === "content_block_start") {
    ensureTurnStarted(c);
    if (event.content_block?.type === "text") {
      c.turnBlocks.push({ type: "text", text: "", index: event.index });
      c.currentPiStream!.push({
        type: "text_start",
        contentIndex: c.turnBlocks.length - 1,
        partial: c.turnOutput,
      });
    } else if (event.content_block?.type === "thinking") {
      c.turnBlocks.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: "",
        index: event.index,
      });
      c.currentPiStream!.push({
        type: "thinking_start",
        contentIndex: c.turnBlocks.length - 1,
        partial: c.turnOutput,
      });
    } else if (event.content_block?.type === "tool_use") {
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(event.content_block.id);
      c.turnBlocks.push({
        type: "toolCall",
        id: event.content_block.id,
        name: mapToolName(event.content_block.name, customToolNameToPi),
        arguments: (event.content_block.input as Record<string, unknown>) ?? {},
        partialJson: "",
        index: event.index,
      });
      c.currentPiStream!.push({
        type: "toolcall_start",
        contentIndex: c.turnBlocks.length - 1,
        partial: c.turnOutput,
      });
    } else {
      debug(
        "processStreamEvent: unhandled content_block_start type",
        event.content_block?.type,
      );
    }
    return;
  }

  if (event?.type === "content_block_delta") {
    const index = c.turnBlocks.findIndex(
      (b: any) => b.index === event.index,
    );
    const block = c.turnBlocks[index];
    if (!block) return;
    if (event.delta?.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      c.currentPiStream!.push({
        type: "text_delta",
        contentIndex: index,
        delta: event.delta.text,
        partial: c.turnOutput,
      });
    } else if (
      event.delta?.type === "thinking_delta" &&
      block.type === "thinking"
    ) {
      block.thinking += event.delta.thinking;
      c.currentPiStream!.push({
        type: "thinking_delta",
        contentIndex: index,
        delta: event.delta.thinking,
        partial: c.turnOutput,
      });
    } else if (
      event.delta?.type === "input_json_delta" &&
      block.type === "toolCall"
    ) {
      block.partialJson += event.delta.partial_json;
      block.arguments = parsePartialJson(block.partialJson, block.arguments);
      c.currentPiStream!.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: event.delta.partial_json,
        partial: c.turnOutput,
      });
    } else if (
      event.delta?.type === "signature_delta" &&
      block.type === "thinking"
    ) {
      block.thinkingSignature =
        (block.thinkingSignature ?? "") + event.delta.signature;
    } else {
      debug(
        "processStreamEvent: unhandled content_block_delta type",
        event.delta?.type,
      );
    }
    return;
  }

  if (event?.type === "content_block_stop") {
    const index = c.turnBlocks.findIndex(
      (b: any) => b.index === event.index,
    );
    const block = c.turnBlocks[index];
    if (!block) return;
    delete block.index;
    if (block.type === "text") {
      c.currentPiStream!.push({
        type: "text_end",
        contentIndex: index,
        content: block.text,
        partial: c.turnOutput,
      });
    } else if (block.type === "thinking") {
      c.currentPiStream!.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: c.turnOutput,
      });
    } else if (block.type === "toolCall") {
      c.turnSawToolCall = true;
      block.arguments = mapToolArgs(
        block.name,
        parsePartialJson(block.partialJson, block.arguments),
      );
      delete block.partialJson;
      c.currentPiStream!.push({
        type: "toolcall_end",
        contentIndex: index,
        toolCall: block,
        partial: c.turnOutput,
      });
    }
    return;
  }

  if (event?.type === "message_delta") {
    c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
    if (event.usage) updateUsage(c.turnOutput, event.usage, model);
    return;
  }

  if (event?.type === "message_stop" && c.turnSawToolCall) {
    c.turnOutput.stopReason = "toolUse";
    const stream = c.currentPiStream;
    stream!.push({
      type: "done",
      reason: "toolUse",
      message: c.turnOutput,
    });
    markStreamComplete(stream);
    stream!.end();
    c.currentPiStream = null;
    return;
  }

  if (event?.type !== "message_stop" && event?.type !== "ping") {
    debug("processStreamEvent: unhandled event type", event?.type);
  }
}

function processAssistantMessage(
  message: SDKMessage,
  model: Model<any>,
  customToolNameToPi: Map<string, string>,
  c: QueryContext,
): void {
  if (c.turnSawStreamEvent) return;
  const assistantMsg = (message as any).message;
  if (!assistantMsg?.content) return;
  c.turnToolCallIds = [];
  c.nextHandlerIdx = 0;
  debug(
    `processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`,
  );
  for (const block of assistantMsg.content) {
    if (block.type === "text" && block.text) {
      ensureTurnStarted(c);
      c.turnBlocks.push({ type: "text", text: block.text });
      const idx = c.turnBlocks.length - 1;
      c.currentPiStream?.push({
        type: "text_start",
        contentIndex: idx,
        partial: c.turnOutput,
      });
      c.currentPiStream?.push({
        type: "text_delta",
        contentIndex: idx,
        delta: block.text,
        partial: c.turnOutput,
      });
      c.currentPiStream?.push({
        type: "text_end",
        contentIndex: idx,
        content: block.text,
        partial: c.turnOutput,
      });
    } else if (block.type === "thinking") {
      ensureTurnStarted(c);
      c.turnBlocks.push({
        type: "thinking",
        thinking: block.thinking ?? "",
        thinkingSignature: block.signature ?? "",
      });
      const idx = c.turnBlocks.length - 1;
      c.currentPiStream?.push({
        type: "thinking_start",
        contentIndex: idx,
        partial: c.turnOutput,
      });
      if (block.thinking)
        c.currentPiStream?.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: block.thinking,
          partial: c.turnOutput,
        });
      c.currentPiStream?.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.thinking ?? "",
        partial: c.turnOutput,
      });
    } else if (block.type === "tool_use") {
      ensureTurnStarted(c);
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(block.id);
      const mappedArgs = mapToolArgs(
        mapToolName(block.name, customToolNameToPi),
        block.input,
      );
      c.turnBlocks.push({
        type: "toolCall",
        id: block.id,
        name: mapToolName(block.name, customToolNameToPi),
        arguments: mappedArgs,
      });
      const idx = c.turnBlocks.length - 1;
      const toolBlock = c.turnBlocks[idx];
      c.currentPiStream?.push({
        type: "toolcall_start",
        contentIndex: idx,
        partial: c.turnOutput,
      });
      c.currentPiStream?.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall: toolBlock as any,
        partial: c.turnOutput,
      });
    } else {
      debug("processAssistantMessage: unhandled block type", block.type);
    }
  }
  if (assistantMsg.usage && c.turnOutput)
    updateUsage(c.turnOutput, assistantMsg.usage, model);

  if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
    c.turnOutput.stopReason = "toolUse";
    const stream = c.currentPiStream;
    stream.push({
      type: "done",
      reason: "toolUse",
      message: c.turnOutput,
    });
    markStreamComplete(stream);
    stream.end();
    c.currentPiStream = null;
  }
}

async function consumeQuery(
  sdkQuery: ReturnType<typeof query>,
  customToolNameToPi: Map<string, string>,
  model: Model<any>,
  wasAborted: () => boolean,
  queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
  let capturedSessionId: string | undefined;

  for await (const message of sdkQuery) {
    if (wasAborted()) break;
    if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

    switch (message.type) {
      case "stream_event":
        processStreamEvent(message, customToolNameToPi, model, queryCtx);
        break;
      case "assistant":
        processAssistantMessage(
          message,
          model,
          customToolNameToPi,
          queryCtx,
        );
        break;
      case "result":
        logServedContextWindow("result", message, model);
        if (!queryCtx.turnSawStreamEvent && message.subtype === "success") {
          ensureTurnStarted(queryCtx);
          const text = message.result || "";
          queryCtx.turnBlocks.push({ type: "text", text });
          const idx = queryCtx.turnBlocks.length - 1;
          queryCtx.currentPiStream?.push({
            type: "text_start",
            contentIndex: idx,
            partial: queryCtx.turnOutput,
          });
          queryCtx.currentPiStream?.push({
            type: "text_delta",
            contentIndex: idx,
            delta: text,
            partial: queryCtx.turnOutput,
          });
          queryCtx.currentPiStream?.push({
            type: "text_end",
            contentIndex: idx,
            content: text,
            partial: queryCtx.turnOutput,
          });
        }
        break;
      case "system":
        if (
          (message as any).subtype === "init" &&
          (message as any).session_id
        ) {
          capturedSessionId = (message as any).session_id;
        }
        break;
      case "user":
        break;
      case "rate_limit_event": {
        const info = (message as any).rate_limit_info;
        debug(
          "consumeQuery: rate_limit_event",
          JSON.stringify(info).slice(0, 300),
        );
        if (info?.status === "rejected") {
          const resetsAt = info.resetsAt
            ? new Date(info.resetsAt).toLocaleTimeString()
            : "unknown";
          piUI?.notify(
            `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`,
            "warning",
          );
        } else if (info?.status === "allowed_warning") {
          piUI?.notify(
            `Claude rate limit warning: ${Math.round(info.utilization ?? 0)}% used (${info.rateLimitType ?? ""})`,
            "warning",
          );
        }
        break;
      }
      default:
        debug("consumeQuery: unhandled SDK message type", message.type);
        break;
    }
  }

  debug(
    `consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`,
  );

  return { capturedSessionId };
}

// --- Main provider function ---

function streamClaudeAgentSdk(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = newAssistantMessageEventStream();

  // pi-ai's published Message role union omits "developer", which oh-my-pi's
  // runtime does send; role is a plain string at runtime regardless.
  const lastMsgRole = context.messages[context.messages.length - 1]?.role as
    | string
    | undefined;
  debug(
    `provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`,
  );

  const activeQuery = ctx().activeQuery !== null;
  const allResults =
    activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
  const resultCtx =
    allResults.length > 0 ? contextForToolResults(allResults) : undefined;
  const isReentrantUserQuery =
    activeQuery && (lastMsgRole === "user" || lastMsgRole === "developer") && allResults.length === 0;
  if (isReentrantUserQuery) {
    debug(
      `provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`,
    );
  }

  // --- Tool result delivery ---
  if (resultCtx) {
    claimCurrentPiStream(stream, "tool-result", resultCtx);
    resultCtx.resetTurnState(model);
    debug(
      `provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`,
    );
    for (const result of allResults) {
      const id = result.toolCallId;
      if (id && resultCtx.pendingToolCalls.has(id)) {
        const pending = resultCtx.pendingToolCalls.get(id)!;
        resultCtx.pendingToolCalls.delete(id);
        debug(
          `provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`,
          JSON.stringify(result.content).slice(0, 200),
        );
        pending.resolve(result);
      } else if (id) {
        resultCtx.pendingResults.set(id, result);
        debug(
          `provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`,
        );
      } else {
        debug(`WARNING: tool result without toolCallId, cannot match`);
      }
      if (
        resultCtx.pendingToolCalls.size > 0 &&
        resultCtx.pendingResults.size > 0
      ) {
        debug(
          `BUG: both maps non-empty! handlers=${resultCtx.pendingToolCalls.size} results=${resultCtx.pendingResults.size}`,
        );
      }
    }
    if (resultCtx.pendingToolCalls.size > 0) {
      debug(
        `WARNING: ${resultCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`,
      );
      piUI?.notify(
        `Claude bridge: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`,
        "warning",
      );
    }

    if (lastMsgRole === "user" || lastMsgRole === "developer") {
      const userPrompt = extractUserPrompt(context.messages);
      if (userPrompt) {
        resultCtx.deferredUserMessages.push(userPrompt);
        debug(
          `provider: deferred user message for replay after query: ${userPrompt.slice(0, 60)}`,
        );
      }
    }

    if (sharedSession)
      sharedSession.cursor = context.messages.length;
    resultCtx.latestCursor = Math.max(
      resultCtx.latestCursor,
      context.messages.length,
    );
    return stream;
  }

  // --- Orphaned tool result ---
  const lastMsg = context.messages[context.messages.length - 1];
  if (lastMsg?.role === "toolResult") {
    debug(`provider: orphaned tool result after abort, emitting end_turn`);
    if (sharedSession) sharedSession.cursor = context.messages.length;
    const c = ctx();
    queueMicrotask(() => {
      c.resetTurnState(model);
      stream.push({
        type: "done",
        reason: "stop",
        message: c.turnOutput,
      });
      markStreamComplete(stream);
      stream.end();
    });
    return stream;
  }

  // --- Fresh query ---
  const isReentrant = activeQuery;
  const queryCtx = isReentrant ? new QueryContext() : ctx();
  debug(
    `provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`,
  );

  claimCurrentPiStream(stream, "fresh-query", queryCtx);
  queryCtx.pendingToolCalls.clear();
  queryCtx.pendingResults.clear();
  queryCtx.deferredUserMessages = [];
  queryCtx.resetTurnState(model);
  queryCtx.latestCursor = 0;

  const { mcpTools, customToolNameToSdk, customToolNameToPi } =
    resolveMcpTools(context, askClaudeToolName);
  const cwd =
    (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
  const syncResult = syncSharedSession(
    context.messages,
    cwd,
    customToolNameToSdk,
    model.id,
  );
  const { sessionId: resumeSessionId } = syncResult;
  const promptBlocks = extractUserPromptBlocks(context.messages);
  let promptText = extractUserPrompt(context.messages) ?? "";

  if (!promptText && !promptBlocks) {
    diagDump("empty_prompt", {
      contextLength: context.messages.length,
      lastMsgRole: lastMsg?.role,
      isReentrant,
      activeQueryContexts: activeQueryContexts.size,
      activeQueryExists: queryCtx.activeQuery !== null,
      sharedSession: sharedSession
        ? {
            sessionId: sharedSession.sessionId.slice(0, 8),
            cursor: sharedSession.cursor,
          }
        : null,
      messageRoles: context.messages
        .map((m, i) => `[${i}]${m.role}`)
        .join(" "),
    });
    promptText = "[continue]";
  }

  const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
    ? wrapPromptStream(promptBlocks)
    : promptText;

  const mcpServers = buildMcpServers(mcpTools, queryCtx);
  const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;

  // pi-ai's published Context.systemPrompt type is `string`, but oh-my-pi's
  // runtime actually sends `string[]`.
  const systemPromptParts = context.systemPrompt as unknown as
    | string[]
    | undefined;
  const systemPromptStr = systemPromptParts?.join("\n\n");
  const agentsAppend = appendSystemPrompt
    ? extractAgentsAppend()
    : undefined;
  const skillsAppend = appendSystemPrompt
    ? extractSkillsBlock(systemPromptStr)
    : undefined;
  const appendParts = [
    TOOL_NAMING_CLARIFICATION,
    agentsAppend,
    skillsAppend,
  ].filter((part): part is string => Boolean(part));
  const systemPromptAppend =
    appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

  const settingSources: SettingSource[] | undefined = appendSystemPrompt
    ? undefined
    : providerSettings.settingSources ?? ["user", "project"];
  const strictMcpConfigEnabled =
    providerSettings.strictMcpConfig !== false;
  const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

  const effort = options?.reasoning
    ? (((model as any).thinkingLevelMap?.[
        options.reasoning
      ] as EffortLevel | undefined) ??
      REASONING_TO_EFFORT[options.reasoning])
    : undefined;

  const cliModel = claudeCodeModelId(model, longContextSettings);
  const extraArgs: Record<string, string | null> = { model: cliModel };
  if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
  if (effort) extraArgs["thinking-display"] = "summarized";

  const childEnv = {
    ...process.env,
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    DISABLE_AUTO_COMPACT: "1",
  };
  const queryOptions: NonNullable<
    Parameters<typeof query>[0]["options"]
  > = {
    cwd,
    env: childEnv,
    tools: [],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPromptAppend ? systemPromptAppend : undefined,
    },
    extraArgs,
    ...(effort ? { effort } : {}),
    ...(settingSources ? { settingSources } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(claudeExecutable
      ? { pathToClaudeCodeExecutable: claudeExecutable }
      : {}),
    ...makeCliDebugOptions("provider"),
  };

  debug(
    "provider: fresh query",
    `model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
    `resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
    `appendSys=${appendSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
    `prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`,
  );

  let wasAborted = false;
  const sdkQuery = query({ prompt, options: queryOptions });
  queryCtx.activeQuery = sdkQuery;
  activeQueryContexts.add(queryCtx);

  const abortCtx = queryCtx;

  const requestAbort = () => {
    void sdkQuery.interrupt().catch(() => {});
    try {
      sdkQuery.close();
    } catch {}
  };
  const onAbort = () => {
    wasAborted = true;
    abortCtx.deferredUserMessages = [];
    for (const pending of abortCtx.pendingToolCalls.values()) {
      pending.resolve({
        content: [{ type: "text", text: "Operation aborted" }],
      });
    }
    abortCtx.pendingToolCalls.clear();
    abortCtx.pendingResults.clear();
    requestAbort();
  };
  if (options?.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  consumeQuery(
    sdkQuery,
    customToolNameToPi,
    model,
    () => wasAborted,
    queryCtx,
  )
    .then(async ({ capturedSessionId }) => {
      debug(
        `provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`,
      );

      if (wasAborted || options?.signal?.aborted) {
        if (sharedSession)
          sharedSession = {
            ...sharedSession,
            needsRebuild: true,
            forceRotate: true,
          };
        queryCtx.deferredUserMessages = [];
        debug(
          `provider: abort detected, marked sharedSession needsRebuild + forceRotate`,
        );
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "aborted";
          queryCtx.turnOutput.errorMessage = "Operation aborted";
        }
        const stream = queryCtx.currentPiStream;
        stream?.push({
          type: "error",
          reason: "aborted",
          error: queryCtx.turnOutput!,
        });
        markStreamComplete(stream);
        stream?.end();
        queryCtx.currentPiStream = null;
        return;
      }

      const sessionId =
        capturedSessionId ?? sharedSession?.sessionId;
      if (syncResult.preserveSharedSession) {
        if (
          capturedSessionId &&
          capturedSessionId !== sharedSession?.sessionId
        ) {
          deleteSession(
            capturedSessionId,
            cwd,
            process.env.CLAUDE_CONFIG_DIR,
          );
          debug(
            `provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`,
          );
        }
        debug(
          `provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`,
        );
      } else if (sessionId) {
        const cursor = Math.max(
          context.messages.length,
          queryCtx.latestCursor,
          sharedSession?.cursor ?? 0,
        );
        debug(
          `provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`,
        );
        sharedSession = { sessionId, cursor, cwd };
      }

      // Replay deferred user messages as continuation queries
      try {
        while (
          queryCtx.deferredUserMessages.length > 0 &&
          !isReentrant &&
          !wasAborted
        ) {
          const steerPrompt = queryCtx.deferredUserMessages.shift()!;
          debug(
            `provider: replaying deferred user message: ${steerPrompt.slice(0, 60)}`,
          );
          queryCtx.resetTurnState(model);

          const resumeId = sharedSession?.sessionId;
          if (!resumeId) {
            debug(
              `WARNING: no session to resume for deferred message, dropping`,
            );
            break;
          }

          const contOptions = {
            ...queryOptions,
            resume: resumeId,
            ...makeCliDebugOptions("continuation"),
          };
          const contQuery = query({
            prompt: steerPrompt,
            options: contOptions,
          });
          queryCtx.activeQuery = contQuery;

          debug(
            `provider: continuation query, model=${cliModel}, resume=${resumeId.slice(0, 8)}, prompt=${steerPrompt.slice(0, 60)}`,
          );

          try {
            const { capturedSessionId: contSid } = await consumeQuery(
              contQuery,
              customToolNameToPi,
              model,
              () => wasAborted,
              queryCtx,
            );
            const sid = contSid ?? sharedSession?.sessionId;
            if (sid) {
              sharedSession = {
                sessionId: sid,
                cursor: sharedSession?.cursor ?? 0,
                cwd,
              };
            }
          } catch (contError) {
            debug(`provider: continuation query error:`, contError);
            break;
          } finally {
            contQuery.close();
          }
        }
      } finally {
        queryCtx.activeQuery = sdkQuery;
      }

      if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
        debug("provider: clearing activeQuery before final stream completion");
        queryCtx.activeQuery = null;
      }
      finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
    })
    .catch((error) => {
      debug(
        `provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`,
        error,
      );
      if ((wasAborted || options?.signal?.aborted) && sharedSession) {
        sharedSession = {
          ...sharedSession,
          needsRebuild: true,
          forceRotate: true,
        };
      } else {
        sharedSession = null;
      }
      queryCtx.deferredUserMessages = [];
      if (queryCtx.turnOutput) {
        queryCtx.turnOutput.stopReason = options?.signal?.aborted
          ? "aborted"
          : "error";
        queryCtx.turnOutput.errorMessage =
          error instanceof Error ? error.message : String(error);
      }
      if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
        for (const pending of queryCtx.pendingToolCalls.values()) {
          pending.resolve({
            content: [{ type: "text", text: "Query ended" }],
          });
        }
        queryCtx.pendingToolCalls.clear();
        queryCtx.pendingResults.clear();
        debug(
          "provider: clearing activeQuery before error stream completion",
        );
        queryCtx.activeQuery = null;
      }
      const stream = queryCtx.currentPiStream;
      stream?.push({
        type: "error",
        reason: (queryCtx.turnOutput?.stopReason ?? "error") as
          | "aborted"
          | "error",
        error: queryCtx.turnOutput!,
      });
      markStreamComplete(stream);
      stream?.end();
      queryCtx.currentPiStream = null;
    })
    .finally(() => {
      if (options?.signal)
        options.signal.removeEventListener("abort", onAbort);
      if (queryCtx.activeQuery === sdkQuery) {
        for (const pending of queryCtx.pendingToolCalls.values()) {
          pending.resolve({
            content: [{ type: "text", text: "Query ended" }],
          });
        }
        queryCtx.pendingToolCalls.clear();
        queryCtx.pendingResults.clear();
        queryCtx.activeQuery = null;
      }
      activeQueryContexts.delete(queryCtx);
      sdkQuery.close();
    });

  return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
  prompt: string,
  mode: "full" | "read" | "none",
  toolCalls: Map<string, ToolCallState>,
  signal?: AbortSignal,
  options?: {
    systemPrompt?: string;
    appendSkills?: boolean;
    onStreamUpdate?: (responseText: string) => void;
    model?: string;
    thinking?: string;
    isolated?: boolean;
    context?: Context["messages"];
  },
): Promise<{ responseText: string; stopReason: string }> {
  const cwd = process.cwd();
  const requestedModel = options?.model ?? "opus";
  const model = resolveModel(requestedModel);
  const modelId = model?.id ?? requestedModel;
  const cliModel = model
    ? claudeCodeModelId(model, longContextSettings)
    : modelId;

  let resumeSessionId: string | null = null;
  if (!options?.isolated && options?.context?.length) {
    if (sharedSession) {
      resumeSessionId = sharedSession.sessionId;
    } else {
      const contextWithPrompt = [
        ...options.context,
        {
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
        },
      ];
      const sync = syncSharedSession(
        contextWithPrompt as Context["messages"],
        cwd,
        undefined,
        modelId,
      );
      resumeSessionId = sync.sessionId;
    }
  }

  const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

  const skillsBlock =
    options?.appendSkills !== false && options?.systemPrompt
      ? extractSkillsBlock(options.systemPrompt)
      : undefined;

  const effort =
    options?.thinking && options.thinking !== "off"
      ? REASONING_TO_EFFORT[options.thinking]
      : undefined;

  const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

  const extraArgs: Record<string, string | null> = {
    "strict-mcp-config": null,
    model: cliModel,
  };
  if (effort) extraArgs["thinking-display"] = "summarized";

  debug(
    "askClaude:",
    `mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
    `isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
    `skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`,
  );

  const sdkQuery = query({
    prompt,
    options: {
      cwd,
      env: {
        ...process.env,
        ENABLE_CLAUDEAI_MCP_SERVERS: "0",
        DISABLE_AUTO_COMPACT: "1",
      },
      permissionMode: "bypassPermissions",
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(effort ? { effort } : {}),
      systemPrompt: skillsBlock
        ? { type: "preset", preset: "claude_code", append: skillsBlock }
        : undefined,
      settingSources: ["user", "project"] as SettingSource[],
      extraArgs,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(options?.isolated ? { persistSession: false } : {}),
      ...(claudeExecutable
        ? { pathToClaudeCodeExecutable: claudeExecutable }
        : {}),
      ...makeCliDebugOptions("askclaude"),
    },
  });

  let wasAborted = false;
  const onAbort = () => {
    wasAborted = true;
    sdkQuery.interrupt().catch(() => {
      try {
        sdkQuery.close();
      } catch {}
    });
  };
  if (signal?.aborted) {
    onAbort();
    throw new Error("Aborted");
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  let sdkMessageCount = 0;
  let textDeltaCount = 0;
  let resultSubtype: string | undefined;

  try {
    for await (const message of sdkQuery) {
      if (wasAborted) break;
      sdkMessageCount++;

      switch (message.type) {
        case "stream_event": {
          const event = (message as SDKMessage & { event: any }).event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            responseText += event.delta.text;
            textDeltaCount++;
            options?.onStreamUpdate?.(responseText);
          }
          if (
            event?.type === "content_block_start" &&
            event.content_block?.type === "tool_use"
          ) {
            debug(
              `askClaude: tool_use start: ${event.content_block.name}`,
            );
            toolCalls.set(event.content_block.id, {
              name: mapToolName(event.content_block.name),
              status: "running",
            });
          }
          break;
        }
        case "assistant": {
          for (const block of (message as any).message?.content ?? []) {
            if (block.type === "tool_use") {
              toolCalls.set(block.id, {
                name: mapToolName(block.name),
                status: "complete",
                rawInput: block.input,
              });
            }
          }
          break;
        }
        case "result": {
          resultSubtype = message.subtype;
          const r = message as any;
          if (r.usage) {
            debug(
              `askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`,
            );
          }
          if (
            !responseText &&
            message.subtype === "success" &&
            message.result
          ) {
            responseText = message.result;
          }
          break;
        }
      }
    }

    const stopReason = wasAborted ? "cancelled" : "stop";
    debug(
      "askClaude: done",
      `stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
      `sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
      `toolCalls=${toolCalls.size}`,
    );
    return { responseText, stopReason };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    sdkQuery.close();
  }
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL =
  "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION =
  "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";
// Cached system prompt for AskClaude tool (oh-my-pi CustomToolContext lacks getSystemPrompt)
let cachedSystemPrompt: string[] = [];

export default function (pi: ExtensionAPI) {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const config = loadConfig(process.cwd());
  debug("loadConfig:", JSON.stringify(config));
  providerSettings = config.provider ?? {};
  longContextSettings = {
    plan: providerSettings.plan ?? "pro",
    longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
  };
  const registeredModels = applyLongContext(MODELS, longContextSettings);

  // Reset shared session on session lifecycle events
  const clearSession = (event: string) => {
    debug(
      `clearSession ${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`,
    );
    sharedSession = null;

    const g = globalThis as Record<symbol, any>;
    if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
      debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
      g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
    }
  };

  // oh-my-pi SessionStartEvent has no `reason` field — clear unconditionally
  pi.on("session_start", (_event, ctx) => {
    piUI = ctx.ui;
    // ctx.getSystemPrompt()'s published return type is `string`, but oh-my-pi's
    // runtime actually returns `string[]`.
    cachedSystemPrompt = ctx.getSystemPrompt() as unknown as string[];
    clearSession("session_start");
  });
  pi.on("session_shutdown", () => clearSession("session_shutdown"));

  // Compaction takeover skipped — let oh-my-pi's default compaction handle it.
  // See plan: Decision 1 in the port plan.

  // oh-my-pi SessionCompactEvent has `compactionEntry` not `reason`/`willRetry`
  const markRebuild = (event: string) => {
    if (sharedSession) {
      debug(
        `${event}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`,
      );
      sharedSession = { ...sharedSession, needsRebuild: true };
    }
  };
  pi.on("session_compact", () => markRebuild("session_compact"));
  pi.on("session_tree", () => markRebuild("session_tree"));

  // --- Provider ---
  const g = globalThis as Record<symbol, any>;
  if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
    g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "claude-bridge",
      apiKey: "not-used",
      api: "claude-bridge",
      models: registeredModels,
      streamSimple: streamClaudeAgentSdk as any,
    });
  } else {
    debug(
      `provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`,
    );
  }

  // --- AskClaude tool ---
  const askConf = config.askClaude;
  const allowFull = askConf?.allowFullMode !== false;
  const defaultMode = askConf?.defaultMode ?? "read";
  const defaultIsolated = askConf?.defaultIsolated ?? false;
  askClaudeToolName = askConf?.name ?? "AskClaude";

  const TypeBox = Type;

  const modeValues = allowFull
    ? (["read", "full", "none"] as const)
    : (["read", "none"] as const);
  let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
  if (allowFull)
    modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

  if (askConf?.enabled !== false) {
    const askClaudeParams = TypeBox.Object({
      prompt: TypeBox.String({
        description:
          "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore.",
      }),
      mode: TypeBox.Optional(
        StringEnum(modeValues as any, { description: modeDesc }),
      ),
      model: TypeBox.Optional(
        TypeBox.String({
          description:
            'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".',
        }),
      ),
      thinking: TypeBox.Optional(
        StringEnum(
          ["off", "minimal", "low", "medium", "high", "xhigh"] as const,
          {
            description:
              "Thinking effort level. Omit to use Claude Code's default.",
          },
        ),
      ),
      isolated: TypeBox.Optional(
        TypeBox.Boolean({
          description:
            "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history.",
        }),
      ),
    });

    // Get keyHint for renderResult. Try pi-utils import path pattern.
    let hint: ((...args: any[]) => string) | undefined;
    try {
      const piUtils = (pi as any).pi;
      hint = piUtils?.keyHint;
    } catch {}

    pi.registerTool<typeof askClaudeParams>({
      name: askConf?.name ?? "AskClaude",
      label: askConf?.label ?? "Ask Claude Code",
      description:
        askConf?.description ??
        (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
      parameters: askClaudeParams,
      renderCall(args: any, theme: any) {
        let text = theme.fg("mdLink", theme.bold("AskClaude "));
        const mode = args.mode ?? defaultMode;
        const tags: string[] = [];
        if (mode !== defaultMode) tags.push(`mode=${mode}`);
        if (args.model) tags.push(`model=${args.model}`);
        if (args.thinking) tags.push(`thinking=${args.thinking}`);
        if (args.isolated) tags.push("isolated");
        if (tags.length)
          text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
        const truncated =
          args.prompt.length > PREVIEW_MAX_CHARS
            ? args.prompt.substring(0, PREVIEW_MAX_CHARS)
            : args.prompt;
        const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
        text += theme.fg("muted", `"${lines.join("\n")}"`);
        if (
          args.prompt.length > PREVIEW_MAX_CHARS ||
          args.prompt.split("\n").length > PREVIEW_MAX_LINES
        )
          text += theme.fg("dim", " …");
        return new Text(text, 0, 0);
      },
      renderResult(result: any, { expanded, isPartial }: any, theme: any) {
        if (isPartial) {
          const status =
            result.content[0]?.type === "text"
              ? result.content[0].text
              : "working...";
          return new Text(
            theme.fg("mdLink", "◉ Claude Code ") +
              theme.fg("muted", status),
            0,
            0,
          );
        }

        const details = result.details as
          | {
              prompt?: string;
              executionTime?: number;
              actions?: string;
              error?: boolean;
            }
          | undefined;
        const body =
          result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = details?.error
          ? theme.fg("error", "✗ Claude Code error")
          : theme.fg("mdLink", "✓ Claude Code");

        if (details?.executionTime)
          text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
        if (details?.actions)
          text += ` ${theme.fg("muted", details.actions)}`;

        if (expanded) {
          if (details?.prompt)
            text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
          if (details?.prompt && body)
            text += `\n${theme.fg("dim", "─".repeat(40))}`;
          if (body) text += `\n${theme.fg("toolOutput", body)}`;
        } else {
          const truncated =
            body.length > PREVIEW_MAX_CHARS
              ? body.substring(0, PREVIEW_MAX_CHARS)
              : body;
          const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
          if (lines.length)
            text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
          if (
            body.length > PREVIEW_MAX_CHARS ||
            body.split("\n").length > PREVIEW_MAX_LINES
          )
            text +=
              `\n${theme.fg("dim", `… (${hint ? hint("app.tools.expand", "to expand") : "to expand"})`)}`;
        }

        return new Text(text, 0, 0);
      },
      async execute(_id: any, params: any, signal: any, onUpdate: any, ctx: any) {
        // Guard: circular delegation
        if (ctx.model?.baseUrl === "claude-bridge") {
          debug(
            "askClaude: blocked circular delegation (active provider is claude-bridge)",
          );
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code.",
              },
            ],
            details: { error: true },
          };
        }

        const mode = (params.mode ?? defaultMode) as
          | "full"
          | "read"
          | "none";
        const isolated = params.isolated ?? defaultIsolated;
        const toolCalls = new Map<string, ToolCallState>();
        const start = Date.now();

        const progressInterval = setInterval(() => {
          const elapsed = ((Date.now() - start) / 1000).toFixed(0);
          const summary = buildActionSummary(toolCalls);
          const status = summary
            ? `${elapsed}s — ${summary}`
            : `${elapsed}s — working...`;
          onUpdate?.({
            content: [{ type: "text", text: status }],
            details: {
              prompt: params.prompt,
              executionTime: Date.now() - start,
            },
          });
        }, 1000);

        try {
          // oh-my-pi: always isolated. CustomToolContext lacks getSystemPrompt
          // and SessionEntry[] → Message[] conversion is non-trivial.
          // Context is always undefined. isolated param still controls persistSession.
          const systemPromptStr = cachedSystemPrompt.join("\n\n");
          const result = await promptAndWait(
            params.prompt,
            mode,
            toolCalls,
            signal,
            {
              systemPrompt: systemPromptStr,
              appendSkills: askConf?.appendSkills,
              model: params.model,
              thinking: params.thinking,
              isolated,
              context: undefined,
            },
          );
          clearInterval(progressInterval);
          onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
          const executionTime = Date.now() - start;
          const actions = buildActionSummary(toolCalls);

          const text = actions
            ? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
            : result.responseText;
          return {
            content: [{ type: "text" as const, text }],
            details: {
              prompt: params.prompt,
              executionTime,
              actions,
            },
          };
        } catch (err) {
          clearInterval(progressInterval);
          debug(
            `askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`,
            err,
          );
          const msg = errorMessage(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${msg}` }],
            details: {
              prompt: params.prompt,
              executionTime: Date.now() - start,
              error: true,
            },
          };
        }
      },
    });
  }
}
