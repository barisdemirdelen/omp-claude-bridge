import { describe, expect, test } from "bun:test";
import { extractSkillsBlock, rewriteSkillsBlock } from "../skills.js";

const SKILLS_PROMPT = [
  "You are a coding agent.",
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when relevant.",
  "<available_skills>",
  "- pdf-tools",
  "</available_skills>",
  "More instructions after.",
].join("\n");

describe("extractSkillsBlock", () => {
  test("extracts from start marker through closing tag", () => {
    const block = extractSkillsBlock(SKILLS_PROMPT)!;
    expect(block.startsWith("The following skills provide")).toBe(true);
    expect(block.endsWith("</available_skills>")).toBe(true);
    expect(block).toContain("- pdf-tools");
    expect(block).not.toContain("More instructions after");
  });

  test("rewrites the read-tool reference to the MCP name", () => {
    expect(extractSkillsBlock(SKILLS_PROMPT)).toContain(
      "Use the read tool (mcp__custom-tools__read) to load a skill's file",
    );
  });

  test("returns undefined when markers are missing or prompt is empty", () => {
    expect(extractSkillsBlock(undefined)).toBeUndefined();
    expect(extractSkillsBlock("no skills here")).toBeUndefined();
    expect(
      extractSkillsBlock(
        "The following skills provide specialized instructions for specific tasks. but never closes",
      ),
    ).toBeUndefined();
  });
});

describe("rewriteSkillsBlock", () => {
  test("leaves blocks without the read-tool sentence unchanged", () => {
    expect(rewriteSkillsBlock("plain block")).toBe("plain block");
  });
});
