/**
 * 🎁 Gift Market Intelligence — Shared Types
 *
 * Central types for the gift market data layer.
 * All marketplace adapters and tools use these interfaces.
 */

// ─── Collection Mapping ──────────────────────────────────────────────

export interface GiftCollectionMap {
  /** Gift name (e.g. "Plush Pepe") */
  name: string;
  /** TON NFT collection contract address (raw format) */
  address: string;
  /** TonAPI display name (e.g. "Plush Pepes · collection") */
  tonapiName?: string;
  /** Slug for marketplace URLs */
  slug?: string;
}

// ─── Floor Prices ────────────────────────────────────────────────────

export interface FloorPriceEntry {
  collection: string;
  floorTon: number | null;
  floorStars: number | null;
  /** Model-level floor prices (if requested) */
  modelFloors?: Array<{
    model: string;
    floorTon: number | null;
    listingCount: number;
  }>;
  /** Per-marketplace breakdown */
  byMarketplace: Record<
    string,
    {
      floorTon: number | null;
      listingCount: number;
      url?: string;
    }
  >;
  totalListings: number;
  fetchedAt: string;
}

// ─── Last Sales ──────────────────────────────────────────────────────

export interface SaleEvent {
  collection: string;
  giftNum?: number;
  model?: string;
  backdrop?: string;
  symbol?: string;
  priceTon: number;
  priceUsd?: number;
  marketplace?: string;
  buyer?: string;
  seller?: string;
  txHash: string;
  timestamp: string; // ISO
  nftAddress: string;
}

// ─── Market Actions ──────────────────────────────────────────────────

export type MarketActionType = "buy" | "listing" | "delist" | "price_change" | "transfer";

export interface MarketAction {
  type: MarketActionType;
  collection: string;
  giftNum?: number;
  model?: string;
  backdrop?: string;
  symbol?: string;
  priceTon?: number;
  priceUsd?: number;
  marketplace?: string;
  actor?: string; // buyer or seller address
  txHash?: string;
  timestamp: string; // ISO
  nftAddress: string;
}

// ─── User Inventory ──────────────────────────────────────────────────

export interface UserGift {
  collection: string;
  giftNum?: number;
  model?: string;
  backdrop?: string;
  symbol?: string;
  modelRarity?: number; // permille
  backdropRarity?: number;
  symbolRarity?: number;
  combinedRarityPercent?: number;
  tier?: "Legendary" | "Epic" | "Rare" | "Uncommon" | "Common";
  estimatedValueTon?: number;
  nftAddress: string;
}

export interface UserInventory {
  username?: string;
  telegramId?: number;
  walletAddress?: string;
  gifts: UserGift[];
  totalGifts: number;
  totalValueTon?: number;
  totalValueUsd?: number;
  fetchedAt: string;
}

// ─── Price History ───────────────────────────────────────────────────

export interface PriceSnapshot {
  collection: string;
  floorTon: number | null;
  totalListings: number;
  timestamp: string; // ISO
}

export interface PriceHistory {
  collection: string;
  snapshots: PriceSnapshot[];
  period: "24h" | "7d" | "30d";
  changePercent?: number;
}

// ─── Upgrade Stats ───────────────────────────────────────────────────

export interface UpgradeStat {
  date: string; // YYYY-MM-DD
  totalUpgrades: number;
  byCollection: Record<string, number>;
}

// ─── Marketplace Adapter Interface ───────────────────────────────────

export type MarketplaceId = "getgems" | "tonnel" | "portals" | "mrkt" | "fragment" | "telegram";

export interface MarketplaceConfig {
  id: MarketplaceId;
  apiKey?: string;
  enabled: boolean;
  baseUrl: string;
}

export interface GiftMarketAdapter {
  id: MarketplaceId;
  name: string;

  /** Check if this adapter is operational */
  isAvailable(): Promise<boolean>;

  /** Get floor prices for a collection */
  getFloorPrice(collection: string, collectionAddress?: string): Promise<FloorPriceEntry | null>;

  /** Get active listings */
  getListings(params: {
    collection?: string;
    model?: string;
    backdrop?: string;
    symbol?: string;
    minPrice?: number;
    maxPrice?: number;
    limit?: number;
  }): Promise<SaleEvent[]>;

  /** Get recent sales */
  getRecentSales(collection: string, limit?: number): Promise<SaleEvent[]>;
}
