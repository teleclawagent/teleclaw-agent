/**
 * Fix gift database: get actual total supply from individual gift detail pages.
 * Each collection's first gift page shows "X of Y issued" where Y = total supply.
 */

import * as cheerio from "cheerio";
import { readFileSync, writeFileSync } from "fs";

const FRAGMENT_BASE = "https://fragment.com";
const DELAY_MS = 2000;
const DB_PATH = new URL("../src/agent/tools/fragment/gifts-database.json", import.meta.url).pathname;

async function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function getSupply(slug: string): Promise<{ issued: number; total: number } | null> {
  await delay(DELAY_MS);
  try {
    const url = `${FRAGMENT_BASE}/gift/${slug}-1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html",
        "Referer": "https://fragment.com/gifts",
      }
    });
    
    if (!res.ok) {
      // Try with different number
      await delay(DELAY_MS);
      const res2 = await fetch(`${FRAGMENT_BASE}/gift/${slug}-10`, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://fragment.com/gifts" }
      });
      if (!res2.ok) return null;
      const html2 = await res2.text();
      return parseIssuedFromHtml(html2);
    }
    
    const html = await res.text();
    return parseIssuedFromHtml(html);
  } catch (err) {
    console.error(`  Error fetching ${slug}:`, err);
    return null;
  }
}

function parseIssuedFromHtml(html: string): { issued: number; total: number } | null {
  // Look for "X of Y" pattern in the text
  const match = html.match(/(\d[\d,]*)\s*of\s*(\d[\d,]*)/);
  if (match) {
    return {
      issued: parseInt(match[1].replace(/,/g, "")),
      total: parseInt(match[2].replace(/,/g, "")),
    };
  }
  return null;
}

async function main() {
  const db = JSON.parse(readFileSync(DB_PATH, "utf-8"));
  
  console.log(`Fixing supply for ${db.collections.length} collections...\n`);
  
  let fixed = 0;
  for (let i = 0; i < db.collections.length; i++) {
    const col = db.collections[i];
    console.log(`[${i + 1}/${db.collections.length}] ${col.name} (current: ${col.totalItems})`);
    
    const supply = await getSupply(col.slug);
    if (supply) {
      col.totalSupply = supply.total;
      col.upgraded = supply.issued;
      col.notUpgraded = supply.total - supply.issued;
      
      // Recalculate percentages based on total supply
      for (const m of col.models) {
        m.percentage = Math.round((m.count / supply.total) * 1000) / 10;
      }
      for (const b of col.backdrops) {
        b.percentage = Math.round((b.count / supply.total) * 1000) / 10;
      }
      for (const s of col.symbols) {
        s.percentage = Math.round((s.count / supply.total) * 1000) / 10;
      }
      
      console.log(`  ✅ Total: ${supply.total}, Upgraded: ${supply.issued}`);
      fixed++;
    } else {
      console.log(`  ❌ Could not get supply`);
    }
    
    // Save after each
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }
  
  // Update metadata
  db.metadata.totalGifts = db.collections.reduce((s: number, c: any) => s + (c.totalSupply || c.totalItems), 0);
  db.metadata.supplyFixed = true;
  db.metadata.scrapedAt = new Date().toISOString();
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  
  console.log(`\n=== Done: ${fixed}/${db.collections.length} fixed ===`);
  console.log(`Total supply:`, db.metadata.totalGifts.toLocaleString());
}

main().catch(console.error);
