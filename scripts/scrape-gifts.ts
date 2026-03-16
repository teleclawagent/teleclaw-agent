/**
 * Scrape ALL Telegram Gift collections from Fragment.
 * Extracts: models, backdrops, symbols with counts for each collection.
 * Output: gifts-database.json
 */

import * as cheerio from "cheerio";

const FRAGMENT_BASE = "https://fragment.com";
const DELAY_MS = 2500;

interface TraitInfo {
  name: string;
  count: number;
  percentage?: number;
}

interface CollectionData {
  name: string;
  slug: string;
  totalItems: number;
  url: string;
  models: TraitInfo[];
  backdrops: TraitInfo[];
  symbols: TraitInfo[];
  scrapedAt: string;
}

async function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(url: string): Promise<string> {
  await delay(DELAY_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://fragment.com/gifts",
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Step 1: Get all collection slugs from main gifts page
async function getCollections(): Promise<Array<{ name: string; slug: string; totalItems: number }>> {
  console.log("Fetching main gifts page...");
  const html = await fetchPage(`${FRAGMENT_BASE}/gifts`);
  const $ = cheerio.load(html);
  
  const collections: Array<{ name: string; slug: string; totalItems: number }> = [];
  
  // Links like /gifts/plushpepe with item counts
  $("a[href^='/gifts/']").each((_i, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/^\/gifts\/([a-z]+)$/);
    if (!match) return;
    
    const slug = match[1];
    const text = $(el).text().trim();
    
    // Parse "Plush Pepes\n 2,360" format
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return;
    
    const name = lines[0];
    const countStr = lines[lines.length - 1].replace(/[,\s]/g, "").replace("items", "");
    const count = parseInt(countStr);
    
    if (name && count > 0 && !collections.find(c => c.slug === slug)) {
      collections.push({ name, slug, totalItems: count });
    }
  });
  
  console.log(`Found ${collections.length} collections`);
  return collections;
}

// Step 2: Parse filter section for traits
function parseTraits($: cheerio.CheerioAPI, sectionLabel: string): TraitInfo[] {
  const traits: TraitInfo[] = [];
  
  // The HTML structure has filter sections with labels like "Model", "Backdrop", "Symbol"
  // Each followed by items with name + count
  const bodyText = $.html();
  
  // Find the section by looking for the label in filter headers
  // Fragment uses a specific structure: the filter name, then a number (total options), then "Select All", then items
  const sections = bodyText.split(/(?=Model|Backdrop|Symbol)/);
  
  for (const section of sections) {
    if (!section.startsWith(sectionLabel)) continue;
    
    const $section = cheerio.load(section);
    // Extract all text nodes that look like "TraitName\n  count"
    const text = $section.text();
    
    // Pattern: trait names followed by numbers
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    
    let i = 0;
    // Skip header (sectionLabel, total count, "Select All")
    while (i < lines.length && !lines[i].match(/^Select All$/)) i++;
    i++; // skip "Select All"
    
    while (i < lines.length) {
      const name = lines[i];
      const nextLine = lines[i + 1];
      
      if (nextLine && /^\d+$/.test(nextLine)) {
        const count = parseInt(nextLine);
        if (name && count > 0 && !name.match(/^\d+$/) && name !== "Select All") {
          traits.push({ name, count });
        }
        i += 2;
      } else {
        break; // End of this section
      }
    }
    break;
  }
  
  return traits;
}

// Step 3: Scrape a single collection page
async function scrapeCollection(slug: string, name: string, totalItems: number): Promise<CollectionData> {
  const url = `${FRAGMENT_BASE}/gifts/${slug}`;
  console.log(`  Scraping ${name} (${slug})...`);
  
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  
  // Get the full text content to parse filter sections
  const fullText = $("body").text();
  
  // Parse each trait type
  const models = parseFilterSection(fullText, "Model");
  const backdrops = parseFilterSection(fullText, "Backdrop");
  const symbols = parseFilterSection(fullText, "Symbol");
  
  // Calculate percentages
  for (const m of models) m.percentage = Math.round((m.count / totalItems) * 1000) / 10;
  for (const b of backdrops) b.percentage = Math.round((b.count / totalItems) * 1000) / 10;
  for (const s of symbols) s.percentage = Math.round((s.count / totalItems) * 1000) / 10;
  
  console.log(`    → ${models.length} models, ${backdrops.length} backdrops, ${symbols.length} symbols`);
  
  return {
    name,
    slug,
    totalItems,
    url,
    models,
    backdrops,
    symbols,
    scrapedAt: new Date().toISOString(),
  };
}

function parseFilterSection(text: string, sectionName: string): TraitInfo[] {
  const traits: TraitInfo[] = [];
  
  // Split text into lines
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  
  // Find the section start: "Model" or "Backdrop" or "Symbol" followed by a number
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === sectionName && i + 1 < lines.length && /^\d+$/.test(lines[i + 1])) {
      sectionStart = i;
      break;
    }
  }
  
  if (sectionStart === -1) return traits;
  
  // Skip: sectionName, totalCount, "Select All"
  let i = sectionStart + 2;
  if (lines[i] === "Select All") i++;
  
  // Parse pairs: name, count
  while (i + 1 < lines.length) {
    const name = lines[i];
    const countStr = lines[i + 1];
    
    // Stop if we hit the next section or non-trait content
    if (name === "Backdrop" || name === "Symbol" || name === "Model") break;
    if (name === "Select All") { i++; continue; }
    
    if (/^[\d,]+$/.test(countStr.replace(/,/g, ""))) {
      const count = parseInt(countStr.replace(/,/g, ""));
      if (count > 0 && name.length > 0 && !/^\d+$/.test(name)) {
        traits.push({ name, count });
      }
      i += 2;
    } else {
      break;
    }
  }
  
  return traits;
}

