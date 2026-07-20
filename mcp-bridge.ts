// Exposing omp/custom tools to Claude Code as MCP tools, and routing
// tool results back to the owning query context.
// Ported from pi-claude-bridge verbatim.

import type { Context, Tool } from "@earendil-works/pi-ai";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { debug } from "./debug.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import type { McpResult } from "./extract-tool-results.js";
import type { QueryContext } from "./query-state.js";

export interface ResolvedMcpTools {
  mcpTools: Tool[];
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
}

export function resolveMcpTools(
  context: Context,
  excludeToolName?: string,
): ResolvedMcpTools {
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

export function contextForToolResults(
  results: McpResult[],
  contexts: Iterable<QueryContext>,
): QueryContext | undefined {
  for (const result of results) {
    const id = result.toolCallId;
    if (!id) continue;
    for (const queryCtx of contexts) {
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

export function buildMcpServers(
  tools: Tool[],
  queryCtx: QueryContext,
): Record<string, McpSdkServerConfigWithInstance> | undefined {
  if (!tools.length) return undefined;
  const mcpTools = tools.map((tool) => ({
    name: tool.name.startsWith("mcp__")
      ? tool.name.slice("mcp__".length)
      : tool.name,
    description: tool.description,
    inputSchema: jsonSchemaToZodShape(tool.parameters),
    handler: async () => {
      const toolCallId = queryCtx.turnToolCallIds[queryCtx.nextHandlerIdx++];
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
