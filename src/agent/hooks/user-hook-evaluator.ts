/**
 * UserHookEvaluator — keyword blocklist + context injection triggers.
 * Hot-reloadable: call reload() after DB changes, no restart needed.
 */

import type Database from "better-sqlite3";
import { getBlocklistConfig, getTriggersConfig } from "./user-hook-store.js";

export interface UserHookResult {
  blocked: boolean;
  blockMessage?: string;
  additionalContext: string;
}

/** Strip zero-width characters that could bypass keyword matching */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;

/** Tokenize on whitespace and punctuation */
const TOKEN_SPLIT_RE = /[\s,.!?;:'"()\[\]{}<>/\\|@#$%^&*+=~`]+/;

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKC").replace(ZERO_WIDTH_RE, "");
}

function tokenize(text: string): string[] {
  return normalize(text).split(TOKEN_SPLIT_RE).filter(Boolean);
}

/**
 * Check if a multi-word keyword (as token array) appears as a sliding window in message tokens.
 */
function matchesMultiWord(messageTokens: string[], keywordTokens: string[]): boolean {
  if (keywordTokens.length > messageTokens.length) return false;
  for (let i = 0; i <= messageTokens.length - keywordTokens.length; i++) {
    let match = true;
    for (let j = 0; j < keywordTokens.length; j++) {
      if (messageTokens[i + j] !== keywordTokens[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export class UserHookEvaluator {
  private blocklistEnabled = false;
  private singleKeywords = new Set<string>();
  private multiKeywords: string[][] = [];
  private blockMessage = "";
  private triggers: Array<{
    id: string;
    keyword: string;
    keywordTokens: string[];
    context: string;
    enabled: boolean;
  }> = [];

  constructor(private db: Database.Database) {
    this.reload();
  }

  /** Reload config from DB — called on startup and after WebUI changes */
  reload(): void {
    const blocklist = getBlocklistConfig(this.db);
    this.blocklistEnabled = blocklist.enabled;
    this.blockMessage = blocklist.message;

    this.singleKeywords.clear();
    this.multiKeywords = [];
    for (const kw of blocklist.keywords) {
      const tokens = tokenize(kw);
      if (tokens.length === 0) continue;
      if (tokens.length === 1) {
        this.singleKeywords.add(tokens[0]);
      } else {
        this.multiKeywords.push(tokens);
      }
    }

    const triggers = getTriggersConfig(this.db);
    this.triggers = triggers.map((t) => ({
      ...t,
      keywordTokens: tokenize(t.keyword),
    }));
  }

  /** Evaluate a message — returns { blocked, blockMessage, additionalContext } */
  evaluate(text: string): UserHookResult {
    const tokens = tokenize(text);

    // Check blocklist
    if (this.blocklistEnabled) {
      // Single-word check
      for (const token of tokens) {
        if (this.singleKeywords.has(token)) {
          return {
            blocked: true,
            blockMessage: this.blockMessage || undefined,
            additionalContext: "",
          };
        }
      }
      // Multi-word check
      for (const kwTokens of this.multiKeywords) {
        if (matchesMultiWord(tokens, kwTokens)) {
          return {
            blocked: true,
            blockMessage: this.blockMessage || undefined,
            additionalContext: "",
          };
        }
      }
    }

    // Check context triggers
    const contexts: string[] = [];
    const seen = new Set<string>();
    for (const trigger of this.triggers) {
      if (!trigger.enabled || trigger.keywordTokens.length === 0) continue;
      const matched =
        trigger.keywordTokens.length === 1
          ? tokens.includes(trigger.keywordTokens[0])
          : matchesMultiWord(tokens, trigger.keywordTokens);
      if (matched && !seen.has(trigger.context)) {
        seen.add(trigger.context);
        contexts.push(trigger.context);
      }
    }

    return {
      blocked: false,
      additionalContext: contexts.join("\n\n"),
    };
  }
}
