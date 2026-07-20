import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  QueryContext,
  ctx,
  popContext,
  pushContext,
  resetStack,
  stackDepth,
} from "../query-state.js";

const MODEL = {
  id: "m1",
  api: "anthropic-messages",
  provider: "claude-bridge",
} as unknown as Model<Api>;

afterEach(() => resetStack());

describe("QueryContext", () => {
  test("resetTurnState builds a fresh assistant message and clears turn flags", () => {
    const c = new QueryContext();
    c.turnStarted = true;
    c.turnSawStreamEvent = true;
    c.turnSawToolCall = true;
    c.resetTurnState(MODEL);
    expect(c.turnOutput).toMatchObject({
      role: "assistant",
      content: [],
      model: "m1",
      provider: "claude-bridge",
      stopReason: "stop",
    });
    expect(c.turnStarted).toBe(false);
    expect(c.turnSawStreamEvent).toBe(false);
    expect(c.turnSawToolCall).toBe(false);
  });

  test("turnBlocks throws before resetTurnState and aliases content after", () => {
    const c = new QueryContext();
    expect(() => c.turnBlocks).toThrow();
    c.resetTurnState(MODEL);
    c.turnBlocks.push({ type: "text", text: "x" });
    expect(c.turnOutput!.content).toEqual([{ type: "text", text: "x" }]);
  });
});

describe("context stack", () => {
  test("pushContext isolates state; popContext restores the parent", () => {
    const parent = ctx();
    parent.activeQuery = {};
    parent.latestCursor = 7;

    pushContext();
    expect(stackDepth()).toBe(1);
    expect(ctx()).not.toBe(parent);
    expect(ctx().latestCursor).toBe(0);

    popContext();
    expect(stackDepth()).toBe(0);
    expect(ctx()).toBe(parent);
    expect(ctx().latestCursor).toBe(7);
  });

  test("deferred user messages propagate to the parent on pop", () => {
    ctx().activeQuery = {};
    pushContext();
    ctx().deferredUserMessages.push("steered mid-nested-query");
    popContext();
    expect(ctx().deferredUserMessages).toEqual(["steered mid-nested-query"]);
  });

  test("pushContext requires an active query; popContext requires a stack", () => {
    expect(() => pushContext()).toThrow();
    expect(() => popContext()).toThrow();
  });
});
