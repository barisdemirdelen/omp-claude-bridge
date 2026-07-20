// Shared mutable bridge state, previously scattered module-level globals in
// index.ts. Constructed once at extension registration and threaded into the
// provider and AskClaude factories.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { LongContextSettings } from "./models.js";
import { SessionStore } from "./session-store.js";

/** The Claude Agent SDK `query` entry point; injectable so provider.ts and
 *  askclaude.ts orchestration can be driven by a scripted fake in tests. */
export type QueryFn = typeof query;

export interface BridgeRuntime {
  providerSettings: NonNullable<Config["provider"]>;
  longContextSettings: LongContextSettings;
  sessions: SessionStore;
  ui: ExtensionUIContext | null;
  askClaudeToolName: string;
  /** Cached because oh-my-pi's CustomToolContext lacks getSystemPrompt. */
  cachedSystemPrompt: string[];
  queryFn: QueryFn;
}

export function createRuntime(): BridgeRuntime {
  const runtime: BridgeRuntime = {
    providerSettings: {},
    longContextSettings: { plan: "pro", longContextExtraUsage: false },
    sessions: new SessionStore((message, level) =>
      runtime.ui?.notify(message, level),
    ),
    ui: null,
    askClaudeToolName: "AskClaude",
    cachedSystemPrompt: [],
    queryFn: query,
  };
  return runtime;
}
