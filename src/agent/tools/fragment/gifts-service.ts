/**
 * Telegram Gifts Data Service
 * Provides complete gift collection data with rarity, supply, counts, and model details.
 *
 * Data sources:
 * - gifts-database.json: Rich data with supply, counts, upgraded/notUpgraded, Fragment URLs
 * - gifts-complete-data.json: Rarity permille values, backdrop colors, used for rarity scoring
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftsService");

// ─── Types ───────────────────────────────────────────────────────────

export interface GiftModel {
  name: string;
  rarity: number; // permille (10 = 1%) — from complete-data
  rarityPercent: number;
  count?: number; // how many exist with this model — from database
  estimatedTotalCount?: number;
}

export interface GiftBackdrop {
  name: string;
  rarity: number;
  rarityPercent: number;
  count?: number;
  estimatedTotalCount?: number;
  colors?: {
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
  count?: number;
  estimatedTotalCount?: number;
}

export interface GiftCollection {
  name: string;
  id: string;
  slug?: string;
  customEmojiId?: string;
  url?: string;
  // Supply info
  totalSupply?: number; // total minted
  listedSupply?: number; // totalItems on Fragment
  upgraded?: number; // converted to on-chain NFT
  notUpgraded?: number; // still off-chain
  // Counts
  totalModels: number;
  totalBackdrops: number;
  totalSymbols: number;
  // Details
  models: GiftModel[];
  backdrops: GiftBackdrop[];
  symbols: GiftSymbol[];
  scrapedAt?: string;
}

interface CompleteDatabase {
  metadata: {
    totalCollections: number;
    totalModels: number;
    totalBackdrops: number;
    totalSymbols: number;
    fetchedAt: string;
    source: string;
  };
  collections: Array<{
    name: string;
    id: string;
    customEmojiId: string;
    totalModels: number;
    totalBackdrops: number;
    totalSymbols: number;
    models: Array<{ name: string; rarity: number; rarityPercent: number }>;
    backdrops: Array<{
      name: string;
      rarity: number;
      rarityPercent: number;
      colors?: { centerColor: string; edgeColor: string; patternColor: string; textColor: string };
    }>;
    symbols: Array<{ name: string; rarity: number; rarityPercent: number }>;
  }>;
}

interface RichDatabase {
  metadata: {
    totalCollections: number;
    totalGifts: number;
    totalModels: number;
    totalBackdrops: number;
    totalSymbols: number;
    scrapedAt: string;
    supplyFixed: boolean;
  };
  collections: Array<{
    name: string;
    slug: string;
    totalItems: number;
    url: string;
    totalSupply: number;
    upgraded: number;
    notUpgraded: number;
    scrapedAt: string;
    models: Array<{ name: string; count: number; percentage: number; estimatedTotalCount: number }>;
    backdrops: Array<{
      name: string;
      count: number;
      percentage: number;
      estimatedTotalCount: number;
    }>;
    symbols: Array<{
      name: string;
      count: number;
      percentage: number;
      estimatedTotalCount: number;
    }>;
  }>;
}

// ─── Singleton ───────────────────────────────────────────────────────

let collections: GiftCollection[] | null = null;
let collectionMap: Map<string, GiftCollection> | null = null;
let totalGifts = 0;

function loadAndMerge(): GiftCollection[] {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Load both databases
  let completeDb: CompleteDatabase | null = null;
  let richDb: RichDatabase | null = null;

  try {
    completeDb = JSON.parse(readFileSync(join(__dirname, "gifts-complete-data.json"), "utf-8"));
  } catch {
    log.warn("gifts-complete-data.json not found, using database only");
  }

  try {
    richDb = JSON.parse(readFileSync(join(__dirname, "gifts-database.json"), "utf-8"));
  } catch {
    log.warn("gifts-database.json not found, using complete-data only");
  }

  if (!completeDb && !richDb) {
    throw new Error("No gift database files found!");
  }

  // Build merged collections — rich DB is primary for supply/counts, complete DB for rarity
  const richMap = new Map<string, RichDatabase["collections"][0]>();
  if (richDb) {
    totalGifts = richDb.metadata.totalGifts;
    for (const c of richDb.collections) {
      richMap.set(c.name.toLowerCase(), c);
    }
  }

  const completeMap = new Map<string, CompleteDatabase["collections"][0]>();
  if (completeDb) {
    for (const c of completeDb.collections) {
      completeMap.set(c.name.toLowerCase(), c);
    }
  }

  // Merge: iterate all unique collection names
  const allNames = new Set([...richMap.keys(), ...completeMap.keys()]);
  const merged: GiftCollection[] = [];

  for (const key of allNames) {
    const rich = richMap.get(key);
    const complete = completeMap.get(key);

    // Build model merge map
    const richModelMap = new Map<string, { count: number; estimatedTotalCount: number }>();
    if (rich) {
      for (const m of rich.models) {
        richModelMap.set(m.name.toLowerCase(), {
          count: m.count,
          estimatedTotalCount: m.estimatedTotalCount,
        });
      }
    }

    const completeModelMap = new Map<string, { rarity: number; rarityPercent: number }>();
    if (complete) {
      for (const m of complete.models) {
        completeModelMap.set(m.name.toLowerCase(), {
          rarity: m.rarity,
          rarityPercent: m.rarityPercent,
        });
      }
    }

    // Helper to find original name from either source
    const findName = (items: (Array<{ name: string }> | undefined)[], lowerKey: string): string => {
      for (const list of items) {
        if (!list) continue;
        const found = list.find((i) => i.name.toLowerCase() === lowerKey);
        if (found) return found.name;
      }
      return lowerKey;
    };

    // Merge models
    const allModelNames = new Set([...richModelMap.keys(), ...completeModelMap.keys()]);
    const models: GiftModel[] = [];
    for (const mn of allModelNames) {
      const rm = richModelMap.get(mn);
      const cm = completeModelMap.get(mn);
      models.push({
        name: findName([complete?.models, rich?.models], mn),
        rarity: cm?.rarity ?? 0,
        rarityPercent: cm?.rarityPercent ?? 0,
        count: rm?.count,
        estimatedTotalCount: rm?.estimatedTotalCount,
      });
    }

    // Same for backdrops
    const richBdMap = new Map<string, { count: number; estimatedTotalCount: number }>();
    if (rich)
      for (const b of rich.backdrops)
        richBdMap.set(b.name.toLowerCase(), {
          count: b.count,
          estimatedTotalCount: b.estimatedTotalCount,
        });
    const completeBdMap = new Map<
      string,
      { rarity: number; rarityPercent: number; colors?: GiftBackdrop["colors"] }
    >();
    if (complete)
      for (const b of complete.backdrops)
        completeBdMap.set(b.name.toLowerCase(), {
          rarity: b.rarity,
          rarityPercent: b.rarityPercent,
          colors: b.colors,
        });

    const allBdNames = new Set([...richBdMap.keys(), ...completeBdMap.keys()]);
    const backdrops: GiftBackdrop[] = [];
    for (const bn of allBdNames) {
      const rb = richBdMap.get(bn);
      const cb = completeBdMap.get(bn);
      backdrops.push({
        name: findName([complete?.backdrops, rich?.backdrops], bn),
        rarity: cb?.rarity ?? 0,
        rarityPercent: cb?.rarityPercent ?? 0,
        count: rb?.count,
        estimatedTotalCount: rb?.estimatedTotalCount,
        colors: cb?.colors,
      });
    }

    // Same for symbols
    const richSymMap = new Map<string, { count: number; estimatedTotalCount: number }>();
    if (rich)
      for (const s of rich.symbols)
        richSymMap.set(s.name.toLowerCase(), {
          count: s.count,
          estimatedTotalCount: s.estimatedTotalCount,
        });
    const completeSymMap = new Map<string, { rarity: number; rarityPercent: number }>();
    if (complete)
      for (const s of complete.symbols)
        completeSymMap.set(s.name.toLowerCase(), {
          rarity: s.rarity,
          rarityPercent: s.rarityPercent,
        });

    const allSymNames = new Set([...richSymMap.keys(), ...completeSymMap.keys()]);
    const symbols: GiftSymbol[] = [];
    for (const sn of allSymNames) {
      const rs = richSymMap.get(sn);
      const cs = completeSymMap.get(sn);
      symbols.push({
        name: findName([complete?.symbols, rich?.symbols], sn),
        rarity: cs?.rarity ?? 0,
        rarityPercent: cs?.rarityPercent ?? 0,
        count: rs?.count,
        estimatedTotalCount: rs?.estimatedTotalCount,
      });
    }

    merged.push({
      name: rich?.name || complete?.name || key,
      id: complete?.id || "",
      slug: rich?.slug,
      customEmojiId: complete?.customEmojiId,
      url: rich?.url,
      totalSupply: rich?.totalSupply,
      listedSupply: rich?.totalItems,
      upgraded: rich?.upgraded,
      notUpgraded: rich?.notUpgraded,
      totalModels: models.length,
      totalBackdrops: backdrops.length,
      totalSymbols: symbols.length,
      models,
      backdrops,
      symbols,
      scrapedAt: rich?.scrapedAt || completeDb?.metadata.fetchedAt,
    });
  }

  log.info(
    `Loaded ${merged.length} gift collections (${merged.reduce((s, c) => s + c.totalModels, 0)} models, ` +
      `${merged.reduce((s, c) => s + c.totalBackdrops, 0)} backdrops, ` +
      `${merged.reduce((s, c) => s + c.totalSymbols, 0)} symbols, ` +
      `${totalGifts.toLocaleString()} total gifts minted)`
  );

  return merged;
}

function ensureLoaded(): void {
  if (!collections) {
    collections = loadAndMerge();
    collectionMap = new Map();
    for (const c of collections) {
      collectionMap.set(c.name.toLowerCase(), c);
      if (c.slug) {
        collectionMap.set(c.slug.toLowerCase(), c);
      }
      // Also map without spaces/special chars
      collectionMap.set(c.name.toLowerCase().replace(/['']/g, "").replace(/\s+/g, "-"), c);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/** Get loaded collections (throws if not loaded) */
