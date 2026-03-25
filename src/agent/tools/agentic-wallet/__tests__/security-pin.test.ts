import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateAgenticWallet } from "../schema.js";
import { setPin, verifyPin } from "../security.js";

describe("wallet PIN verify — atomic failed_attempts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrateAgenticWallet(db);
    setPin(db, 1, "4242");
  });

  it("increments failed_attempts on each wrong PIN without losing updates", () => {
    for (let i = 1; i <= 4; i++) {
      expect(() => verifyPin(db, 1, "0000")).toThrow(/Wrong PIN/);
    }
    const row = db
      .prepare("SELECT failed_attempts, locked_until FROM wallet_pins WHERE user_id = 1")
      .get() as { failed_attempts: number; locked_until: number };
    expect(row.failed_attempts).toBe(4);
    expect(row.locked_until).toBe(0);

    expect(() => verifyPin(db, 1, "0000")).toThrow(/locked/i);
    const locked = db
      .prepare("SELECT failed_attempts, locked_until FROM wallet_pins WHERE user_id = 1")
      .get() as { failed_attempts: number; locked_until: number };
    expect(locked.failed_attempts).toBeGreaterThanOrEqual(5);
    expect(locked.locked_until).toBeGreaterThan(0);
  });

  it("resets counter on success after failures", () => {
    expect(() => verifyPin(db, 1, "0000")).toThrow(/Wrong PIN/);
    expect(verifyPin(db, 1, "4242")).toBe(true);
    const row = db.prepare("SELECT failed_attempts FROM wallet_pins WHERE user_id = 1").get() as {
      failed_attempts: number;
    };
    expect(row.failed_attempts).toBe(0);
  });
});
