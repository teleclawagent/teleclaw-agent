#!/usr/bin/env python3
"""Fetch all gift data from api.changes.tg and build gifts-database.json"""
import json
import time
import urllib.request
import sys

API = "https://api.changes.tg"
OUTPUT = "/Users/g/.openclaw/workspace/teleclaw-agent/src/agent/tools/fragment/gifts-database.json"

def fetch(path):
    url = f"{API}{path}"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 TeleClaw/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt < 2:
                time.sleep(1)
            else:
                print(f"  FAILED: {url} - {e}", file=sys.stderr)
                return None

def main():
    # Get all gift names
    gifts = fetch("/gifts")
    print(f"Total gifts: {len(gifts)}")
    
    # Get totals
    totals = fetch("/total")
    print(f"Totals: {totals}")
    
    # Get all backdrops (global list)
    all_backdrops = fetch("/backdrops")
    
    collections = []
    
    for i, gift_name in enumerate(gifts):
        slug = gift_name.lower().replace(" ", "-")
        print(f"[{i+1}/{len(gifts)}] {gift_name}...")
        
        # Get gift info
        gift_info = fetch(f"/gift/{slug}")
        if not gift_info:
            print(f"  Skipping {gift_name}")
            continue
        
        # Get models with rarity
        models_data = fetch(f"/models/{slug}?sorted")
        
        # Get backdrops with rarity
        backdrops_data = fetch(f"/backdrops/{slug}?sorted")
        
        # Get symbols with rarity
        symbols_data = fetch(f"/symbols/{slug}?sorted")
        
        # Build collection entry
        gift_meta = gift_info.get("gift", {})
        
        models = []
        if models_data:
            for m in models_data:
                models.append({
                    "name": m["name"],
                    "rarityPermille": m.get("rarityPermille", 0),
                    "percentage": round(m.get("rarityPermille", 0) / 10, 2)
                })
        
        backdrops = []
        if backdrops_data:
            for b in backdrops_data:
                entry = {
                    "name": b["name"],
                    "rarityPermille": b.get("rarityPermille", 0),
                    "percentage": round(b.get("rarityPermille", 0) / 10, 2)
                }
                if "hex" in b:
                    entry["colors"] = b["hex"]
                backdrops.append(entry)
        
        symbols = []
        if symbols_data:
            for s in symbols_data:
                symbols.append({
                    "name": s["name"],
                    "rarityPermille": s.get("rarityPermille", 0),
                    "percentage": round(s.get("rarityPermille", 0) / 10, 2)
                })
        
        collection = {
            "name": gift_name,
            "id": gift_meta.get("id", ""),
            "customEmojiId": gift_meta.get("customEmojiId", ""),
            "slug": slug,
            "totalModels": len(models),
            "totalBackdrops": len(backdrops),
            "totalSymbols": len(symbols),
            "models": models,
            "backdrops": backdrops,
            "symbols": symbols
        }
        
        # Also include model rarity tiers from gift info
        if "models" in gift_info:
            rarity_map = {}
            for m in gift_info["models"]:
                r = m.get("rarity", 0)
                rarity_map[r] = rarity_map.get(r, 0) + 1
            collection["rarityDistribution"] = rarity_map
        
        collections.append(collection)
        
        # Small delay to be nice
        if (i + 1) % 10 == 0:
            time.sleep(0.5)
    
    # Build final database
    db = {
        "metadata": {
            "source": "api.changes.tg",
            "totalCollections": len(collections),
            "totalModels": totals.get("models", 0),
            "totalBackdrops": totals.get("backdrops", 0),
            "totalSymbols": totals.get("patterns", 0),
            "scrapedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        },
        "collections": collections
    }
    
    with open(OUTPUT, "w") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
    
    print(f"\n✅ Saved {len(collections)} collections to {OUTPUT}")
    print(f"   Models: {sum(c['totalModels'] for c in collections)}")
    print(f"   Backdrops: {sum(c['totalBackdrops'] for c in collections)}")
    print(f"   Symbols: {sum(c['totalSymbols'] for c in collections)}")

if __name__ == "__main__":
    main()