function getCollections(): GiftCollection[] {
  ensureLoaded();
  if (!collections) throw new Error("Gift database failed to load");
  return collections;
}

/** Get all collection names */
export function getAllCollections(): string[] {
  return getCollections().map((c) => c.name);
}

/** Get total stats */
export function getGiftStats(): {
  totalCollections: number;
  totalModels: number;
  totalBackdrops: number;
  totalSymbols: number;
  totalGiftsMinted: number;
} {
  const cols = getCollections();
  return {
    totalCollections: cols.length,
    totalModels: cols.reduce((s, c) => s + c.totalModels, 0),
    totalBackdrops: cols.reduce((s, c) => s + c.totalBackdrops, 0),
    totalSymbols: cols.reduce((s, c) => s + c.totalSymbols, 0),
    totalGiftsMinted: totalGifts,
  };
}

/** Get a single collection by name (case-insensitive, supports slug) */
export function getCollection(name: string): GiftCollection | null {
  ensureLoaded();
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

  const model = col.models.find((m) => m.name.toLowerCase() === modelName.toLowerCase());
  const backdrop = col.backdrops.find((b) => b.name.toLowerCase() === backdropName.toLowerCase());
  const symbol = col.symbols.find((s) => s.name.toLowerCase() === symbolName.toLowerCase());

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
  return getCollections().filter((c) => c.name.toLowerCase().includes(q));
}

