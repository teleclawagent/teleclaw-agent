/**
 * Shared OTC Matchmaker API Client
 *
 * Connects local Teleclaw instances to a shared matchmaker pool.
 * Falls back to local-only mode if the API is unavailable.
 *
 * Architecture:
 * - Each Teleclaw instance has its own local SQLite (always works)
 * - If MATCHMAKER_API_URL is configured, listings sync to shared pool
 * - Matches from shared pool are pulled down to local
 * - API is optional — local matchmaking always works as before
 */

import { createLogger } from "../../../utils/logger.js";
import { fetchWithTimeout } from "../../../utils/fetch.js";

const log = createLogger("MatchmakerAPI");

export interface SharedListing {
  id: string;
  type: "username" | "gift";
  item_name: string;
  item_details: Record<string, unknown>;
  seller_bot_id: string; // Bot's Telegram ID (for callback routing)
  seller_chat_id: string; // Seller's chat ID on their local bot
  price_ton: number;
  price_stars?: number;
  created_at: string;
  expires_at?: string;
}

export interface SharedInterest {
  listing_id: string;
  buyer_bot_id: string;
  buyer_chat_id: string;
  max_price_ton?: number;
  message?: string;
  created_at: string;
}

export interface SharedMatch {
  listing_id: string;
  seller_bot_id: string;
  seller_chat_id: string;
  buyer_bot_id: string;
  buyer_chat_id: string;
  item_name: string;
  price_ton: number;
  matched_at: string;
}

export class MatchmakerAPIClient {
  private apiUrl: string | null;
  private botId: string;
  private apiKey?: string;

  constructor(config: { apiUrl?: string; botId: string; apiKey?: string }) {
    this.apiUrl = config.apiUrl || null;
    this.botId = config.botId;
    this.apiKey = config.apiKey;
  }

  get isConnected(): boolean {
    return this.apiUrl !== null;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Bot-Id": this.botId,
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  // ── Listings ──

  async publishListing(listing: Omit<SharedListing, "id" | "created_at" | "seller_bot_id">): Promise<string | null> {
    if (!this.apiUrl) return null;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/listings`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ ...listing, seller_bot_id: this.botId }),
      });
      if (!res.ok) {
        log.warn(`Failed to publish listing: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { id: string };
      return data.id;
    } catch (error) {
      log.warn({ err: error }, "Matchmaker API unreachable — operating in local mode");
      return null;
    }
  }

  async removeListing(listingId: string): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/listings/${listingId}`, {
        method: "DELETE",
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async browseListings(filters?: {
    type?: "username" | "gift";
    maxPrice?: number;
    search?: string;
    limit?: number;
  }): Promise<SharedListing[]> {
    if (!this.apiUrl) return [];
    try {
      const params = new URLSearchParams();
      if (filters?.type) params.set("type", filters.type);
      if (filters?.maxPrice) params.set("max_price", filters.maxPrice.toString());
      if (filters?.search) params.set("q", filters.search);
      if (filters?.limit) params.set("limit", filters.limit.toString());

      const res = await fetchWithTimeout(`${this.apiUrl}/listings?${params.toString()}`, {
        headers: this.headers,
      });
      if (!res.ok) return [];
      return (await res.json()) as SharedListing[];
    } catch {
      return [];
    }
  }

  // ── Interests ──

  async expressInterest(interest: Omit<SharedInterest, "buyer_bot_id" | "created_at">): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/interests`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ ...interest, buyer_bot_id: this.botId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Matches ──

  async getMatches(): Promise<SharedMatch[]> {
    if (!this.apiUrl) return [];
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/matches?bot_id=${this.botId}`, {
        headers: this.headers,
      });
      if (!res.ok) return [];
      return (await res.json()) as SharedMatch[];
    } catch {
      return [];
    }
  }

  // ── Health ──

  async ping(): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/health`, {
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Create a matchmaker API client from config.
 * Returns a client that operates in local-only mode if no API URL is configured.
 */
export function createMatchmakerClient(config: {
  matchmakerApiUrl?: string;
  botId: string;
  apiKey?: string;
}): MatchmakerAPIClient {
  const client = new MatchmakerAPIClient({
    apiUrl: config.matchmakerApiUrl,
    botId: config.botId,
    apiKey: config.apiKey,
  });

  if (client.isConnected) {
    log.info(`Matchmaker API: ${config.matchmakerApiUrl}`);
  } else {
    log.info("Matchmaker: local-only mode (no shared API configured)");
  }

  return client;
}
