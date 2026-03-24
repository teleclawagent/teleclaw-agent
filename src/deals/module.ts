/**
 * Deals module — matchmaker-only (no escrow, no fund transfers).
 * Teleclaw connects buyers and sellers; trades happen directly between parties.
 */

import type { PluginModule } from "../agent/tools/types.js";
import { initDealsConfig } from "./config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Deal");

const dealsModule: PluginModule = {
  name: "deals",
  version: "2.0.0",

  configure(config) {
    initDealsConfig(config.deals);
  },

  tools() {
    // Matchmaker tools are registered via fragment module (matchmaker.ts, gift-matchmaker.ts, number-profile.ts)
    // No escrow deal tools here
    return [];
  },

  async start() {
    log.info("OTC matchmaker module ready (matchmaker-only, no escrow)");
  },

  async stop() {
    // Nothing to clean up
  },
};

export default dealsModule;

// Legacy exports — no-op stubs for any remaining references
export function setBotPreMiddleware(): void {
  // No-op: DealBot removed
}
export function getDealBot(): null {
  return null;
}
