import { describe, expect, test } from "bun:test";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import {
  STEERED_NOTICE_TAGS,
  convertPiMessages,
  mapPiToolNameToSdk,
  messageContentToText,
  sanitizeToolId,
} from "../convert.js";

// Test fixtures are plain objects; pi-ai's Message union is stricter than the
// runtime shapes this module accepts (e.g. "developer" role).
function convert(messages: unknown[], customMap?: Map<string, string>) {
  return convertPiMessages(messages as PiMessage[], customMap);
}

describe("convertPiMessages", () => {
  test("string user message becomes user message", () => {
    const { anthropicMessages } = convert([
      { role: "user", content: "hello", timestamp: 123 },
    ]);
    expect(anthropicMessages).toMatchObject([
      { role: "user", content: "hello", timestamp: 123 } as Record<string, unknown>,
    ]);
  });

  test("developer role is mapped to user", () => {
    const { anthropicMessages } = convert([
      { role: "developer", content: "steered notice" },
    ]);
    expect(anthropicMessages).toHaveLength(1);
    expect(anthropicMessages[0].role).toBe("user");
  });

  test("system-notice and system-interrupt tags are retagged to system-reminder", () => {
    const { anthropicMessages } = convert([
      {
        role: "user",
        content:
          "<system-notice>mount changed</system-notice> and <system-interrupt>stop</system-interrupt>",
      },
    ]);
    expect(anthropicMessages[0].content).toBe(
      "<system-reminder>mount changed</system-reminder> and <system-reminder>stop</system-reminder>",
    );
  });

  test("retags inside text blocks too", () => {
    const { anthropicMessages } = convert([
      {
        role: "user",
        content: [{ type: "text", text: "<system-notice>x</system-notice>" }],
      },
    ]);
    const blocks = anthropicMessages[0].content as Array<{ text?: string }>;
    expect(blocks[0].text).toBe("<system-reminder>x</system-reminder>");
  });

  // Data-driven: every enumerated oh-my-pi steered-notice tag must retag to
  // <system-reminder>. Adding a tag to STEERED_NOTICE_TAGS auto-extends this.
  test.each([...STEERED_NOTICE_TAGS])(
    "retags <%s> (open and close) to system-reminder",
    (tag) => {
      const { anthropicMessages } = convert([
        { role: "user", content: `<${tag}>body</${tag}>` },
      ]);
      expect(anthropicMessages[0].content).toBe(
        "<system-reminder>body</system-reminder>",
      );
    },
  );

  test("retags tags carrying attributes", () => {
    const { anthropicMessages } = convert([
      {
        role: "user",
        content: '<system-interrupt reason="rule_violation" rule="x">stop</system-interrupt>',
      },
    ]);
    expect(anthropicMessages[0].content).toBe(
      '<system-reminder reason="rule_violation" rule="x">stop</system-reminder>',
    );
  });

  test("user image blocks become base64 image sources", () => {
    const { anthropicMessages } = convert([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    ]);
    const blocks = anthropicMessages[0].content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  test("assistant text and tool calls are converted, tool ids sanitized", () => {
    const { anthropicMessages, sanitizedIds } = convert([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me edit" },
          {
            type: "toolCall",
            id: "call:1|weird",
            name: "edit",
            arguments: { path: "a.ts" },
          },
        ],
      },
    ]);
    const blocks = anthropicMessages[0].content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "let me edit" });
    expect(blocks[1]).toEqual({
      type: "tool_use",
      id: "call_1_weird",
      name: "Edit",
      input: { path: "a.ts" },
    });
    expect(sanitizedIds.get("call:1|weird")).toBe("call_1_weird");
  });

  test("thinking blocks survive only for anthropic provenance with a signature", () => {
    const thinking = {
      type: "thinking",
      thinking: "hmm",
      thinkingSignature: "sig",
    };
    const kept = convert([
      { role: "assistant", provider: "claude-bridge", content: [thinking] },
    ]);
    expect(kept.anthropicMessages[0].content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig" },
    ]);

    const droppedForeign = convert([
      { role: "assistant", provider: "openai", api: "openai", content: [thinking] },
    ]);
    expect(droppedForeign.anthropicMessages).toHaveLength(0);

    const droppedUnsigned = convert([
      {
        role: "assistant",
        provider: "claude-bridge",
        content: [{ type: "thinking", thinking: "hmm" }],
      },
    ]);
    expect(droppedUnsigned.anthropicMessages).toHaveLength(0);
  });

  test("tool results become user tool_result blocks with matching sanitized id", () => {
    const { anthropicMessages } = convert([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "id:1", name: "read", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "id:1", content: "file text", isError: true },
    ]);
    const result = anthropicMessages[1].content as unknown as Array<Record<string, unknown>>;
    expect(anthropicMessages[1].role).toBe("user");
    expect(result[0]).toEqual({
      type: "tool_result",
      tool_use_id: "id_1",
      content: "file text",
      is_error: true,
    });
  });

  test("tool result without toolCallId is dropped", () => {
    const { anthropicMessages } = convert([
      { role: "toolResult", content: "orphan" },
    ]);
    expect(anthropicMessages).toHaveLength(0);
  });
});

describe("mapPiToolNameToSdk", () => {
  test("maps built-ins case-insensitively", () => {
    expect(mapPiToolNameToSdk("read")).toBe("Read");
    expect(mapPiToolNameToSdk("Bash")).toBe("Bash");
  });

  test("prefers custom tool map", () => {
    const map = new Map([["mytool", "mcp__custom-tools__mytool"]]);
    expect(mapPiToolNameToSdk("mytool", map)).toBe("mcp__custom-tools__mytool");
  });

  test("falls back to PascalCase", () => {
    expect(mapPiToolNameToSdk("some_tool")).toBe("SomeTool");
  });
});

describe("messageContentToText", () => {
  test("passes strings through", () => {
    expect(messageContentToText("hi")).toBe("hi");
  });

  test("joins text blocks and marks non-text blocks", () => {
    expect(
      messageContentToText([
        { type: "text", text: "a" },
        { type: "audio" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n[audio]\nb");
  });

  test("returns empty string when no text blocks", () => {
    expect(messageContentToText([{ type: "image", data: "x" }])).toBe("");
  });
});

describe("sanitizeToolId", () => {
  test("replaces invalid chars and caches", () => {
    const cache = new Map<string, string>();
    expect(sanitizeToolId("a:b|c", cache)).toBe("a_b_c");
    expect(sanitizeToolId("a:b|c", cache)).toBe("a_b_c");
    expect(cache.size).toBe(1);
  });
});
