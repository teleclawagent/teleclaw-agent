/**
 * Telegram Gifts Data Service
 * Provides complete gift collection data with real rarity percentages
 * Source: api.changes.tg (Telegram's official CDN data)
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftsService");

// ─── Types ───────────────────────────────────────────────────────────

export interface GiftModel {
  name: string;
  rarity: number; // permille (10 = 1%)
  rarityPercent: number;
}

export interface GiftBackdrop {
  name: string;
  rarity: number;
  rarityPercent: number;
  colors: {
    centerColor: string;
    edgeColor: string;
    patternColor: string;
    textColor: string;
  };
}

export interface GiftSymbol {
  name: string;
  rarity: number;
  rarityPercent: number;
}

export interface GiftCollection {
  name: string;
  id: string;
  customEmojiId: string;
  totalModels: number;
  totalBackdrops: number;
  totalSymbols: number;
  models: GiftModel[];
  backdrops: GiftBackdrop[];
  symbols: GiftSymbol[];
}

interface GiftsDatabase {
  metadata: {
    totalCollections: number;
    totalModels: number;
    totalBackdrops: number;
    totalSymbols: number;
    fetchedAt: string;
    source: string;
  };
  collections: GiftCollection[];
}

// ─── Singleton ───────────────────────────────────────────────────────

let db: GiftsDatabase | null = null;
let collectionMap: Map<string, GiftCollection> | null = null;

function getDB(): GiftsDatabase {
  if (!db) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const dataPath = join(__dirname, "gifts-complete-data.json");
    db = JSON.parse(readFileSync(dataPath, "utf-8"));
    collectionMap = new Map();
    for (const c of db!.collections) {
      collectionMap.set(c.name.toLowerCase(), c);
      // Also map slug format
      collectionMap.set(
        c.name.toLowerCase().replace(/['']/g, "").replace(/\s+/g, "-"),
        c
      );
    }
    log.info(`Loaded ${db!.metadata.totalCollections} gift collections`);
  }
  return db!;
}

// ─── Public API ──────────────────────────────────────────────────────

/** Get all collection names */
export function getAllCollections(): string[] {
  return getDB().collections.map((c) => c.name);
}

/** Get total stats */
export function getGiftStats(): GiftsDatabase["metadata"] {
  return getDB().metadata;
}

/** Get a single collection by name (case-insensitive, supports slug) */
export function getCollection(name: string): GiftCollection | null {
  getDB();
  return collectionMap?.get(name.toLowerCase()) ?? null;
}

/** Get models for a collection, sorted by rarity (rarest first) */
export function getModels(collectionName: string): GiftModel[] {
  const col = getCollection(collectionName);
  if (!col) return [];
  return [...col.models].sort((a, b) => a.rarity - b.rarity);
}

/** Get backdrops for a collection, sorted by rarity (rarest first) */
export function getBackdrops(collectionName: string): GiftBackdrop[] {
  const col = getCollection(collectionName);
  if (!col) return [];
  return [...col.backdrops].sort((a, b) => a.rarity - b.rarity);
}

/** Get symbols for a collection, sorted by rarity (rarest first) */
export function getSymbols(collectionName: string): GiftSymbol[] {
  const col = getCollection(collectionName);
  if (!col) return [];
  return [...col.symbols].sort((a, b) => a.rarity - b.rarity);
}

/** Calculate combined rarity score for a gift (model + backdrop + symbol) */
export function calculateRarityScore(
  collectionName: string,
  modelName: string,
  backdropName: string,
  symbolName: string
): {
  modelRarity: number;
  backdropRarity: number;
  symbolRarity: number;
  combinedPermille: number;
  rarityTier: "Legendary" | "Epic" | "Rare" | "Uncommon" | "Common";
} | null {
  const col = getCollection(collectionName);
  if (!col) return null;

  const model = col.models.find(
    (m) => m.name.toLowerCase() === modelName.toLowerCase()
  );
  const backdrop = col.backdrops.find(
    (b) => b.name.toLowerCase() === backdropName.toLowerCase()
  );
  const symbol = col.symbols.find(
    (s) => s.name.toLowerCase() === symbolName.toLowerCase()
  );

  if (!model || !backdrop || !symbol) return null;

  const combinedPermille = model.rarity + backdrop.rarity + symbol.rarity;

  let rarityTier: "Legendary" | "Epic" | "Rare" | "Uncommon" | "Common";
  if (combinedPermille <= 30) rarityTier = "Legendary";
  else if (combinedPermille <= 60) rarityTier = "Epic";
  else if (combinedPermille <= 100) rarityTier = "Rare";
  else if (combinedPermille <= 200) rarityTier = "Uncommon";
  else rarityTier = "Common";

  return {
    modelRarity: model.rarity,
    backdropRarity: backdrop.rarity,
    symbolRarity: symbol.rarity,
    combinedPermille,
    rarityTier,
  };
}

/** Search collections by keyword */
export function searchCollections(query: string): GiftCollection[] {
  const q = query.toLowerCase();
  return getDB().collections.filter((c) => c.name.toLowerCase().includes(q));
}

/** Find rarest models across all collections */
export function findRarestModels(limit = 20): Array<{
  collection: string;
  model: string;
  rarityPermille: number;
  rarityPercent: number;
}> {
  const results: Array<{
    collection: string;
    model: string;
    rarityPermille: number;
    rarityPercent: number;
  }> = [];

  for (const col of getDB().collections) {
    for (const m of col.models) {
      results.push({
        collection: col.name,
        model: m.name,
        rarityPermille: m.rarity,
        rarityPercent: m.rarityPercent,
      });
    }
  }

  return results.sort((a, b) => a.rarityPermille - b.rarityPermille).slice(0, limit);
}
