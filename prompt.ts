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
// are "real" tools distinct from its built-ins. We deliberately do NOT enumerate
// the tool list here — the model already sees its tools in the system prompt, so
// re-listing them is redundant double-prompting. And the mapping example uses a
// `<name>` placeholder rather than a concrete tool (e.g. `edit`): naming a
// specific tool would assert it exists, the exact phantom claim that confuses a
// restricted agent (a read-only scout has no edit tool). Two truthful statements
// cover every agent type: the prefix-mapping rule, and absence-is-policy (so a
// missing tool reads as intentional restriction, not harness breakage).
export const TOOL_NAMING_CLARIFICATION =
  "Your tools are exposed as MCP functions under an `mcp__custom-tools__` prefix — a function named `mcp__custom-tools__<name>` IS your `<name>` tool, with no separate built-in tool alongside it, so always call tools by their `mcp__custom-tools__*` names from your tool list. Any tool not in that list is intentionally unavailable for your role — its absence is policy, not breakage, so do not try to route around it.";

/** Normalize a system-prompt value to string[]. oh-my-pi's runtime returns
 *  `string[]` from getSystemPrompt()/Context.systemPrompt even though the
 *  published pi-ai type says `string`; accept both so an upstream type change
 *  in either direction doesn't break the bridge. */
export function toPromptArray(
  value: string | string[] | null | undefined,
): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

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

// The subagent system prompt (oh-my-pi's subagent-system-prompt.md) is composed
// by the harness as a distinct system-prompt array element that opens with a
// `ROLE\n===` header and always carries a `COMPLETION\n===` section. Match both
// so a generic main-session preset element is never mistaken for it.
const SUBAGENT_ROLE_HEADER = /^ROLE\n=+/;
const SUBAGENT_COMPLETION_HEADER = /\nCOMPLETION\n=+/;

/** Find the harness's subagent system-prompt element (ROLE / COOP / COMPLETION,
 *  including the pinned yield schema) so it survives the bridge translation
 *  instead of being dropped in favor of the generic Claude Code preset. */
export function extractSubagentPrompt(
  promptArray: string[],
): string | undefined {
  for (const element of promptArray) {
    const trimmed = element.trimStart();
    if (
      SUBAGENT_ROLE_HEADER.test(trimmed) &&
      SUBAGENT_COMPLETION_HEADER.test(trimmed)
    ) {
      return element.trim() || undefined;
    }
  }
  return undefined;
}

/** Assemble the system-prompt append: tool-naming clarification +
 *  subagent system prompt (if any) + AGENTS.md + skills. */
export function buildSystemPromptAppend(
  appendSystemPrompt: boolean,
  systemPrompt: string | string[] | undefined,
): string | undefined {
  const promptArray = toPromptArray(systemPrompt);
  const subagentAppend = extractSubagentPrompt(promptArray);
  const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
  const skillsAppend = appendSystemPrompt
    ? extractSkillsBlock(promptArray.join("\n\n"))
    : undefined;
  const appendParts = [
    TOOL_NAMING_CLARIFICATION,
    subagentAppend,
    agentsAppend,
    skillsAppend,
  ].filter((part): part is string => Boolean(part));
  return appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
}
