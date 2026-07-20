// Debug logging. CLAUDE_BRIDGE_DEBUG=1 enables a play-by-play in
// ~/.omp/agent/claude-bridge.log; structured dumps go to claude-bridge-diag.log.

import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
export const DEBUG_LOG_PATH =
  process.env.CLAUDE_BRIDGE_DEBUG_PATH ||
  join(homedir(), ".omp", "agent", "claude-bridge.log");
export const DIAG_LOG_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "claude-bridge-diag.log",
);

if (DEBUG) {
  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
  } catch {
    // If directory creation fails, debug functions will throw on first use
  }
}

export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

export function debug(...args: unknown[]) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error)
      return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
    return JSON.stringify(a);
  };
  const msg = args.map(fmt).join(" ");
  appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

let nextCliDebugSeq = 1;
export function makeCliDebugOptions(
  tag: string,
): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
  if (!DEBUG) return {};
  const seq = nextCliDebugSeq++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
  debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
  return {
    debug: true,
    debugFile,
    stderr: (data: string) => {
      for (const line of data.split(/\r?\n/)) {
        if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
      }
    },
  };
}

export function diagDump(label: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const entry = { ts, moduleInstanceId, label, ...data };
  appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
  debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}
