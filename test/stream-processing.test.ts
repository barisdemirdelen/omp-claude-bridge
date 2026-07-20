import { describe, expect, test } from "bun:test";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { QueryContext } from "../query-state.js";
import {
  claimCurrentPiStream,
  finalizeCurrentStream,
  mapStopReason,
  markStreamComplete,
  parsePartialJson,
  processAssistantMessage,
  processStreamEvent,
  updateUsage,
} from "../stream-processing.js";

const MODEL = {
  id: "claude-test",
  name: "Test",
  api: "anthropic-messages",
  provider: "claude-bridge",
  reasoning: true,
  input: ["text"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as unknown as Model<Api>;

interface CollectedEvent {
  type: string;
  [key: string]: unknown;
}

function fakeStream(): {
  stream: AssistantMessageEventStream;
  events: CollectedEvent[];
  ended: () => boolean;
} {
  const events: CollectedEvent[] = [];
  let done = false;
  const stream = {
    push: (e: CollectedEvent) => events.push(e),
    end: () => {
      done = true;
    },
  } as unknown as AssistantMessageEventStream;
  return { stream, events, ended: () => done };
}

function newContext() {
  const c = new QueryContext();
  const { stream, events, ended } = fakeStream();
  c.resetTurnState(MODEL);
  c.currentPiStream = stream;
  return { c, events, ended };
}

const sdk = (event: Record<string, unknown>): SDKMessage =>
  ({ type: "stream_event", event }) as unknown as SDKMessage;

describe("processStreamEvent", () => {
  test("text block lifecycle emits start/delta/end and accumulates text", () => {
    const { c, events } = newContext();
    const noMap = new Map<string, string>();
    processStreamEvent(sdk({ type: "message_start", message: {} }), noMap, MODEL, c);
    processStreamEvent(
      sdk({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(sdk({ type: "content_block_stop", index: 0 }), noMap, MODEL, c);
    processStreamEvent(
      sdk({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      noMap,
      MODEL,
      c,
    );

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
    ]);
    expect(c.turnBlocks).toEqual([{ type: "text", text: "Hello" }]);
    expect(c.turnOutput?.stopReason).toBe("stop");
    expect(c.turnSawStreamEvent).toBe(true);
  });

  test("tool_use lifecycle maps names/args and finishes the stream on message_stop", () => {
    const { c, events, ended } = newContext();
    const noMap = new Map<string, string>();
    processStreamEvent(sdk({ type: "message_start", message: {} }), noMap, MODEL, c);
    processStreamEvent(
      sdk({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc1", name: "Edit", input: {} },
      }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path":"a.ts","old_string":"x","new_string":"y"}',
        },
      }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(sdk({ type: "content_block_stop", index: 0 }), noMap, MODEL, c);
    processStreamEvent(sdk({ type: "message_stop" }), noMap, MODEL, c);

    expect(c.turnToolCallIds).toEqual(["tc1"]);
    expect(c.turnBlocks[0]).toEqual({
      type: "toolCall",
      id: "tc1",
      name: "edit",
      arguments: { path: "a.ts", oldText: "x", newText: "y" },
    });
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(ended()).toBe(true);
    expect(c.currentPiStream).toBeNull();
  });

  test("thinking blocks collect deltas and signature", () => {
    const { c } = newContext();
    const noMap = new Map<string, string>();
    processStreamEvent(
      sdk({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "mull" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(
      sdk({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s1" } }),
      noMap,
      MODEL,
      c,
    );
    processStreamEvent(sdk({ type: "content_block_stop", index: 0 }), noMap, MODEL, c);
    expect(c.turnBlocks[0]).toEqual({
      type: "thinking",
      thinking: "mull",
      thinkingSignature: "s1",
    });
  });

  test("does nothing without an active stream", () => {
    const c = new QueryContext();
    c.resetTurnState(MODEL);
    c.currentPiStream = null;
    processStreamEvent(sdk({ type: "message_start" }), new Map(), MODEL, c);
    expect(c.turnSawStreamEvent).toBe(false);
  });
});

describe("processAssistantMessage", () => {
  const assistantSdk = (content: unknown[], usage?: Record<string, number>) =>
    ({ type: "assistant", message: { content, usage } }) as unknown as SDKMessage;

  test("is skipped when stream events were already processed", () => {
    const { c, events } = newContext();
    c.turnSawStreamEvent = true;
    processAssistantMessage(assistantSdk([{ type: "text", text: "x" }]), MODEL, new Map(), c);
    expect(events).toEqual([]);
  });

  test("replays text and tool_use blocks as full event sequences", () => {
    const { c, events, ended } = newContext();
    processAssistantMessage(
      assistantSdk([
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "f.ts" } },
      ]),
      MODEL,
      new Map(),
      c,
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    expect(c.turnBlocks[1]).toEqual({
      type: "toolCall",
      id: "t1",
      name: "read",
      arguments: { path: "f.ts" },
    });
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(ended()).toBe(true);
  });

  test("text-only message leaves the stream open for the result", () => {
    const { c, ended } = newContext();
    processAssistantMessage(
      assistantSdk([{ type: "text", text: "plain answer" }]),
      MODEL,
      new Map(),
      c,
    );
    expect(ended()).toBe(false);
    expect(c.currentPiStream).not.toBeNull();
  });
});

describe("finalizeCurrentStream", () => {
  test("emits done with stop/length and clears the stream", () => {
    const { c, events, ended } = newContext();
    finalizeCurrentStream(c, "length");
    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
    expect(ended()).toBe(true);
    expect(c.currentPiStream).toBeNull();
  });
});

describe("claimCurrentPiStream / markStreamComplete", () => {
  test("claims replace the stream reference", () => {
    const { c } = newContext();
    const { stream: replacement } = fakeStream();
    markStreamComplete(c.currentPiStream);
    claimCurrentPiStream(replacement, "test", c);
    expect(c.currentPiStream).toBe(replacement);
  });
});

describe("updateUsage", () => {
  test("maps token fields, sums totals, and computes cost", () => {
    const c = new QueryContext();
    c.resetTurnState(MODEL);
    updateUsage(
      c.turnOutput!,
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
      },
      MODEL,
    );
    const usage = c.turnOutput!.usage;
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.cacheRead).toBe(1000);
    expect(usage.cacheWrite).toBe(10);
    expect(usage.totalTokens).toBe(1160);
    expect(usage.cost.total).toBeGreaterThan(0);
  });

  test("keeps previous values when fields are absent", () => {
    const c = new QueryContext();
    c.resetTurnState(MODEL);
    updateUsage(c.turnOutput!, { input_tokens: 7 }, MODEL);
    updateUsage(c.turnOutput!, { output_tokens: 3 }, MODEL);
    expect(c.turnOutput!.usage.input).toBe(7);
    expect(c.turnOutput!.usage.output).toBe(3);
  });
});

describe("mapStopReason", () => {
  test("maps SDK reasons to pi reasons", () => {
    expect(mapStopReason("tool_use")).toBe("toolUse");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });
});

describe("parsePartialJson", () => {
  test("parses complete JSON and falls back otherwise", () => {
    expect(parsePartialJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":', { keep: true })).toEqual({ keep: true });
    expect(parsePartialJson("", { keep: true })).toEqual({ keep: true });
  });
});
