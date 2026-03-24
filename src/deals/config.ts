/**
 * Deals/OTC Configuration (matchmaker-only)
 * Escrow settings removed — Teleclaw never handles funds.
 */

import type { DealsConfig } from "../config/schema.js";

export const DEALS_CONFIG = {
  // Listing expiry defaults (for matchmaker listings)
  defaultListingDays: 14,
};

/**
 * Initialize deals config from YAML values (called at startup)
 */
export function initDealsConfig(yaml?: DealsConfig): void {
  if (!yaml) return;
  // Future: add matchmaker-specific config here
}
