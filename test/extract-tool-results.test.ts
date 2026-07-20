import { describe, expect, test } from "bun:test";
import {
  extractAllToolResults,
  toolResultToMcpContent,
} from "../extract-tool-results.js";

describe("extractAllToolResults", () => {
  test("collects trailing tool results in order, stopping at the last assistant", () => {
    const { results, stopIdx } = extractAllToolResults([
      { role: "toolResult", toolCallId: "old", content: "old" },
      { role: "assistant", content: [] },
      { role: "toolResult", toolCallId: "a", content: "first" },
      { role: "toolResult", toolCallId: "b", content: "second", isError: true },
    ]);
    expect(stopIdx).toBe(1);
    expect(results.map((r) => r.toolCallId)).toEqual(["a", "b"]);
    expect(results[1].isError).toBe(true);
    expect(results[0].content).toEqual([{ type: "text", text: "first" }]);
  });

  test("skips interleaved user messages (steering) during the walk", () => {
    const { results } = extractAllToolResults([
      { role: "assistant", content: [] },
      { role: "toolResult", toolCallId: "a", content: "r1" },
      { role: "user", content: "steer!" },
      { role: "toolResult", toolCallId: "b", content: "r2" },
    ]);
    expect(results.map((r) => r.toolCallId)).toEqual(["a", "b"]);
  });

  test("returns empty when there are no trailing tool results", () => {
    const { results, stopIdx } = extractAllToolResults([
      { role: "user", content: "hi" },
      { role: "assistant", content: [] },
    ]);
    expect(results).toEqual([]);
    expect(stopIdx).toBe(1);
  });

  test("stopIdx is -1 when no assistant exists", () => {
    const { stopIdx } = extractAllToolResults([
      { role: "toolResult", toolCallId: "a", content: "x" },
    ]);
    expect(stopIdx).toBe(-1);
  });
});

describe("toolResultToMcpContent", () => {
  test("wraps strings as text blocks", () => {
    expect(toolResultToMcpContent("out")).toEqual([
      { type: "text", text: "out" },
    ]);
  });

  test("keeps text and image blocks, drops the rest", () => {
    expect(
      toolResultToMcpContent([
        { type: "text", text: "t" },
        { type: "image", data: "d", mimeType: "image/png" },
        { type: "audio" },
      ]),
    ).toEqual([
      { type: "text", text: "t" },
      { type: "image", data: "d", mimeType: "image/png" },
    ]);
  });

  test("falls back to an empty text block", () => {
    expect(toolResultToMcpContent([])).toEqual([{ type: "text", text: "" }]);
    expect(toolResultToMcpContent("")).toEqual([{ type: "text", text: "" }]);
  });
});
