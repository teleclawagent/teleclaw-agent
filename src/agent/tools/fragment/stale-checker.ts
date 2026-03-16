/**
 * Periodic stale listing checker + expired listing cleanup.
 * Called from the main app on a timer to remind sellers and expire old listings.
 */
import type { ToolContext } from "../types.js";
import type { TelegramTransport } from "../../../telegram/transport.js";
import { getStaleListings, markListingReminded } from "./gift-matchmaker.js";
import { getStaleUsernameListings, markUsernameListingReminded } from "./matchmaker.js";
import { getStaleNumberListings, markNumberListingReminded } from "./number-profile.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("StaleChecker");

/**
 * Check for stale listings (active 48h+ with matches, no update)
 * and send reminders to sellers via DM.
 */
export async function checkStaleListings(
  ctx: ToolContext,
  bridge: TelegramTransport
): Promise<{ reminded: number }> {
  let reminded = 0;

  // Gift listings
  try {
    const staleGifts = getStaleListings(ctx);
    for (const listing of staleGifts) {
      try {
        await bridge.sendMessage({
          chatId: String(listing.seller_id),
          text:
            `⏰ Reminder: Your gift listing is still active.\n\n` +
            `🎁 ${listing.collection}${listing.gift_num ? " #" + listing.gift_num : ""} — ${listing.model}\n` +
            `Listed ${new Date(listing.created_at).toLocaleDateString()}\n` +
            `${listing.match_count} interested buyer(s)\n\n` +
            `Still available? Great, no action needed.\n` +
            `Sold? Tell me "mark listing as sold".\n` +
            `Want to cancel? Tell me "cancel listing".`,
        });
        markListingReminded(ctx, listing.id);
        reminded++;
      } catch (err) {
        log.warn({ err, listingId: listing.id }, "Failed to send gift stale reminder");
      }
    }
  } catch (err) {
    log.error({ err }, "Failed to check stale gift listings");
  }

  // Username listings
  try {
    const staleUsernames = getStaleUsernameListings(ctx);
    for (const listing of staleUsernames) {
      try {
        await bridge.sendMessage({
          chatId: String(listing.seller_id),
          text:
            `⏰ Reminder: Your username listing is still active.\n\n` +
            `🔗 ${listing.username} — ${listing.asking_price ? listing.asking_price + " TON" : "offers welcome"}\n` +
            `Listed ${new Date(listing.created_at as string).toLocaleDateString()}\n` +
            `${listing.match_count} interested buyer(s)\n\n` +
            `Still available? Great, no action needed.\n` +
            `Sold? Tell me "mark username as sold".\n` +
            `Want to cancel? Tell me "cancel listing".`,
        });
        markUsernameListingReminded(ctx, listing.id as string);
        reminded++;
      } catch (err) {
        log.warn({ err, listingId: listing.id }, "Failed to send username stale reminder");
      }
    }
  } catch (err) {
    log.error({ err }, "Failed to check stale username listings");
  }

  // Number listings
  try {
    const staleNumbers = getStaleNumberListings(ctx);
    for (const listing of staleNumbers) {
      try {
        await bridge.sendMessage({
          chatId: String(listing.seller_id),
          text:
            `⏰ Reminder: Your number listing is still active.\n\n` +
            `📞 ${listing.number} — ${listing.price ? listing.price + " TON" : "Price TBD"}\n` +
            `🏆 ${listing.tier} (${listing.score}/100)\n\n` +
            `Still available? Great, no action needed.\n` +
            `Sold? Tell me "mark number as sold".\n` +
            `Want to cancel? Tell me "cancel number listing".`,
        });
        markNumberListingReminded(ctx, listing.number as string);
        reminded++;
      } catch (err) {
        log.warn({ err, number: listing.number }, "Failed to send number stale reminder");
      }
    }
  } catch (err) {
    log.error({ err }, "Failed to check stale number listings");
  }

  if (reminded > 0) {
    log.info(`Sent ${reminded} stale listing reminder(s)`);
  }

  return { reminded };
}

/**
 * Expire listings that have passed their expiration date.
 * Should be called periodically (e.g. every 6 hours).
 */
export function expireOldListings(ctx: ToolContext): { expired: number } {
  let expired = 0;

  try {
    // Gift listings
    const giftResult = ctx.db
      .prepare(
        `UPDATE gift_listings SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
      )
      .run();
    expired += giftResult.changes;

    // Username listings
    const usernameResult = ctx.db
      .prepare(
        `UPDATE mm_listings SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
      )
      .run();
    expired += usernameResult.changes;

    if (expired > 0) {
      log.info(`Expired ${expired} listing(s)`);
    }
  } catch (err) {
    log.error({ err }, "Failed to expire old listings");
  }

  return { expired };
}
