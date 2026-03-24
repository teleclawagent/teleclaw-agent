#!/usr/bin/env npx tsx
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fetch complete gift collection data from api.changes.tg
 * Models, Backdrops, Symbols — all with real rarity percentages
 */

const API_BASE = "https://api.changes.tg";
const DELAY_MS = 300; // be nice to the API

interface GiftModel {
  name: string;
  rarity: number; // permille (10 = 1%)
  rarityPercent: number; // calculated
}

interface GiftBackdrop {
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

interface GiftSymbol {
  name: string;
  rarity: number;
  rarityPercent: number;
}

interface GiftCollection {
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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/['']/g, "").replace(/\s+/g, "-");
}

async function main() {
  console.log("Fetching gift names...");
  const names: string[] = await fetchJSON(`${API_BASE}/gifts`);
  console.log(`Found ${names.length} collections`);

  const collections: GiftCollection[] = [];
  const failed: string[] = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const slug = toSlug(name);
    console.log(`[${i + 1}/${names.length}] ${name} (${slug})...`);

    try {
      const data = await fetchJSON(`${API_BASE}/gift/${encodeURIComponent(slug)}`);
      await sleep(DELAY_MS);

      // Fetch detailed backdrops (with colors)
      let detailedBackdrops: any[] = [];
      try {
        detailedBackdrops = await fetchJSON(
          `${API_BASE}/backdrops/${encodeURIComponent(slug)}?sorted`
        );
        await sleep(DELAY_MS);
      } catch {
        console.log(`  ⚠ No detailed backdrops for ${name}`);
      }

      // Fetch detailed symbols
      let detailedSymbols: any[] = [];
      try {
        detailedSymbols = await fetchJSON(`${API_BASE}/symbols/${encodeURIComponent(slug)}?sorted`);
        await sleep(DELAY_MS);
      } catch {
        console.log(`  ⚠ No detailed symbols for ${name}`);
      }

      // Fetch detailed models
      let detailedModels: any[] = [];
      try {
        detailedModels = await fetchJSON(`${API_BASE}/models/${encodeURIComponent(slug)}?sorted`);
        await sleep(DELAY_MS);
      } catch {
        console.log(`  ⚠ No detailed models for ${name}`);
      }

      const models: GiftModel[] = (detailedModels.length ? detailedModels : data.models || []).map(
        (m: any) => ({
          name: m.name,
          rarity: m.rarityPermille ?? m.rarity ?? 0,
          rarityPercent: (m.rarityPermille ?? m.rarity ?? 0) / 10,
        })
      );

      const backdrops: GiftBackdrop[] = (
        detailedBackdrops.length ? detailedBackdrops : data.backdrops || []
      ).map((b: any) => ({
        name: b.name,
        rarity: b.rarityPermille ?? b.rarity ?? 0,
        rarityPercent: (b.rarityPermille ?? b.rarity ?? 0) / 10,
        colors: b.hex || {
          centerColor: `#${(b.centerColor ?? 0).toString(16).padStart(6, "0")}`,
          edgeColor: `#${(b.edgeColor ?? 0).toString(16).padStart(6, "0")}`,
          patternColor: `#${(b.patternColor ?? 0).toString(16).padStart(6, "0")}`,
          textColor: `#${(b.textColor ?? 0).toString(16).padStart(6, "0")}`,
        },
      }));

      const symbols: GiftSymbol[] = (
        detailedSymbols.length ? detailedSymbols : data.symbols || []
      ).map((s: any) => ({
        name: s.name,
        rarity: s.rarityPermille ?? s.rarity ?? 0,
        rarityPercent: (s.rarityPermille ?? s.rarity ?? 0) / 10,
      }));

      collections.push({
        name,
        id: data.gift?.id || "",
        customEmojiId: data.gift?.customEmojiId || "",
        totalModels: models.length,
        totalBackdrops: backdrops.length,
        totalSymbols: symbols.length,
        models,
        backdrops,
        symbols,
      });

      console.log(
        `  ✅ ${models.length} models, ${backdrops.length} backdrops, ${symbols.length} symbols`
      );
    } catch (err: any) {
      console.log(`  ❌ FAILED: ${err.message}`);
      failed.push(name);
    }
  }

  // Summary
  const totalModels = collections.reduce((s, c) => s + c.totalModels, 0);
  const totalBackdrops = collections.reduce((s, c) => s + c.totalBackdrops, 0);
  const totalSymbols = collections.reduce((s, c) => s + c.totalSymbols, 0);

  const output = {
    metadata: {
      totalCollections: collections.length,
      totalModels,
      totalBackdrops,
      totalSymbols,
      fetchedAt: new Date().toISOString(),
      source: "api.changes.tg",
      failedCollections: failed,
    },
    collections,
  };

  const outPath = new URL("./gifts-complete-data.json", import.meta.url).pathname;
  const { writeFileSync } = await import("fs");
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n=== DONE ===`);
  console.log(`Collections: ${collections.length}/${names.length}`);
  console.log(`Models: ${totalModels} | Backdrops: ${totalBackdrops} | Symbols: ${totalSymbols}`);
  console.log(`Failed: ${failed.length > 0 ? failed.join(", ") : "none"}`);
  console.log(`Saved to: ${outPath}`);
}

main().catch(console.error);
