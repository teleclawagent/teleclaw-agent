/**
 * 📈 Price History — SQLite-backed hourly snapshots
 *
 * Stores floor prices every hour via cron.
 * Provides 24h/7d/30d history with % change calculation.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../../../utils/logger.js";
import { fetchFloorPrice, getAllCollectionSlugs } from "./fragment-scraper.js";

const log = createLogger("PriceHistory");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../../../data/gift-price-history.db");

// ─── DB Setup ────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data dir exists
  const dir = path.dirname(DB_PATH);
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const fs = require("fs") as typeof import("fs");
  fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      slug TEXT NOT NULL,
      floor_ton REAL,
      listing_count INTEGER DEFAULT 0,
      highest_ton REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(collection, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_collection
      ON price_snapshots(collection, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_snapshots_time
      ON price_snapshots(timestamp DESC);
  `);

  return _db;
}

// ─── Snapshot (called by cron) ───────────────────────────────────────

export async function snapshotFloorPrices(): Promise<{
  saved: number;
  errors: number;
}> {
  const slugs = await getAllCollectionSlugs();
  let saved = 0;
  let errors = 0;

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO price_snapshots (collection, slug, floor_ton, listing_count, highest_ton, timestamp)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  // Process in batches of 5
  for (let i = 0; i < slugs.length; i += 5) {
    const batch = slugs.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map((slug) => fetchFloorPrice(slug)));

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        try {
          const d = result.value;
          insert.run(d.collection, d.slug, d.floorTon, d.listingCount, d.highestTon);
          saved++;
        } catch (err) {
          errors++;
          log.error({ err }, "Failed to save snapshot");
        }
      } else {
        errors++;
      }
    }

    // Rate limit between batches
    if (i + 5 < slugs.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log.info({ saved, errors, total: slugs.length }, "Snapshot complete");
  return { saved, errors };
}

// ─── Query History ───────────────────────────────────────────────────

export interface PriceSnapshotRow {
  collection: string;
  slug: string;
  floor_ton: number | null;
  listing_count: number;
  highest_ton: number | null;
  timestamp: string;
}

export function getHistory(
  collection: string,
  period: "24h" | "7d" | "30d" = "7d"
): PriceSnapshotRow[] {
  const db = getDb();

  const periodMap = {
    "24h": "-24 hours",
    "7d": "-7 days",
    "30d": "-30 days",
  };

  const rows = db
    .prepare(
      `
    SELECT collection, slug, floor_ton, listing_count, highest_ton, timestamp
    FROM price_snapshots
    WHERE (collection = ? OR slug = ?)
      AND timestamp >= datetime('now', ?)
    ORDER BY timestamp ASC
  `
    )
    .all(
      collection,
      collection.toLowerCase().replace(/[^a-z0-9]/g, ""),
      periodMap[period]
    ) as PriceSnapshotRow[];

  return rows;
}

// ─── Calculate Change ────────────────────────────────────────────────

export function calculateChange(
  collection: string,
  period: "24h" | "7d" | "30d" = "24h"
): { startPrice: number | null; endPrice: number | null; changePercent: number | null } {
  const history = getHistory(collection, period);

  if (history.length < 2) {
    return { startPrice: null, endPrice: null, changePercent: null };
  }

  const startPrice = history[0].floor_ton;
  const endPrice = history[history.length - 1].floor_ton;

  if (!startPrice || !endPrice) {
    return { startPrice, endPrice, changePercent: null };
  }

  const changePercent = ((endPrice - startPrice) / startPrice) * 100;

  return {
    startPrice,
    endPrice,
    changePercent: Math.round(changePercent * 100) / 100,
  };
}

// ─── Get Latest Floors (from DB, fast) ──────────────────────────────

export function getLatestFloors(): PriceSnapshotRow[] {
  const db = getDb();

  return db
    .prepare(
      `
    SELECT s.collection, s.slug, s.floor_ton, s.listing_count, s.highest_ton, s.timestamp
    FROM price_snapshots s
    INNER JOIN (
      SELECT collection, MAX(timestamp) as max_ts
      FROM price_snapshots
      GROUP BY collection
    ) latest ON s.collection = latest.collection AND s.timestamp = latest.max_ts
    ORDER BY s.floor_ton DESC
  `
    )
    .all() as PriceSnapshotRow[];
}
