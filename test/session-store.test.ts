import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Context } from "@earendil-works/pi-ai";
import { getSessionPath } from "cc-session-io";
import { SessionStore } from "../session-store.js";

type Messages = Context["messages"];

const user = (text: string) =>
  ({ role: "user", content: text, timestamp: Date.now() }) as Messages[number];
const assistant = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }) as Messages[number];

let claudeDir: string;
let projectDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "cb-claude-"));
  projectDir = mkdtempSync(join(tmpdir(), "cb-project-"));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("SessionStore.sync", () => {
  test("clean start (no prior messages) creates no session", () => {
    const store = new SessionStore();
    const result = store.sync([user("hi")] as Messages, projectDir);
    expect(result).toEqual({ sessionId: null });
    expect(store.current).toBeNull();
  });

  test("first sync with priors writes a session file and sets the cursor", () => {
    const store = new SessionStore();
    const messages = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const { sessionId } = store.sync(messages, projectDir);
    expect(sessionId).toBeTruthy();
    expect(store.current?.cursor).toBe(2);

    const jsonlPath = getSessionPath(sessionId!, projectDir, claudeDir);
    expect(existsSync(jsonlPath)).toBe(true);
    const records = readFileSync(jsonlPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(records.every((r) => r.sessionId === sessionId)).toBe(true);
  });

  test("reuses the session when no messages were missed", () => {
    const store = new SessionStore();
    const messages = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const first = store.sync(messages, projectDir);
    const second = store.sync(messages, projectDir);
    expect(second.sessionId).toBe(first.sessionId);
  });

  test("advances the cursor past a single trailing assistant message", () => {
    const store = new SessionStore();
    const turn1 = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const { sessionId } = store.sync(turn1, projectDir);
    // Query completed: CC wrote the answer itself, cursor now covers turn1.
    store.commit(sessionId!, 3, projectDir);

    const turn2 = [
      user("q1"),
      assistant("a1"),
      user("q2"),
      assistant("a2"),
      user("q3"),
    ] as Messages;
    const result = store.sync(turn2, projectDir);
    expect(result.sessionId).toBe(sessionId);
    expect(store.current?.cursor).toBe(4);
  });

  test("shorter context preserves the shared session and starts clean", () => {
    const store = new SessionStore();
    const messages = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const { sessionId } = store.sync(messages, projectDir);
    store.commit(sessionId!, 3, projectDir);

    const shorter = [user("isolated")] as Messages;
    const result = store.sync(shorter, projectDir);
    expect(result).toEqual({ sessionId: null, preserveSharedSession: true });
    expect(store.current?.sessionId).toBe(sessionId!);
  });

  test("missed messages rebuild the session keeping the same id", () => {
    const store = new SessionStore();
    const turn1 = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const { sessionId } = store.sync(turn1, projectDir);

    const withMissed = [
      user("q1"),
      assistant("a1"),
      user("q2"),
      assistant("a2"),
      user("steer"),
      assistant("a3"),
      user("q3"),
    ] as Messages;
    const result = store.sync(withMissed, projectDir);
    expect(result.sessionId).toBe(sessionId);
    expect(store.current?.cursor).toBe(6);

    const jsonlPath = getSessionPath(sessionId!, projectDir, claudeDir);
    const lines = readFileSync(jsonlPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  test("markRebuild forces a rebuild on the next sync with the same id", () => {
    const store = new SessionStore();
    const messages = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const { sessionId } = store.sync(messages, projectDir);
    store.markRebuild();
    const result = store.sync(messages, projectDir);
    expect(result.sessionId).toBe(sessionId);
    expect(store.current?.needsRebuild).toBeUndefined();
  });

  test("markAborted rotates the session id on rebuild", () => {
    const store = new SessionStore();
    const messages = [user("q1"), assistant("a1"), user("q2")] as Messages;
    const { sessionId: originalId } = store.sync(messages, projectDir);
    store.markAborted();
    const result = store.sync(messages, projectDir);
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).not.toBe(originalId);
  });
});

describe("SessionStore state transitions", () => {
  test("clear resets, commit replaces, advanceCursor moves forward", () => {
    const store = new SessionStore();
    store.commit("abc", 5, projectDir);
    expect(store.current).toEqual({ sessionId: "abc", cursor: 5, cwd: projectDir });
    store.advanceCursor(9);
    expect(store.current?.cursor).toBe(9);
    store.clear();
    expect(store.current).toBeNull();
  });

  test("advanceCursor and marks are no-ops without a session", () => {
    const store = new SessionStore();
    store.advanceCursor(3);
    store.markRebuild();
    store.markAborted();
    expect(store.current).toBeNull();
  });
});
