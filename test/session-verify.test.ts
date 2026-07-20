import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { verifyWrittenSession } from "../session-verify.js";

function jsonl(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-verify-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

describe("verifyWrittenSession", () => {
  test("passes a consistent file", () => {
    const path = jsonl([
      { sessionId: "s1", type: "user" },
      { sessionId: "s1", type: "assistant" },
    ]);
    expect(verifyWrittenSession(path, "s1", 2)).toEqual([]);
  });

  test("reports a missing file", () => {
    const warnings = verifyWrittenSession("/nonexistent/x.jsonl", "s1", 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("file missing after save");
  });

  test("reports a record count mismatch", () => {
    const path = jsonl([{ sessionId: "s1" }]);
    const warnings = verifyWrittenSession(path, "s1", 3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("record count mismatch");
    expect(warnings[0]).toContain("expected=3");
    expect(warnings[0]).toContain("actual=1");
  });

  test("reports sessionId drift on first or last record", () => {
    const path = jsonl([{ sessionId: "s1" }, { sessionId: "other" }]);
    const warnings = verifyWrittenSession(path, "s1", 2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sessionId drift");
  });

  test("reports malformed JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-verify-"));
    const path = join(dir, "bad.jsonl");
    writeFileSync(path, "{broken\n");
    const warnings = verifyWrittenSession(path, "s1", 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed JSONL");
  });
});
