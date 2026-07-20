// SDK message/event stream → pi AssistantMessageEventStream translation.
// Ported from pi-claude-bridge verbatim; operates on a QueryContext plus a
// stream sink, no module state beyond the completed-streams registry.

import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { debug } from "./debug.js";
import { mapToolArgs, mapToolName } from "./tool-mapping.js";
import type { QueryContext } from "./query-state.js";

export function mapStopReason(
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

export function parsePartialJson(
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

export function updateUsage(
  output: AssistantMessage,
  usage: Record<string, number | undefined>,
  model: Model<Api>,
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

export function logServedContextWindow(
  label: string,
  message: SDKMessage,
  model: Model<Api>,
): void {
  const modelUsage = (message as unknown as {
    modelUsage?: Record<
      string,
      { contextWindow?: number; maxOutputTokens?: number }
    >;
  }).modelUsage;
  if (!modelUsage) return;
  for (const [k, v] of Object.entries(modelUsage)) {
    debug(
      `${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`,
    );
  }
}

const completedStreams = new WeakSet<object>();

export function markStreamComplete(
  stream: AssistantMessageEventStream | null,
): void {
  if (stream) completedStreams.add(stream as object);
}

export function claimCurrentPiStream(
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

export function ensureTurnStarted(c: QueryContext): void {
  if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
    c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
    c.turnStarted = true;
  }
}

export function finalizeCurrentStream(
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

// SDK stream events arrive as loosely-typed Anthropic API event payloads; the
// SDK's own types don't cover the raw `event` field, so this module reads it
// through a structural view rather than `any`.
interface RawStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: Record<string, number | undefined> };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: Record<string, number | undefined>;
}

export function processStreamEvent(
  message: SDKMessage,
  customToolNameToPi: Map<string, string>,
  model: Model<Api>,
  c: QueryContext,
): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  c.turnSawStreamEvent = true;
  const event = (message as SDKMessage & { event?: RawStreamEvent }).event;

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
      c.turnToolCallIds.push(event.content_block.id!);
      c.turnBlocks.push({
        type: "toolCall",
        id: event.content_block.id,
        name: mapToolName(event.content_block.name!, customToolNameToPi),
        arguments: event.content_block.input ?? {},
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
      (b: { index?: number }) => b.index === event.index,
    );
    const block = c.turnBlocks[index];
    if (!block) return;
    if (event.delta?.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      c.currentPiStream!.push({
        type: "text_delta",
        contentIndex: index,
        delta: event.delta.text!,
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
        delta: event.delta.thinking!,
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
        delta: event.delta.partial_json!,
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
      (b: { index?: number }) => b.index === event.index,
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

// Non-streaming assistant message payload, structurally (see RawStreamEvent note).
interface RawAssistantBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function processAssistantMessage(
  message: SDKMessage,
  model: Model<Api>,
  customToolNameToPi: Map<string, string>,
  c: QueryContext,
): void {
  if (c.turnSawStreamEvent) return;
  const assistantMsg = (message as unknown as {
    message?: {
      content?: RawAssistantBlock[];
      usage?: Record<string, number | undefined>;
    };
  }).message;
  if (!assistantMsg?.content) return;
  c.turnToolCallIds = [];
  c.nextHandlerIdx = 0;
  debug(
    `processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b) => b.type).join(",")}`,
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
      c.turnToolCallIds.push(block.id!);
      const mappedArgs = mapToolArgs(
        mapToolName(block.name!, customToolNameToPi),
        block.input,
      );
      c.turnBlocks.push({
        type: "toolCall",
        id: block.id,
        name: mapToolName(block.name!, customToolNameToPi),
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
        toolCall: toolBlock,
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

export interface ConsumeQueryHooks {
  /** Rate-limit notices surfaced to the user. */
  notify?: (message: string, level: "warning" | "error") => void;
}

export async function consumeQuery(
  sdkQuery: Query,
  customToolNameToPi: Map<string, string>,
  model: Model<Api>,
  wasAborted: () => boolean,
  queryCtx: QueryContext,
  hooks?: ConsumeQueryHooks,
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
        processAssistantMessage(message, model, customToolNameToPi, queryCtx);
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
          (message as { subtype?: string }).subtype === "init" &&
          (message as { session_id?: string }).session_id
        ) {
          capturedSessionId = (message as { session_id?: string }).session_id;
        }
        break;
      case "user":
        break;
      case "rate_limit_event": {
        const info = (message as unknown as {
          rate_limit_info?: {
            status?: string;
            rateLimitType?: string;
            resetsAt?: number | string;
            utilization?: number;
          };
        }).rate_limit_info;
        debug(
          "consumeQuery: rate_limit_event",
          JSON.stringify(info).slice(0, 300),
        );
        if (info?.status === "rejected") {
          const resetsAt = info.resetsAt
            ? new Date(info.resetsAt).toLocaleTimeString()
            : "unknown";
          hooks?.notify?.(
            `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`,
            "warning",
          );
        } else if (info?.status === "allowed_warning") {
          hooks?.notify?.(
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
