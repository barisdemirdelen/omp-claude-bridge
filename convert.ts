// Pure pi→Anthropic message conversion helpers.
// Ported from pi-claude-bridge verbatim.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";

export const PROVIDER_ID = "claude-bridge";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);
  if (existing) return existing;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  cache.set(id, clean);
  return clean;
}

export function mapPiToolNameToSdk(
  name: string,
  customToolNameToSdk?: Map<string, string>,
): string {
  if (!name) return "";
  const normalized = name.toLowerCase();
  if (customToolNameToSdk) {
    const mapped =
      customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
    if (mapped) return mapped;
  }
  if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
  return pascalCase(name);
}

export function messageContentToText(
  content:
    | string
    | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let hasText = false;
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
      hasText = true;
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${block.type}]`);
    }
  }
  return hasText ? parts.join("\n") : "";
}

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
  messages: PiMessage[],
  customToolNameToSdk?: Map<string, string>,
): {
  anthropicMessages: SessionMessage[];
  sanitizedIds: Map<string, string>;
} {
  const anthropicMessages: SessionMessage[] = [];
  const sanitizedIds = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({
          role: "user",
          content: msg.content,
          ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
        } as SessionMessage);
      } else if (Array.isArray(msg.content)) {
        const blocks = msg.content
          .map((b: any) => {
            if (b.type === "text" && b.text)
              return { type: "text", text: b.text };
            if (b.type === "image" && b.data && b.mimeType)
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: b.mimeType,
                  data: b.data,
                },
              };
            return null;
          })
          .filter(Boolean);
        anthropicMessages.push({
          role: "user",
          content: blocks,
          ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
        } as SessionMessage);
      }
    } else if (msg.role === "assistant") {
      const blocks = msg.content
        .map((b: any) => {
          if (b.type === "text" && b.text) {
            return { type: "text", text: b.text };
          } else if (b.type === "thinking") {
            const sig = b.thinkingSignature;
            const isAnthropicProvider =
              msg.provider === PROVIDER_ID || msg.api === "anthropic";
            if (isAnthropicProvider && sig) {
              return {
                type: "thinking",
                thinking: b.thinking ?? "",
                signature: sig,
              };
            }
            return null;
          } else if (b.type === "toolCall" && b.name) {
            const cleanId = sanitizeToolId(b.id, sanitizedIds);
            return {
              type: "tool_use",
              id: cleanId,
              name: mapPiToolNameToSdk(b.name, customToolNameToSdk),
              input: b.arguments ?? {},
            };
          }
          return null;
        })
        .filter(Boolean);
      if (blocks.length > 0) {
        anthropicMessages.push({
          role: "assistant",
          content: blocks,
          ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
        } as SessionMessage);
      }
    } else if (msg.role === "toolResult") {
      const cleanId = msg.toolCallId
        ? sanitizeToolId(msg.toolCallId, sanitizedIds)
        : undefined;
      if (cleanId) {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((b: any) =>
                    b.type === "text" && b.text ? b.text : `[${b.type}]`,
                  )
                  .join("\n")
              : "";
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: cleanId,
              content,
              ...(msg.isError ? { is_error: true } : {}),
            },
          ],
          ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
        } as SessionMessage);
      }
    }
  }

  return { anthropicMessages, sanitizedIds };
}
