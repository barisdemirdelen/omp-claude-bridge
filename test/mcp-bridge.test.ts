import { describe, expect, test } from "bun:test";
import type { Context, Tool } from "@earendil-works/pi-ai";
import {
  buildMcpServers,
  contextForToolResults,
  resolveMcpTools,
} from "../mcp-bridge.js";
import { QueryContext } from "../query-state.js";
import type { McpResult } from "../extract-tool-results.js";

const tool = (name: string): Tool =>
  ({
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  }) as unknown as Tool;

const contextWith = (...tools: Tool[]) => ({ tools }) as unknown as Context;

describe("resolveMcpTools", () => {
  test("builds two-way name maps with the custom-tools prefix", () => {
    const { mcpTools, customToolNameToSdk, customToolNameToPi } =
      resolveMcpTools(contextWith(tool("grep"), tool("MyTool")));
    expect(mcpTools.map((t) => t.name)).toEqual(["grep", "MyTool"]);
    expect(customToolNameToSdk.get("grep")).toBe("mcp__custom-tools__grep");
    expect(customToolNameToSdk.get("MyTool")).toBe("mcp__custom-tools__MyTool");
    expect(customToolNameToSdk.get("mytool")).toBe("mcp__custom-tools__MyTool");
    expect(customToolNameToPi.get("mcp__custom-tools__grep")).toBe("grep");
    expect(customToolNameToPi.get("mcp__custom-tools__mytool")).toBe("MyTool");
  });

  test("strips one mcp__ layer from already-prefixed external MCP tools", () => {
    const { customToolNameToSdk, customToolNameToPi } = resolveMcpTools(
      contextWith(tool("mcp__linear_search")),
    );
    expect(customToolNameToSdk.get("mcp__linear_search")).toBe(
      "mcp__custom-tools__linear_search",
    );
    expect(customToolNameToPi.get("mcp__custom-tools__linear_search")).toBe(
      "mcp__linear_search",
    );
  });

  test("excludes the AskClaude tool and handles missing tools", () => {
    const { mcpTools } = resolveMcpTools(
      contextWith(tool("read"), tool("AskClaude")),
      "AskClaude",
    );
    expect(mcpTools.map((t) => t.name)).toEqual(["read"]);
    expect(resolveMcpTools({} as Context).mcpTools).toEqual([]);
  });
});

describe("contextForToolResults", () => {
  const result = (toolCallId: string): McpResult => ({
    content: [{ type: "text", text: "r" }],
    toolCallId,
  });

  test("finds the context owning the tool call id", () => {
    const a = new QueryContext();
    const b = new QueryContext();
    b.turnToolCallIds = ["tc9"];
    expect(contextForToolResults([result("tc9")], [a, b])).toBe(b);
  });

  test("matches pending calls and queued results too", () => {
    const c = new QueryContext();
    c.pendingToolCalls.set("waiting", { toolName: "x", resolve: () => {} });
    expect(contextForToolResults([result("waiting")], [c])).toBe(c);

    const d = new QueryContext();
    d.pendingResults.set("queued", result("queued"));
    expect(contextForToolResults([result("queued")], [d])).toBe(d);
  });

  test("returns undefined when nothing matches", () => {
    expect(contextForToolResults([result("nope")], [new QueryContext()])).toBeUndefined();
    expect(
      contextForToolResults([{ content: [{ type: "text", text: "" }] }], [new QueryContext()]),
    ).toBeUndefined();
  });
});

describe("buildMcpServers", () => {
  test("returns undefined for no tools and a custom-tools server otherwise", () => {
    expect(buildMcpServers([], new QueryContext())).toBeUndefined();
    const servers = buildMcpServers([tool("grep")], new QueryContext());
    expect(servers).toHaveProperty("custom-tools");
  });
});