/** Find rarest models across all collections */
export function findRarestModels(limit = 20): Array<{
  collection: string;
  model: string;
  rarityPermille: number;
  rarityPercent: number;
  count?: number;
}> {
  ensureLoaded();
  const results: Array<{
    collection: string;
    model: string;
    rarityPermille: number;
    rarityPercent: number;
    count?: number;
  }> = [];

  for (const col of getCollections()) {
    for (const m of col.models) {
      results.push({
        collection: col.name,
        model: m.name,
        rarityPermille: m.rarity,
        rarityPercent: m.rarityPercent,
        count: m.count,
      });
    }
  }

  return results.sort((a, b) => a.rarityPermille - b.rarityPermille).slice(0, limit);
}

/** Get collections sorted by supply (largest first) */
export function getCollectionsBySupply(limit = 20): Array<{
  name: string;
  slug?: string;
  totalSupply: number;
  upgraded: number;
  notUpgraded: number;
  models: number;
  backdrops: number;
  symbols: number;
  url?: string;
}> {
  ensureLoaded();
  return getCollections()
    .filter((c) => c.totalSupply && c.totalSupply > 0)
    .sort((a, b) => (b.totalSupply || 0) - (a.totalSupply || 0))
    .slice(0, limit)
    .map((c) => ({
      name: c.name,
      slug: c.slug,
      totalSupply: c.totalSupply || 0,
      upgraded: c.upgraded || 0,
      notUpgraded: c.notUpgraded || 0,
      models: c.totalModels,
      backdrops: c.totalBackdrops,
      symbols: c.totalSymbols,
      url: c.url,
    }));
}