// Main
async function main() {
  console.log("=== Fragment Gifts Database Scraper ===\n");
  
  const collections = await getCollections();
  
  // Resume support: load existing partial data
  const outPath = new URL("../src/agent/tools/fragment/gifts-database.json", import.meta.url).pathname;
  const { writeFileSync, existsSync, readFileSync } = await import("fs");
  
  let database: CollectionData[] = [];
  const scrapedSlugs = new Set<string>();
  
  if (existsSync(outPath)) {
    try {
      const existing = JSON.parse(readFileSync(outPath, "utf-8"));
      database = existing.collections || [];
      for (const c of database) {
        if (c.models.length > 0) scrapedSlugs.add(c.slug);
      }
      console.log(`Resuming: ${scrapedSlugs.size} already scraped`);
    } catch {}
  }
  
  let totalModels = database.reduce((s, c) => s + c.models.length, 0);
  let totalBackdrops = database.reduce((s, c) => s + c.backdrops.length, 0);
  let totalSymbols = database.reduce((s, c) => s + c.symbols.length, 0);
  
  for (let idx = 0; idx < collections.length; idx++) {
    const { name, slug, totalItems } = collections[idx];
    console.log(`[${idx + 1}/${collections.length}] ${name}`);
    
    if (scrapedSlugs.has(slug)) {
      console.log(`  ⏭️ Already scraped, skipping`);
      continue;
    }
    
    try {
      const data = await scrapeCollection(slug, name, totalItems);
      database.push(data);
      totalModels += data.models.length;
      totalBackdrops += data.backdrops.length;
      totalSymbols += data.symbols.length;
      
      // Save after every collection (crash-safe)
      const partialOutput = {
        metadata: {
          totalCollections: database.length,
          totalGifts: database.reduce((s, c) => s + c.totalItems, 0),
          totalModels, totalBackdrops, totalSymbols,
          scrapedAt: new Date().toISOString(),
          complete: false,
        },
        collections: database,
      };
      writeFileSync(outPath, JSON.stringify(partialOutput, null, 2));
    } catch (err) {
      console.error(`  ❌ Failed: ${err}`);
      // Save partial on error
      database.push({
        name, slug, totalItems, url: `${FRAGMENT_BASE}/gifts/${slug}`,
        models: [], backdrops: [], symbols: [],
        scrapedAt: new Date().toISOString(),
      });
    }
  }
  
  // Write output
  const output = {
    metadata: {
      totalCollections: database.length,
      totalGifts: database.reduce((s, c) => s + c.totalItems, 0),
      totalModels,
      totalBackdrops,
      totalSymbols,
      scrapedAt: new Date().toISOString(),
    },
    collections: database,
  };
  
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  
  console.log(`\n=== Done ===`);
  console.log(`Collections: ${database.length}`);
  console.log(`Total gifts: ${output.metadata.totalGifts.toLocaleString()}`);
  console.log(`Models: ${totalModels} | Backdrops: ${totalBackdrops} | Symbols: ${totalSymbols}`);
  console.log(`Saved to: ${outPath}`);
}

main().catch(console.error);
