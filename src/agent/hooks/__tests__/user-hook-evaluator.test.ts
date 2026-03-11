import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { ensureSchema } from "../../../memory/schema.js";
import { setBlocklistConfig, setTriggersConfig } from "../user-hook-store.js";
import { UserHookEvaluator } from "../user-hook-evaluator.js";

describe("UserHookEvaluator", () => {
  let db: InstanceType<typeof Database>;
  let evaluator: UserHookEvaluator;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    evaluator = new UserHookEvaluator(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Blocklist ──────────────────────────────────────────────────────

  describe("Keyword Blocklist", () => {
    it("blocks message when keyword matches (word boundary)", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      const result = evaluator.evaluate("is this a scam?");
      expect(result.blocked).toBe(true);
    });

    it("does NOT match substring (Scunthorpe safe)", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      expect(evaluator.evaluate("let me examine this").blocked).toBe(false);
      expect(evaluator.evaluate("scammer alert").blocked).toBe(false);
    });

    it("matches case-insensitively", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      expect(evaluator.evaluate("SCAM alert").blocked).toBe(true);
      expect(evaluator.evaluate("Scam").blocked).toBe(true);
    });

    it("matches despite punctuation", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      expect(evaluator.evaluate("scam!").blocked).toBe(true);
      expect(evaluator.evaluate("(scam)").blocked).toBe(true);
    });

    it("does not block when disabled", () => {
      setBlocklistConfig(db, { enabled: false, keywords: ["scam"], message: "" });
      evaluator.reload();
      expect(evaluator.evaluate("scam").blocked).toBe(false);
    });

    it("returns block message when configured", () => {
      setBlocklistConfig(db, {
        enabled: true,
        keywords: ["scam"],
        message: "Nope.",
      });
      evaluator.reload();
      const result = evaluator.evaluate("scam?");
      expect(result.blocked).toBe(true);
      expect(result.blockMessage).toBe("Nope.");
    });

    it("handles multi-word keywords", () => {
      setBlocklistConfig(db, {
        enabled: true,
        keywords: ["crypto hack"],
        message: "",
      });
      evaluator.reload();
      expect(evaluator.evaluate("tell me about crypto hack").blocked).toBe(true);
      expect(evaluator.evaluate("crypto is great").blocked).toBe(false);
      expect(evaluator.evaluate("hack the planet").blocked).toBe(false);
    });

    it("strips zero-width characters before matching", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      // Insert zero-width space in the middle
      expect(evaluator.evaluate("sc\u200Bam").blocked).toBe(true);
    });

    it("handles NFKC normalization (fullwidth chars)", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      // Fullwidth "ｓｃａｍ" normalizes to "scam"
      expect(evaluator.evaluate("\uFF53\uFF43\uFF41\uFF4D").blocked).toBe(true);
    });
  });

  // ── Context Triggers ───────────────────────────────────────────────

  describe("Context Triggers", () => {
    it("injects context when trigger keyword matches", () => {
      setTriggersConfig(db, [
        { id: "1", keyword: "alpha", context: "Project Alpha info", enabled: true },
      ]);
      evaluator.reload();
      const result = evaluator.evaluate("tell me about alpha");
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBe("Project Alpha info");
    });

    it("injects multiple contexts when multiple triggers match", () => {
      setTriggersConfig(db, [
        { id: "1", keyword: "alpha", context: "Project Alpha info", enabled: true },
        { id: "2", keyword: "budget", context: "Budget details", enabled: true },
      ]);
      evaluator.reload();
      const result = evaluator.evaluate("what's the alpha budget?");
      expect(result.additionalContext).toContain("Project Alpha info");
      expect(result.additionalContext).toContain("Budget details");
    });

    it("deduplicates identical context", () => {
      setTriggersConfig(db, [
        { id: "1", keyword: "alpha", context: "Same info", enabled: true },
        { id: "2", keyword: "project", context: "Same info", enabled: true },
      ]);
      evaluator.reload();
      const result = evaluator.evaluate("alpha project details");
      expect(result.additionalContext).toBe("Same info");
    });

    it("does not inject for disabled triggers", () => {
      setTriggersConfig(db, [
        { id: "1", keyword: "alpha", context: "Project Alpha info", enabled: false },
      ]);
      evaluator.reload();
      expect(evaluator.evaluate("alpha").additionalContext).toBe("");
    });

    it("handles multi-word trigger keywords", () => {
      setTriggersConfig(db, [
        { id: "1", keyword: "ton wallet", context: "TON wallet info", enabled: true },
      ]);
      evaluator.reload();
      expect(evaluator.evaluate("setup a ton wallet").additionalContext).toBe("TON wallet info");
      expect(evaluator.evaluate("ton is great").additionalContext).toBe("");
    });

    it("does not match triggers as substrings", () => {
      setTriggersConfig(db, [{ id: "1", keyword: "alpha", context: "Alpha info", enabled: true }]);
      evaluator.reload();
      expect(evaluator.evaluate("alphabetical").additionalContext).toBe("");
    });
  });

  // ── Hot Reload ─────────────────────────────────────────────────────

  describe("Hot Reload", () => {
    it("picks up changes after reload()", () => {
      expect(evaluator.evaluate("scam").blocked).toBe(false);
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      // Before reload — still uses cached config
      expect(evaluator.evaluate("scam").blocked).toBe(false);
      evaluator.reload();
      expect(evaluator.evaluate("scam").blocked).toBe(true);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("handles empty message", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["scam"], message: "" });
      evaluator.reload();
      expect(evaluator.evaluate("").blocked).toBe(false);
    });

    it("handles empty keyword list", () => {
      setBlocklistConfig(db, { enabled: true, keywords: [], message: "" });
      evaluator.reload();
      expect(evaluator.evaluate("anything").blocked).toBe(false);
    });

    it("blocklist and triggers work together", () => {
      setBlocklistConfig(db, { enabled: true, keywords: ["banned"], message: "Blocked." });
      setTriggersConfig(db, [{ id: "1", keyword: "info", context: "Some context", enabled: true }]);
      evaluator.reload();

      // Blocked message: triggers not checked
      const blocked = evaluator.evaluate("banned word");
      expect(blocked.blocked).toBe(true);

      // Non-blocked with trigger
      const triggered = evaluator.evaluate("give me info");
      expect(triggered.blocked).toBe(false);
      expect(triggered.additionalContext).toBe("Some context");
    });
  });
});
