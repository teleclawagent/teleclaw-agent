/**
 * 🎁 Gift Market Intelligence Module
 *
 * 7 tools for comprehensive gift market data:
 * - gift_floor_prices: Floor prices across collections
 * - gift_last_sales: Recent completed sales
 * - gift_price_history: Price trends (24h/7d/30d)
 * - gift_market_feed: Active listings and market activity
 * - gift_user_inventory: Scan any user's gifts
 * - gift_profile_value: Portfolio valuation
 * - gift_upgrade_stats: Upgrade/mint statistics
 *
 * Data sources:
 * - Fragment.com scraping (no key needed)
 * - TonAPI (NFT/wallet data, no key for basic)
 * - SQLite (price history snapshots)
 *
 * Marketplace API keys (GetGems, Tonnel, Portals, MRKT) can be
 * added later for better coverage — adapters auto-detect keys in config.
 */

export { tools } from "./tools.js";
export { snapshotFloorPrices } from "./price-history.js";
export type { FragmentFloorData, FragmentListing, FragmentSale } from "./fragment-scraper.js";
export type { TonNFTItem, TonTransferEvent } from "./tonapi-service.js";
