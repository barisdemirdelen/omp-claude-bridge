// SDK→pi tool name/arg translation (the reverse of convert.ts's pi→SDK mapping).
// Ported from pi-claude-bridge verbatim.

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { MCP_TOOL_PREFIX } from "./skills.js";

export const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
};

export function mapToolName(
  name: string,
  customToolNameToPi?: Map<string, string>,
): string {
  const normalized = name.toLowerCase();
  const builtin = SDK_TO_PI_TOOL_NAME[normalized];
  if (builtin) return builtin;
  if (customToolNameToPi) {
    const mapped =
      customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
    if (mapped) return mapped;
  }
  if (normalized.startsWith(MCP_TOOL_PREFIX))
    return name.slice(MCP_TOOL_PREFIX.length);
  return name;
}

export const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: {
    file_path: "path",
    old_string: "oldText",
    new_string: "newText",
    old_text: "oldText",
    new_text: "newText",
  },
};

export function mapToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const input = args ?? {};
  const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key;
    if (!(piKey in result)) result[piKey] = value;
  }
  // Claude Code's bash defaults to a 120s timeout; omp's bash tool has no
  // default, so inject one to keep the two sides agreeing.
  if (toolName.toLowerCase() === "bash" && result.timeout == null) {
    result.timeout = 120;
  }
  return result;
}

export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};
