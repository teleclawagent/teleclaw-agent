/**
 * Browser-based gift rarity scraper.
 * Run with: node scripts/browser-scrape-gifts.js
 * 
 * Uses Puppeteer to:
 * 1. Open giftstat DataLens rarity page
 * 2. For each collection: select it, paginate through all rows
 * 3. Extract unique model/backdrop/symbol + percentage
 * 4. Save to gifts-rarity-correct.json
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const DATALENS_URL = "https://datalens.yandex/sxnkk2bx16twe?tab=p8";
const OUTPUT = path.join(__dirname, "../src/agent/tools/fragment/gifts-rarity-correct.json");
const DB_PATH = path.join(__dirname, "../src/agent/tools/fragment/gifts-database.json");

function parseTraits(text) {
  const traits = { models: {}, backdrops: {}, symbols: {} };
  const rows = text.match(/#\d+[\s\S]*?(?=#\d+|Rows:|$)/g) || [];
  
  for (const row of rows) {
    const mMatch = row.match(/M:\s*(.+?)\s*-\s*([\d.]+)%/);
    const bMatch = row.match(/B:\s*(.+?)\s*-\s*([\d.]+)%/);
    const sMatch = row.match(/S:\s*(.+?)\s*-\s*([\d.]+)%/);
    
    if (mMatch) traits.models[mMatch[1].trim()] = parseFloat(mMatch[2]);
    if (bMatch) traits.backdrops[bMatch[1].trim()] = parseFloat(bMatch[2]);
    if (sMatch) traits.symbols[sMatch[1].trim()] = parseFloat(sMatch[2]);
  }
  
  return traits;
}

async function main() {
  // Load existing DB to get collection names
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  const collectionNames = db.collections.map(c => c.name);
  
  // Load existing progress
  let result = {};
  if (fs.existsSync(OUTPUT)) {
    try { result = JSON.parse(fs.readFileSync(OUTPUT, "utf-8")); } catch {}
  }
  
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  console.log("Opening DataLens...");
  await page.goto(DATALENS_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForTimeout(5000);
  
  // Get current collection name
  const getCollectionName = async () => {
    return page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/Collection:\*\s*(.+?)(?:\s*\d|\s*Model)/);
      return match ? match[1].trim() : null;
    });
  };
  
  // Extract traits from current page
  const extractTraits = async () => {
    return page.evaluate(() => {
      const text = document.body.innerText;
      const traits = { models: {}, backdrops: {}, symbols: {} };
      // Split by gift entries
      const entries = text.split(/(?=#\d+\n)/);
      for (const entry of entries) {
        const mMatch = entry.match(/M:\s*(.+?)\s*-\s*([\d.]+)%/);
        const bMatch = entry.match(/B:\s*(.+?)\s*-\s*([\d.]+)%/);
        const sMatch = entry.match(/S:\s*(.+?)\s*-\s*([\d.]+)%/);
        if (mMatch) traits.models[mMatch[1].trim()] = parseFloat(mMatch[2]);
        if (bMatch) traits.backdrops[bMatch[1].trim()] = parseFloat(bMatch[2]);
        if (sMatch) traits.symbols[sMatch[1].trim()] = parseFloat(sMatch[2]);
      }
      return traits;
    });
  };
  
  // Click next page
  const nextPage = async () => {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await btn.evaluate(el => el.textContent);
      // The "next" button is typically an arrow or ">"
    }
    // Use the spinbutton + next button approach
    const nextBtn = await page.$('button[aria-label="Next"]');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(3000);
      return true;
    }
    return false;
  };
  
  // Get current collection and extract
  const currentCol = await getCollectionName();
  console.log(`Current collection: ${currentCol}`);
  
  const traits = await extractTraits();
  console.log(`Models: ${Object.keys(traits.models).length}, Backdrops: ${Object.keys(traits.backdrops).length}, Symbols: ${Object.keys(traits.symbols).length}`);
  
  result[currentCol] = traits;
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  
  // TODO: Iterate through collections using the dropdown selector
  // For now, save what we have
  
  await browser.close();
  console.log("Done. Saved to", OUTPUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
