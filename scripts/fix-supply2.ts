/**
 * Fix supply: get actual total from each collection's first listed gift page.
 */
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync } from "fs";

const FRAGMENT_BASE = "https://fragment.com";
const DELAY_MS = 2000;
const DB_PATH = new URL("../src/agent/tools/fragment/gifts-database.json", import.meta.url).pathname;

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url: string): Promise<string> {
  await delay(DELAY_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://fragment.com/gifts",
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getSupplyForCollection(slug: string): Promise<{ upgraded: number; total: number } | null> {
  try {
    // Step 1: Get collection page and find first gift URL
    const colHtml = await fetchText(`${FRAGMENT_BASE}/gifts/${slug}`);
    const $ = cheerio.load(colHtml);
    const firstGiftHref = $(`a[href^="/gift/${slug}-"]`).first().attr("href");
    if (!firstGiftHref) {
      console.log(`  No gift links found`);
      return null;
    }
    
    // Step 2: Fetch that gift's detail page
    const giftHtml = await fetchText(`${FRAGMENT_BASE}${firstGiftHref}`);
    
    // Step 3: Parse "X of Y" from the page
    const match = giftHtml.match(/(\d[\d,]*)\s+of\s+(\d[\d,]*)/);
    if (match) {
      return {
        upgraded: parseInt(match[1].replace(/,/g, "")),
        total: parseInt(match[2].replace(/,/g, "")),
      };
    }
    
    return null;
  } catch (err) {
    console.error(`  Error: ${err}`);
    return null;
  }
}

async function main() {
  const db = JSON.parse(readFileSync(DB_PATH, "utf-8"));
  let fixed = 0;
  
  for (let i = 0; i < db.collections.length; i++) {
    const col = db.collections[i];
    
    // Skip if already fixed
    if (col.totalSupply && col.totalSupply > col.totalItems) {
      console.log(`[${i+1}/109] ${col.name} — already fixed (${col.totalSupply})`);
      fixed++;
      continue;
    }
    
    console.log(`[${i+1}/109] ${col.name}`);
    const supply = await getSupplyForCollection(col.slug);
    
    if (supply && supply.total > 0) {
      col.totalSupply = supply.total;
      col.upgraded = supply.upgraded;
      col.notUpgraded = supply.total - supply.upgraded;
      
      // Recalculate percentages
      for (const m of col.models) m.percentage = Math.round((m.count / supply.total) * 1000) / 10;
      for (const b of col.backdrops) b.percentage = Math.round((b.count / supply.total) * 1000) / 10;
      for (const s of col.symbols) s.percentage = Math.round((s.count / supply.total) * 1000) / 10;
      
      console.log(`  ✅ Supply: ${supply.total.toLocaleString()}, Upgraded: ${supply.upgraded.toLocaleString()}`);
      fixed++;
    } else {
      console.log(`  ❌ Failed`);
    }
    
    // Save after each
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }
  
  db.metadata.supplyFixed = true;
  db.metadata.scrapedAt = new Date().toISOString();
  db.metadata.totalGifts = db.collections.reduce((s: number, c: any) => s + (c.totalSupply || c.totalItems), 0);
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  
  console.log(`\n=== ${fixed}/109 fixed ===`);
}

main().catch(console.error);
