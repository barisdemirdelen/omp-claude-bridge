import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractAgentsAppend,
  findAgentsMdInParents,
  sanitizeAgentsContent,
} from "../agents-md.js";

describe("sanitizeAgentsContent", () => {
  test("rewrites ~/.omp to ~/.claude", () => {
    expect(sanitizeAgentsContent("logs in ~/.omp/agent/foo.log")).toBe(
      "logs in ~/.claude/agent/foo.log",
    );
  });

  test("rewrites relative .omp/ dirs to .claude/", () => {
    expect(sanitizeAgentsContent("see .omp/claude-bridge.json")).toBe(
      "see .claude/claude-bridge.json",
    );
    expect(sanitizeAgentsContent("in '.omp/config' file")).toBe(
      "in '.claude/config' file",
    );
  });

  test("rewrites the bare word omp but not words containing it", () => {
    expect(sanitizeAgentsContent("run omp to start")).toBe(
      "run environment to start",
    );
    expect(sanitizeAgentsContent("prompt and compare")).toBe(
      "prompt and compare",
    );
  });
});

describe("findAgentsMdInParents", () => {
  test("finds AGENTS.md walking up from a nested dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "# notes");
      const nested = join(root, "a", "b");
      // findAgentsMdInParents only reads; the nested dir need not exist on disk
      expect(findAgentsMdInParents(nested)).toBe(join(root, "AGENTS.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractAgentsAppend", () => {
  test("wraps sanitized content under a CLAUDE.md heading", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    const prevCwd = process.cwd();
    try {
      writeFileSync(join(root, "AGENTS.md"), "Config lives in .omp/agent.");
      process.chdir(root);
      expect(extractAgentsAppend()).toBe(
        "# CLAUDE.md\n\nConfig lives in .claude/agent.",
      );
    } finally {
      process.chdir(prevCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns undefined for an empty AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    const prevCwd = process.cwd();
    try {
      writeFileSync(join(root, "AGENTS.md"), "   \n  ");
      process.chdir(root);
      expect(extractAgentsAppend()).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
