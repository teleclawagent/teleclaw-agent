/**
 * Shared OTC Matchmaker API Client
 *
 * Connects local Teleclaw instances to a shared anonymous matchmaker pool.
 * Falls back to local-only mode if the API is unavailable.
 *
 * PRIVACY: No user data ever leaves the local bot instance.
 * The shared API only stores: item info, price, bot_id, listing_id.
 * User identities stay in each bot's local SQLite.
 */

import { createLogger } from "../../../utils/logger.js";
import { fetchWithTimeout } from "../../../utils/fetch.js";

const log = createLogger("MatchmakerAPI");

// ─── Types ───────────────────────────────────────────────────────────

export interface SharedListing {
  id: string;
  type: "username" | "gift" | "number";
  item_name: string;
  item_details: Record<string, unknown>;
  bot_id: string; // Bot's unique ID (for routing callbacks)
  price: number | null;
  currency: string;
  price_usd: number | null; // Normalized for cross-currency matching
  created_at: string;
  expires_at: string;
}

export interface SharedInterestSignal {
  listing_id: string;
  buyer_bot_id: string; // Which bot the buyer is on
  offer_price?: number;
  offer_currency?: string;
  message?: string; // Optional message (no user identifiers)
}

export interface SharedCallback {
  type: "interest" | "sold" | "cancelled";
  listing_id: string;
  from_bot_id: string;
  data?: Record<string, unknown>;
}

// ─── Client ──────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://otc.teleclaw.ai";

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

  // ── Publish Listing (anonymous) ──

  async publishListing(listing: {
    type: "username" | "gift" | "number";
    item_name: string;
    item_details: Record<string, unknown>;
    price: number | null;
    currency: string;
    price_usd: number | null;
    expires_days?: number;
  }): Promise<string | null> {
    if (!this.apiUrl) return null;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/api/listings`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...listing,
          bot_id: this.botId,
        }),
      });
      if (!res.ok) {
        log.warn(`Failed to publish listing: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { id: string };
      return data.id;
    } catch (error) {
      log.debug({ err: error }, "Matchmaker API unreachable — local-only mode");
      return null;
    }
  }

  // ── Remove Listing ──

  async removeListing(listingId: string): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/api/listings/${listingId}`, {
        method: "DELETE",
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Browse Listings (from other bots) ──

  async browseListings(filters?: {
    type?: "username" | "gift" | "number";
    max_price_usd?: number;
    search?: string;
    limit?: number;
  }): Promise<SharedListing[]> {
    if (!this.apiUrl) return [];
    try {
      const params = new URLSearchParams();
      if (filters?.type) params.set("type", filters.type);
      if (filters?.max_price_usd) params.set("max_price_usd", filters.max_price_usd.toString());
      if (filters?.search) params.set("q", filters.search);
      if (filters?.limit) params.set("limit", filters.limit.toString());
      // Exclude own bot's listings
      params.set("exclude_bot", this.botId);

      const res = await fetchWithTimeout(`${this.apiUrl}/api/listings?${params.toString()}`, {
        headers: this.headers,
      });
      if (!res.ok) return [];
      return (await res.json()) as SharedListing[];
    } catch {
      return [];
    }
  }

  // ── Signal Interest (anonymous — only bot_id, no user info) ──

  async signalInterest(signal: {
    listing_id: string;
    offer_price?: number;
    offer_currency?: string;
    message?: string;
  }): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/api/interests`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...signal,
          buyer_bot_id: this.botId,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Poll for callbacks (interest signals from other bots) ──

  async pollCallbacks(): Promise<SharedCallback[]> {
    if (!this.apiUrl) return [];
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/api/callbacks?bot_id=${this.botId}`, {
        headers: this.headers,
      });
      if (!res.ok) return [];
      return (await res.json()) as SharedCallback[];
    } catch {
      return [];
    }
  }

  // ── Acknowledge callback (mark as processed) ──

  async ackCallback(callbackId: string): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/api/callbacks/${callbackId}/ack`, {
        method: "POST",
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Health ──

  async ping(): Promise<boolean> {
    if (!this.apiUrl) return false;
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/api/health`, {
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
    apiUrl: config.matchmakerApiUrl || DEFAULT_API_URL,
    botId: config.botId,
    apiKey: config.apiKey,
  });

  if (client.isConnected) {
    log.info(`Matchmaker API: ${config.matchmakerApiUrl || DEFAULT_API_URL}`);
  } else {
    log.info("Matchmaker: local-only mode");
  }

  return client;
}
