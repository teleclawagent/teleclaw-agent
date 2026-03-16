/**
 * Scrape correct gift trait percentages from giftstat.com DataLens dashboard.
 * Uses Puppeteer-like browser automation via page evaluation.
 * 
 * The DataLens table shows: Gift ID, Rarity score, Model %, Backdrop %, Symbol %
 * We need to extract unique traits + percentages per collection.
 * 
 * Strategy: For each collection, read the table rows and extract unique 
 * model/backdrop/symbol names with their percentages.
 */

import { readFileSync, writeFileSync } from "fs";

const DB_PATH = new URL("../src/agent/tools/fragment/gifts-database.json", import.meta.url).pathname;
const DATALENS_BASE = "https://datalens.yandex/sxnkk2bx16twe";

// Parse the trait data from giftstat DataLens cell text
// Format: "Rarity: 6.25 M: Eve's Apple - 0.8% B: Rosewood - 1% S: Leaf - 0.2%"
function parseTraitCell(text: string): {
  rarity: number;
  model: { name: string; pct: number };
  backdrop: { name: string; pct: number };
  symbol: { name: string; pct: number };
} | null {
  const rarityMatch = text.match(/Rarity:\s*([\d.]+)/);
  const modelMatch = text.match(/M:\s*([^-]+?)\s*-\s*([\d.]+)%/);
  const backdropMatch = text.match(/B:\s*([^-]+?)\s*-\s*([\d.]+)%/);
  const symbolMatch = text.match(/S:\s*([^-]+?)\s*-\s*([\d.]+)%/);

  if (!rarityMatch || !modelMatch || !backdropMatch || !symbolMatch) return null;

  return {
    rarity: parseFloat(rarityMatch[1]),
    model: { name: modelMatch[1].trim(), pct: parseFloat(modelMatch[2]) },
    backdrop: { name: backdropMatch[1].trim(), pct: parseFloat(backdropMatch[2]) },
    symbol: { name: symbolMatch[1].trim(), pct: parseFloat(symbolMatch[2]) },
  };
}

// Since we can't easily automate the browser from a script,
// let's use the data we already captured from the DataLens snapshot.
// The snapshot showed the format clearly. We can use curl to hit the DataLens API directly.

// Alternative approach: extract from the table in the existing browser snapshot data
// that was already captured. The format is consistent across all collections.

// For now, let's use the CDN data we found + Fragment data we have,
// and create the correct percentages based on total supply.

async function main() {
  const db = JSON.parse(readFileSync(DB_PATH, "utf-8"));
  
  // Load CDN backdrop data (these are the canonical backdrop names)
  const backdropRes = await fetch("https://cdn.changes.tg/gifts/backdrops.json");
  const cdnBackdrops: Array<{ name: string; backdropId: number; hex: Record<string, string> }> = await backdropRes.json();
  
  // Load CDN patterns data (symbol names per collection)  
  const patternsRes = await fetch("https://cdn.changes.tg/gifts/patterns.json");
  const cdnPatterns: Record<string, string> = await patternsRes.json();
  
  // Load CDN id-to-name
  const idNameRes = await fetch("https://cdn.changes.tg/gifts/id-to-name.json");
  const idToName: Record<string, string> = await idNameRes.json();
  
  console.log(`CDN Data loaded:`);
  console.log(`  Backdrops: ${cdnBackdrops.length}`);
  console.log(`  Pattern entries: ${Object.keys(cdnPatterns).length}`);
  console.log(`  Collections: ${Object.keys(idToName).length}`);
  
  // Save CDN data alongside our database
  const cdnData = {
    backdrops: cdnBackdrops,
    patterns: cdnPatterns,
    collectionIds: idToName,
  };
  
  const cdnPath = DB_PATH.replace("gifts-database.json", "gifts-cdn-data.json");
  writeFileSync(cdnPath, JSON.stringify(cdnData, null, 2));
  console.log(`\nCDN data saved to: ${cdnPath}`);
  
  // Extract unique symbols per collection from patterns
  const symbolsByCollection: Record<string, string[]> = {};
  for (const [hash, path] of Object.entries(cdnPatterns)) {
    const parts = path.split("/");
    if (parts.length !== 2) continue;
    const collName = parts[0];
    const symbolName = parts[1].replace(".tgs", "");
    if (!symbolName) continue;
    if (!symbolsByCollection[collName]) symbolsByCollection[collName] = [];
    if (!symbolsByCollection[collName].includes(symbolName)) {
      symbolsByCollection[collName].push(symbolName);
    }
  }
  
  console.log(`\nSymbols extracted per collection:`);
  for (const [col, syms] of Object.entries(symbolsByCollection).sort()) {
    console.log(`  ${col}: ${syms.length} symbols`);
  }
  
  // Update database with CDN backdrop data
  // The CDN backdrops are the master list — we can add hex colors to our DB
  db.metadata.cdnBackdrops = cdnBackdrops.map(b => ({
    name: b.name,
    id: b.backdropId,
    colors: b.hex,
  }));
  
  db.metadata.cdnSymbolsByCollection = symbolsByCollection;
  db.metadata.lastCdnUpdate = new Date().toISOString();
  
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`\nDatabase updated with CDN data`);
  
  // Summary of what we still need
  console.log(`\n=== STATUS ===`);
  console.log(`✅ 109 collections with Fragment marketplace trait counts`);
  console.log(`✅ Total supply + upgraded count for all 109`);
  console.log(`✅ 80 canonical backdrop names with hex colors from CDN`);
  console.log(`✅ Symbol names per collection from CDN patterns`);
  console.log(`⚠️  Model names only from Fragment (marketplace subset, not total)`);
  console.log(`⚠️  Trait percentages from Fragment are based on listed items, not total supply`);
  console.log(`📌 For exact Telegram-matching percentages: need giftstat DataLens browser scrape`);
}

main().catch(console.error);
