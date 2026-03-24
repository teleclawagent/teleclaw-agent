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
/**
 * Check for recent matches (24h+) where seller hasn't updated.
 * Sends targeted follow-up: "Did the deal with @buyer go through?"
 */
export async function checkMatchFollowups(
  ctx: ToolContext,
  bridge: TelegramTransport
): Promise<{ reminded: number }> {
  let reminded = 0;

  try {
    // Gift matches 24h+ old where listing is still active
    const giftMatches = ctx.db
      .prepare(
        `SELECT gm.*, gl.collection, gl.gift_num, gl.model, gl.seller_id, gl.status
         FROM gift_matches gm
         JOIN gift_listings gl ON gl.id = gm.listing_id
         WHERE gl.status = 'active'
         AND gm.seller_notified = 0
         AND gm.created_at < datetime('now', '-24 hours')`
      )
      .all() as Array<Record<string, unknown>>;

    for (const match of giftMatches) {
      try {
        const buyerId = match.buyer_id as number;
        const buyerInfo = ctx.db
          .prepare(`SELECT buyer_username FROM gift_interests WHERE buyer_id = ? LIMIT 1`)
          .get(buyerId) as { buyer_username?: string } | undefined;
        const buyerName = buyerInfo?.buyer_username
          ? `@${buyerInfo.buyer_username}`
          : `User #${buyerId}`;

        await bridge.sendMessage({
          chatId: String(match.seller_id),
          text:
            `🤝 Follow-up: ${buyerName} expressed interest in your gift 24h ago.\n\n` +
            `🎁 ${match.collection}${match.gift_num ? ` #${match.gift_num}` : ""} — ${match.model}\n\n` +
            `Did the deal go through? If so, tell me "mark gift listing as sold".\n` +
            `Still negotiating? No action needed.`,
        });
        ctx.db.prepare(`UPDATE gift_matches SET seller_notified = 1 WHERE id = ?`).run(match.id);
        reminded++;
      } catch (err) {
        log.warn({ err }, "Failed to send gift match follow-up");
      }
    }

    // Username matches
    const usernameMatches = ctx.db
      .prepare(
        `SELECT mm.*, ml.username, ml.seller_id, ml.status
         FROM mm_matches mm
         JOIN mm_listings ml ON ml.id = mm.listing_id
         WHERE ml.status = 'active'
         AND mm.seller_notified = 0
         AND mm.created_at < datetime('now', '-24 hours')`
      )
      .all() as Array<Record<string, unknown>>;

    for (const match of usernameMatches) {
      try {
        const buyerId = match.buyer_id as number;
        const buyerName = `User #${buyerId}`;

        await bridge.sendMessage({
          chatId: String(match.seller_id),
          text:
            `🤝 Follow-up: ${buyerName} expressed interest in your username 24h ago.\n\n` +
            `🔗 ${match.username}\n\n` +
            `Did the deal go through? If so, tell me "mark username as sold".\n` +
            `Still negotiating? No action needed.`,
        });
        ctx.db.prepare(`UPDATE mm_matches SET seller_notified = 1 WHERE id = ?`).run(match.id);
        reminded++;
      } catch (err) {
        log.warn({ err }, "Failed to send username match follow-up");
      }
    }

    // Number matches — number_listings uses express interest differently
    // Follow-ups handled by stale reminder already
  } catch (err) {
    log.error({ err }, "Failed to check match follow-ups");
  }

  if (reminded > 0) {
    log.info(`Sent ${reminded} match follow-up(s)`);
  }

  return { reminded };
}

export function expireOldListings(ctx: ToolContext): { expired: number } {
  let expired = 0;

  try {
    // Gift listings — normal expiry
    const giftResult = ctx.db
      .prepare(
        `UPDATE gift_listings SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
      )
      .run();
    expired += giftResult.changes;

    // Gift listings — aggressive expiry for matched (7 days instead of 14)
    const giftMatchedResult = ctx.db
      .prepare(
        `UPDATE gift_listings SET status = 'expired' WHERE status = 'active' AND match_count > 0 AND created_at < datetime('now', '-7 days')`
      )
      .run();
    expired += giftMatchedResult.changes;

    // Username listings — normal expiry
    const usernameResult = ctx.db
      .prepare(
        `UPDATE mm_listings SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
      )
      .run();
    expired += usernameResult.changes;

    // Username listings — aggressive expiry for matched (7 days)
    const usernameMatchedResult = ctx.db
      .prepare(
        `UPDATE mm_listings SET status = 'expired' WHERE status = 'active' AND match_count > 0 AND created_at < datetime('now', '-7 days')`
      )
      .run();
    expired += usernameMatchedResult.changes;

    if (expired > 0) {
      log.info(`Expired ${expired} listing(s)`);
    }
  } catch (err) {
    log.error({ err }, "Failed to expire old listings");
  }

  return { expired };
}
