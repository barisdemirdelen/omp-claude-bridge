// AGENTS.md discovery and sanitization for forwarding to Claude Code.
// Ported from pi-claude-bridge with oh-my-pi paths (~/.omp/).

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const GLOBAL_AGENTS_PATH = join(homedir(), ".omp", "AGENTS.md");

export function resolveAgentsMdPath(): string | undefined {
  const fromCwd = findAgentsMdInParents(process.cwd());
  if (fromCwd) return fromCwd;
  if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
  return undefined;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function extractAgentsAppend(): string | undefined {
  const agentsPath = resolveAgentsMdPath();
  if (!agentsPath) return undefined;
  try {
    const content = readFileSync(agentsPath, "utf-8").trim();
    if (!content) return undefined;
    const sanitized = sanitizeAgentsContent(content);
    return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeAgentsContent(content: string): string {
  let sanitized = content;
  sanitized = sanitized.replace(/~\/\.omp\b/gi, "~/.claude");
  sanitized = sanitized.replace(/(^|[\s'"`])\.omp\//g, "$1.claude/");
  sanitized = sanitized.replace(/\b\.omp\b/gi, ".claude");
  sanitized = sanitized.replace(/\bomp\b/gi, "environment");
  return sanitized;
}
