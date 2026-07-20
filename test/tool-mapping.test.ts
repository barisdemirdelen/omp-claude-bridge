import { describe, expect, test } from "bun:test";
import { mapToolArgs, mapToolName } from "../tool-mapping.js";

describe("mapToolName", () => {
  test("maps SDK built-ins to pi names case-insensitively", () => {
    expect(mapToolName("Read")).toBe("read");
    expect(mapToolName("Edit")).toBe("edit");
    expect(mapToolName("BASH")).toBe("bash");
  });

  test("prefers the custom tool map over prefix stripping", () => {
    const map = new Map([["mcp__custom-tools__grep", "grep"]]);
    expect(mapToolName("mcp__custom-tools__grep", map)).toBe("grep");
  });

  test("strips the custom-tools MCP prefix when unmapped", () => {
    expect(mapToolName("mcp__custom-tools__mytool")).toBe("mytool");
  });

  test("passes unknown names through", () => {
    expect(mapToolName("WebSearch")).toBe("WebSearch");
  });
});

describe("mapToolArgs", () => {
  test("renames Claude file/edit keys to omp names", () => {
    expect(
      mapToolArgs("Edit", {
        file_path: "a.ts",
        old_string: "x",
        new_string: "y",
      }),
    ).toEqual({ path: "a.ts", oldText: "x", newText: "y" });
    expect(mapToolArgs("read", { file_path: "b.ts" })).toEqual({
      path: "b.ts",
    });
  });

  test("keeps first value when rename collides with existing key", () => {
    expect(mapToolArgs("edit", { path: "keep.ts", file_path: "clobber.ts" }))
      .toEqual({ path: "keep.ts" });
  });

  test("injects the 120s default timeout for bash only when absent", () => {
    expect(mapToolArgs("Bash", { command: "ls" })).toEqual({
      command: "ls",
      timeout: 120,
    });
    expect(mapToolArgs("Bash", { command: "ls", timeout: 5 })).toEqual({
      command: "ls",
      timeout: 5,
    });
    expect(mapToolArgs("read", { path: "x" })).not.toHaveProperty("timeout");
  });

  test("handles undefined args", () => {
    expect(mapToolArgs("Bash", undefined)).toEqual({ timeout: 120 });
  });
});
