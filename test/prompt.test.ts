import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import {
  TOOL_NAMING_CLARIFICATION,
  buildSystemPromptAppend,
  extractUserPrompt,
  extractUserPromptBlocks,
  toPromptArray,
} from "../prompt.js";

type Messages = Context["messages"];
const msgs = (...m: unknown[]) => m as Messages;

describe("extractUserPrompt", () => {
  test("returns the last message when it is a user string", () => {
    expect(extractUserPrompt(msgs({ role: "user", content: "ask" }))).toBe("ask");
  });

  test("accepts the developer role", () => {
    expect(extractUserPrompt(msgs({ role: "developer", content: "steer" }))).toBe(
      "steer",
    );
  });

  test("flattens text blocks", () => {
    expect(
      extractUserPrompt(
        msgs({
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        }),
      ),
    ).toBe("a\nb");
  });

  test("returns null when the last message is not user/developer", () => {
    expect(
      extractUserPrompt(
        msgs({ role: "user", content: "q" }, { role: "assistant", content: [] }),
      ),
    ).toBeNull();
    expect(extractUserPrompt(msgs())).toBeNull();
  });
});

describe("extractUserPromptBlocks", () => {
  test("returns null for pure-text content (string or blocks)", () => {
    expect(extractUserPromptBlocks(msgs({ role: "user", content: "text" }))).toBeNull();
    expect(
      extractUserPromptBlocks(
        msgs({ role: "user", content: [{ type: "text", text: "t" }] }),
      ),
    ).toBeNull();
  });

  test("returns anthropic blocks when an image is present", () => {
    const blocks = extractUserPromptBlocks(
      msgs({
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "BASE64", mimeType: "image/jpeg" },
        ],
      }),
    );
    expect(blocks).toEqual([
      { type: "text", text: "look at this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "BASE64" },
      },
    ]);
  });

  test("skips malformed image blocks", () => {
    expect(
      extractUserPromptBlocks(
        msgs({
          role: "user",
          content: [
            { type: "text", text: "t" },
            { type: "image", data: "", mimeType: "image/png" },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("buildSystemPromptAppend", () => {
  test("always includes the tool naming clarification", () => {
    const result = buildSystemPromptAppend(false, undefined);
    expect(result).toBe(TOOL_NAMING_CLARIFICATION);
  });

  test("appends the skills block when present in the system prompt", () => {
    const systemPrompt = [
      "preamble",
      "The following skills provide specialized instructions for specific tasks.",
      "<available_skills>skill-list</available_skills>",
      "postamble",
    ].join("\n");
    const result = buildSystemPromptAppend(true, systemPrompt)!;
    expect(result.startsWith(TOOL_NAMING_CLARIFICATION)).toBe(true);
    expect(result).toContain("<available_skills>skill-list</available_skills>");
    expect(result).not.toContain("postamble");
  });
});

describe("toPromptArray", () => {
  test("wraps a single string", () => {
    expect(toPromptArray("only")).toEqual(["only"]);
  });
  test("passes an array through unchanged", () => {
    expect(toPromptArray(["a", "b"])).toEqual(["a", "b"]);
  });
  test("returns [] for null/undefined", () => {
    expect(toPromptArray(null)).toEqual([]);
    expect(toPromptArray(undefined)).toEqual([]);
  });
  test("keeps an empty string as a single element", () => {
    expect(toPromptArray("")).toEqual([""]);
  });
});
