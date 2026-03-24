/**
 * 🔗 TonAPI Service for Gift Market
 *
 * On-chain data: NFT ownership, transfer history, sale events.
 * Uses existing tonapiFetch() helper with rate limiting.
 */

import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftTonAPI");

const CACHE_TTL = 5 * 60 * 1000; // 5 min cache
const cache = new Map<string, { data: unknown; ts: number }>();

function getCached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return e.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Types ───────────────────────────────────────────────────────────

export interface TonNFTItem {
  address: string;
  index: number;
  collection?: {
    address: string;
    name: string;
  };
  metadata?: Record<string, unknown>;
  owner?: {
    address: string;
    name?: string;
  };
  sale?: {
    price: { value: string; token_name: string };
    marketplace?: string;
  };
}

export interface TonTransferEvent {
  type: string;
  timestamp: number;
  nftAddress: string;
  from?: string;
  to?: string;
  priceTon?: number;
  txHash?: string;
}

// ─── NFTs by Collection ──────────────────────────────────────────────

export async function getCollectionNFTs(
  collectionAddress: string,
  limit = 50,
  offset = 0
): Promise<TonNFTItem[]> {
  const cacheKey = `col-nfts:${collectionAddress}:${limit}:${offset}`;
  const cached = getCached<TonNFTItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const res = await tonapiFetch(
      `/nfts/collections/${collectionAddress}/items?limit=${limit}&offset=${offset}`
    );
    if (!res.ok) {
      log.warn({ status: res.status, collectionAddress }, "TonAPI collection items failed");
      return [];
    }
    const data = await res.json();
    const items = (data.nft_items || []) as TonNFTItem[];
    setCache(cacheKey, items);
    return items;
  } catch (err) {
    log.error({ err, collectionAddress }, "getCollectionNFTs error");
    return [];
  }
}

// ─── NFT Transfer/Sale History ───────────────────────────────────────

export async function getNFTHistory(nftAddress: string, limit = 20): Promise<TonTransferEvent[]> {
  const cacheKey = `nft-hist:${nftAddress}:${limit}`;
  const cached = getCached<TonTransferEvent[]>(cacheKey);
  if (cached) return cached;

  try {
    const res = await tonapiFetch(`/nfts/${nftAddress}/history?limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();

    const events: TonTransferEvent[] = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data.events || []).map((e: any) => {
        const action = e.actions?.[0];
        const nftTransfer = action?.NftItemTransfer;
        const tonTransfer = action?.TonTransfer;

        return {
          type: action?.type || "unknown",
          timestamp: e.timestamp,
          nftAddress,
          from: nftTransfer?.sender?.address || tonTransfer?.sender?.address,
          to: nftTransfer?.recipient?.address || tonTransfer?.recipient?.address,
          priceTon: tonTransfer ? Number(tonTransfer.amount) / 1e9 : undefined,
          txHash: e.event_id,
        };
      });

    setCache(cacheKey, events);
    return events;
  } catch (err) {
    log.error({ err, nftAddress }, "getNFTHistory error");
    return [];
  }
}

// ─── User NFTs (by wallet) ──────────────────────────────────────────

export async function getUserNFTs(
  walletAddress: string,
  collectionFilter?: string
): Promise<TonNFTItem[]> {
  const cacheKey = `user-nfts:${walletAddress}:${collectionFilter || "all"}`;
  const cached = getCached<TonNFTItem[]>(cacheKey);
  if (cached) return cached;

  try {
    let path = `/accounts/${walletAddress}/nfts?limit=1000&indirect_ownership=true`;
    if (collectionFilter) {
      path += `&collection=${collectionFilter}`;
    }

    const res = await tonapiFetch(path);
    if (!res.ok) {
      log.warn({ status: res.status, walletAddress }, "TonAPI user NFTs failed");
      return [];
    }
    const data = await res.json();
    const items = (data.nft_items || []) as TonNFTItem[];
    setCache(cacheKey, items);
    return items;
  } catch (err) {
    log.error({ err, walletAddress }, "getUserNFTs error");
    return [];
  }
}

// ─── Resolve Username to Wallet ──────────────────────────────────────

export async function resolveUsernameToWallet(username: string): Promise<string | null> {
  const clean = username.replace(/^@/, "");
  const cacheKey = `resolve:${clean}`;
  const cached = getCached<string | null>(cacheKey);
  if (cached !== null) return cached;

  try {
    // Try TON DNS: {username}.t.me
    const dnsName = `${clean}.t.me`;
    const res = await tonapiFetch(`/dns/${encodeURIComponent(dnsName)}/resolve`);
    if (res.ok) {
      const data = await res.json();
      const wallet = data.wallet?.address;
      if (wallet) {
        setCache(cacheKey, wallet);
        return wallet;
      }
    }
  } catch {
    // Try .ton domain
  }

  try {
    const res = await tonapiFetch(`/dns/${encodeURIComponent(`${clean}.ton`)}/resolve`);
    if (res.ok) {
      const data = await res.json();
      const wallet = data.wallet?.address;
      if (wallet) {
        setCache(cacheKey, wallet);
        return wallet;
      }
    }
  } catch {
    // Not found
  }

  setCache(cacheKey, "");
  return null;
}

// ─── TON Price ───────────────────────────────────────────────────────

let _tonPriceCache: { usd: number; ts: number } | null = null;

export async function getTonPriceUsd(): Promise<number> {
  if (_tonPriceCache && Date.now() - _tonPriceCache.ts < 5 * 60 * 1000) {
    return _tonPriceCache.usd;
  }

  // Try TonAPI first
  try {
    const res = await tonapiFetch("/rates?tokens=ton&currencies=usd");
    if (res.ok) {
      const data = await res.json();
      const usd = parseFloat(data.rates?.TON?.prices?.USD || "0");
      if (usd > 0) {
        _tonPriceCache = { usd, ts: Date.now() };
        return usd;
      }
    }
  } catch {
    // TonAPI failed, try fallback
  }

  // Fallback: CoinGecko
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd",
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      const usd = data?.["the-open-network"]?.usd;
      if (usd && usd > 0) {
        _tonPriceCache = { usd, ts: Date.now() };
        return usd;
      }
    }
  } catch {
    // CoinGecko also failed
  }

  return _tonPriceCache?.usd || 0;
}

// ─── Collection Events (buys/transfers) ──────────────────────────────

export async function getCollectionEvents(
  collectionAddress: string,
  limit = 20
): Promise<TonTransferEvent[]> {
  const cacheKey = `col-events:${collectionAddress}:${limit}`;
  const cached = getCached<TonTransferEvent[]>(cacheKey);
  if (cached) return cached;

  try {
    const res = await tonapiFetch(`/events?account=${collectionAddress}&limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();

    const events: TonTransferEvent[] = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data.events || []).map((e: any) => {
        const action = e.actions?.[0];
        return {
          type: action?.type || "unknown",
          timestamp: e.timestamp,
          nftAddress: collectionAddress,
          from: action?.NftItemTransfer?.sender?.address,
          to: action?.NftItemTransfer?.recipient?.address,
          priceTon: action?.TonTransfer ? Number(action.TonTransfer.amount) / 1e9 : undefined,
          txHash: e.event_id,
        };
      });

    setCache(cacheKey, events);
    return events;
  } catch (err) {
    log.error({ err }, "getCollectionEvents error");
    return [];
  }
}
