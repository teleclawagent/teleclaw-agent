/**
 * 🏪 Marketplace Adapter Types
 *
 * Unified interface for all marketplaces that trade
 * usernames, anonymous numbers, and gifts.
 */

// ─── Asset Types ─────────────────────────────────────────────────────

export type AssetKind = "username" | "number" | "gift";

// ─── Marketplace IDs ─────────────────────────────────────────────────

export type MarketplaceId =
  | "fragment" // fragment.com — usernames, numbers, gifts (on-chain & off-chain)
  | "marketapp" // market.app — usernames, numbers, gifts (rebranded Whales Market)
  | "getgems" // getgems.io — usernames, numbers, gifts (on-chain & off-chain)
  | "tonnel" // tonnel.network — off-chain gifts only
  | "portals" // portals.to — off-chain gifts only
  | "mrkt"; // mrkt.tg — gifts only

// ─── Which marketplaces support which assets ─────────────────────────

export const MARKETPLACE_SUPPORT: Record<MarketplaceId, AssetKind[]> = {
  fragment: ["username", "number", "gift"],
  marketapp: ["username", "number", "gift"],
  getgems: ["username", "number", "gift"],
  tonnel: ["gift"],
  portals: ["gift"],
  mrkt: ["gift"],
};

/** Get all marketplaces that support a given asset type */
export function getMarketplacesForAsset(asset: AssetKind): MarketplaceId[] {
  return (Object.entries(MARKETPLACE_SUPPORT) as [MarketplaceId, AssetKind[]][])
    .filter(([, kinds]) => kinds.includes(asset))
    .map(([id]) => id);
}

// ─── Listing (unified across all marketplaces) ──────────────────────

export interface MarketplaceListing {
  /** Source marketplace */
  marketplace: MarketplaceId;
  /** Asset type */
  assetKind: AssetKind;

  /** Unique identifier on the marketplace */
  externalId: string;
  /** Deep link or URL to the listing */
  url: string;

  // ─── Username/Number fields ────
  /** Username (without @) or number (with +888) */
  identifier?: string;

  // ─── Gift fields ────
  /** Gift collection name */
  collection?: string;
  /** Gift number within collection */
  giftNum?: number;
  /** Model name */
  model?: string;
  /** Backdrop name */
  backdrop?: string;
  /** Symbol name */
  symbol?: string;
  /** Rarity tier (if available) */
  rarityTier?: string;

  // ─── Price ────
  /** Price in TON (normalized) */
  priceTon: number | null;
  /** Price in Stars (if listed in Stars) */
  priceStars?: number | null;
  /** Original currency as listed */
  originalCurrency: string;
  /** Original price as listed */
  originalPrice: number | null;

  // ─── Listing metadata ────
  /** Seller address or username */
  seller?: string;
  /** Listing type: auction, fixed, offer */
  listingType: "auction" | "fixed" | "offer";
  /** When the listing ends (for auctions) */
  endsAt?: string;
  /** Whether it's on-chain or off-chain */
  onChain: boolean;

  /** Collection floor price in TON (from aggregated data) */
  floorPriceTon?: number;
  /** Total items on sale in the collection */
  onSaleCount?: number;
  /** Total unique owners */
  ownerCount?: number;

  /** Raw data from the marketplace (for debugging) */
  raw?: unknown;
}

// ─── Adapter Interface ──────────────────────────────────────────────

export interface MarketplaceAdapter {
  /** Marketplace identifier */
  id: MarketplaceId;
  /** Human-readable name */
  name: string;
  /** Which asset types this adapter supports */
  supports: AssetKind[];

  /**
   * Search listings for a given asset.
   * Returns normalized MarketplaceListing[] sorted by price (low→high).
   */
  search(params: SearchParams): Promise<MarketplaceListing[]>;

  /**
   * Get a specific listing by its identifier.
   * For usernames: the username string
   * For numbers: the +888 number
   * For gifts: marketplace-specific ID
   */
  getListing(assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null>;

  /**
   * Check if this adapter is currently available (API reachable).
   * Returns false if rate-limited, CF-blocked, or auth expired.
   */
  isAvailable(): Promise<boolean>;
}

// ─── Search Params ──────────────────────────────────────────────────

export interface SearchParams {
  assetKind: AssetKind;

  // ─── Filters ────
  /** Username or number keyword search */
  query?: string;
  /** Gift collection name */
  collection?: string;
  /** Gift model/backdrop/symbol filters */
  model?: string;
  backdrop?: string;
  symbol?: string;
  /** Min rarity tier */
  minTier?: string;
  /** Price range */
  maxPrice?: number;
  minPrice?: number;
  /** Currency to filter by */
  currency?: string;

  // ─── Pagination ────
  limit?: number;
  offset?: number;

  // ─── Sorting ────
  sortBy?: "price" | "rarity" | "newest";
}

// ─── Aggregated Result ──────────────────────────────────────────────

export interface AggregatedResult {
  /** All listings across marketplaces, sorted by price */
  listings: MarketplaceListing[];
  /** Which marketplaces were checked */
  marketplacesChecked: MarketplaceId[];
  /** Which marketplaces failed/were unavailable */
  marketplacesFailed: MarketplaceId[];
  /** Best deal (lowest price) */
  bestDeal: MarketplaceListing | null;
  /** Total listings found */
  totalFound: number;
  /** Price range */
  priceRange: {
    lowest: number | null;
    highest: number | null;
    marketplace_lowest: MarketplaceId | null;
  };
}
