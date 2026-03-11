// Re-export public hook types from the SDK package (single source of truth)
export type {
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforePromptBuildEvent,
  SessionStartEvent,
  SessionEndEvent,
  MessageReceiveEvent,
  ResponseBeforeEvent,
  ResponseAfterEvent,
  ResponseErrorEvent,
  ToolErrorEvent,
  PromptAfterEvent,
  AgentStartEvent,
  AgentStopEvent,
  HookHandlerMap,
  HookName,
} from "@teleclaw-agent/sdk";

import type { HookName, HookHandlerMap } from "@teleclaw-agent/sdk";

// ── Internal types (not part of public SDK) ──

/**
 * Hook registration entry.
 *
 * Priority ranges (convention):
 *   -100 to -1  : Security gates, auth checks, spam filters
 *       0       : Default — standard plugin logic
 *    1 to 49    : Post-processing, enrichment
 *   50 to 99    : Audit, logging, observability
 *   100+        : Reserved — always-last guarantees
 */
export interface HookRegistration<K extends HookName = HookName> {
  pluginId: string;
  hookName: K;
  handler: HookHandlerMap[K];
  priority: number;
  /** Plugin-level priority offset (from plugin_config DB table). Default 0. */
  globalPriority: number;
}

export interface HookRunnerOptions {
  logger: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
  timeoutMs?: number;
  catchErrors?: boolean;
}
