// Last-user-prompt extraction and system-prompt-append assembly.
// Ported from pi-claude-bridge verbatim (extractUserPrompt/Blocks/wrapPromptStream).

import type { Context } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources";
import { debug } from "./debug.js";
import { messageContentToText } from "./convert.js";
import { extractAgentsAppend } from "./agents-md.js";
import { extractSkillsBlock } from "./skills.js";

// Claude Code otherwise gets confused about whether mcp__custom-tools__read etc.
// are "real" tools distinct from its built-ins.
export const TOOL_NAMING_CLARIFICATION =
  "Your Read, Write, Edit, Bash, Grep, and Glob tools (and all other tools) are exposed as MCP functions with an `mcp__custom-tools__` prefix (e.g. `mcp__custom-tools__edit` IS your Edit tool, `mcp__custom-tools__bash` IS your Bash tool). There is no separate built-in tool alongside them — always call the `mcp__custom-tools__*` function from your tool list.";

// pi-ai user content blocks, structurally (published types are a union that
// varies by message role; the fields we read are stable at runtime).
interface ContentBlockLike {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export function extractUserPrompt(messages: Context["messages"]): string | null {
  const last = messages[messages.length - 1];
  // pi-ai's published Message role union omits "developer", which oh-my-pi's
  // runtime does send; role is a plain string at runtime regardless.
  const lastRole = last?.role as string | undefined;
  if (!last || (lastRole !== "user" && lastRole !== "developer")) return null;
  if (typeof last.content === "string") return last.content;
  return messageContentToText(last.content) || "";
}

export function extractUserPromptBlocks(
  messages: Context["messages"],
): ContentBlockParam[] | null {
  const last = messages[messages.length - 1];
  const lastRole = last?.role as string | undefined;
  if (!last || (lastRole !== "user" && lastRole !== "developer")) return null;
  if (typeof last.content === "string") {
    debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
    return null;
  }
  if (!Array.isArray(last.content)) {
    debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
    return null;
  }
  const content = last.content as ContentBlockLike[];
  debug(
    `extractUserPromptBlocks: ${content.length} blocks, types=${content.map((b) => b.type).join(",")}`,
  );
  let hasImage = false;
  const blocks: ContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      debug(
        `image block: mimeType=${block.mimeType}, data length=${(block.data ?? "").length}, keys=${Object.keys(block).join(",")}`,
      );
      if (!block.data || !block.mimeType) {
        debug(`image block missing data or mimeType, skipping`);
        continue;
      }
      hasImage = true;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType as Base64ImageSource["media_type"],
          data: block.data,
        },
      });
    }
  }
  return hasImage ? blocks : null;
}

export async function* wrapPromptStream(
  blocks: ContentBlockParam[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: blocks } as MessageParam,
    parent_tool_use_id: null,
  };
}

/** Assemble the system-prompt append: tool-naming clarification + AGENTS.md + skills. */
export function buildSystemPromptAppend(
  appendSystemPrompt: boolean,
  systemPromptStr: string | undefined,
): string | undefined {
  const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
  const skillsAppend = appendSystemPrompt
    ? extractSkillsBlock(systemPromptStr)
    : undefined;
  const appendParts = [
    TOOL_NAMING_CLARIFICATION,
    agentsAppend,
    skillsAppend,
  ].filter((part): part is string => Boolean(part));
  return appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
}
