// Shared mutable bridge state, previously scattered module-level globals in
// index.ts. Constructed once at extension registration and threaded into the
// provider and AskClaude factories.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import type { LongContextSettings } from "./models.js";
import { SessionStore } from "./session-store.js";

export interface BridgeRuntime {
  providerSettings: NonNullable<Config["provider"]>;
  longContextSettings: LongContextSettings;
  sessions: SessionStore;
  ui: ExtensionUIContext | null;
  askClaudeToolName: string;
  /** Cached because oh-my-pi's CustomToolContext lacks getSystemPrompt. */
  cachedSystemPrompt: string[];
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
  };
  return runtime;
}
