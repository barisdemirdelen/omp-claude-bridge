import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  buildActionSummary,
  extractPath,
  formatToolAction,
  shortPath,
  type ToolCallState,
} from "../askclaude-ui.js";

const call = (name: string, rawInput?: unknown): ToolCallState => ({
  name,
  status: "complete",
  rawInput,
});

describe("formatToolAction", () => {
  test("labels file tools with a shortened path", () => {
    expect(formatToolAction(call("Read", { file_path: "/a/b/c/d.ts" }))).toBe(
      "Read(c/d.ts)",
    );
    expect(formatToolAction(call("Edit", { path: "x.ts" }))).toBe("Edit(x.ts)");
    expect(formatToolAction(call("Write", { file_path: "y.ts" }))).toBe(
      "Edit(y.ts)",
    );
  });

  test("labels search tools with their pattern", () => {
    expect(formatToolAction(call("Grep", { pattern: "foo.*bar" }))).toBe(
      "Grep(foo.*bar)",
    );
    expect(formatToolAction(call("Glob", { pattern: "**/*.ts" }))).toBe(
      "Glob(**/*.ts)",
    );
  });

  test("labels bash with the command snippet", () => {
    expect(formatToolAction(call("Bash", { command: "ls -la" }))).toBe(
      "Bash(ls -la)",
    );
  });

  test("suppresses noise tools", () => {
    expect(formatToolAction(call("BashOutput"))).toBeUndefined();
    expect(formatToolAction(call("AskClaude"))).toBeUndefined();
  });

  test("todo tools surface the active item", () => {
    expect(
      formatToolAction(
        call("TodoWrite", {
          todos: [
            { content: "done thing", status: "completed" },
            { content: "current thing", status: "in_progress" },
          ],
        }),
      ),
    ).toBe("current thing");
  });

  test("unknown tools fall back to their name", () => {
    expect(formatToolAction(call("WebSearch"))).toBe("WebSearch");
  });
});

describe("buildActionSummary", () => {
  test("joins actions and collapses consecutive same-tool calls to the latest", () => {
    const calls = new Map<string, ToolCallState>([
      ["1", call("Read", { file_path: "a.ts" })],
      ["2", call("Read", { file_path: "b.ts" })],
      ["3", call("Bash", { command: "bun test" })],
    ]);
    expect(buildActionSummary(calls)).toBe("Read(b.ts); Bash(bun test)");
  });

  test("returns empty string for no calls", () => {
    expect(buildActionSummary(new Map())).toBe("");
  });
});

describe("shortPath", () => {
  test("relativizes paths under cwd", () => {
    expect(shortPath(join(process.cwd(), "src", "x.ts"))).toBe("src/x.ts");
  });

  test("keeps last two segments of deep absolute paths", () => {
    expect(shortPath("/very/deep/nested/file.ts")).toBe("nested/file.ts");
  });

  test("leaves short and relative paths alone", () => {
    expect(shortPath("rel/file.ts")).toBe("rel/file.ts");
  });
});

describe("extractPath", () => {
  test("prefers file_path, then path, then command", () => {
    expect(extractPath({ file_path: "f", path: "p" })).toBe("f");
    expect(extractPath({ path: "p" })).toBe("p");
    expect(extractPath({ command: "c" })).toBe("c");
    expect(extractPath({})).toBeUndefined();
    expect(extractPath(null)).toBeUndefined();
  });
});
