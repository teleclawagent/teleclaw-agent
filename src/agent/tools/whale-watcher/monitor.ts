import type Database from "better-sqlite3";
import type { TelegramTransport } from "../../../telegram/transport.js";
import type { Config } from "../../../config/schema.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { createLogger } from "../../../utils/logger.js";
import { getErrorMessage } from "../../../utils/errors.js";

const log = createLogger("WhaleWatcher:Monitor");

const CHECK_INTERVAL_MS = 30_000; // 30 seconds
const MIN_TON_ALERT = 100; // Only alert for transfers >= 100 TON
let intervalId: ReturnType<typeof setInterval> | null = null;
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// Track already-alerted event hashes to prevent duplicates
const alertedEvents = new Set<string>();
const MAX_ALERTED_CACHE = 1000;

interface WatchedWallet {
  id: string;
  user_id: number;
  address: string;
  label: string | null;
  last_seen_lt: string | null;
}

interface ParsedTransaction {
  hash: string;
  type: "in" | "out";
  amount: string;
  amountFloat: number;
  asset: string;
  counterparty: string;
  lt: string;
}

/**
 * Fetch recent transactions for a wallet via TonAPI.
 */
async function fetchTransactions(address: string, limit = 10): Promise<ParsedTransaction[]> {
  try {
    const response = await tonapiFetch(`/accounts/${address}/events?limit=${limit}`);

    if (!response.ok) return [];

    const data = await response.json();
    const txs: ParsedTransaction[] = [];

    for (const event of data.events || []) {
      for (const action of event.actions || []) {
        if (action.type === "TonTransfer") {
          const transfer = action.TonTransfer;
          if (!transfer) continue;

          // TonAPI returns raw format addresses — compare raw to raw
          const senderAddr = transfer.sender?.address || "";
          const isOutgoing =
            senderAddr === address || senderAddr.toLowerCase() === address.toLowerCase();
          const amountNano = BigInt(transfer.amount || "0");
          const amountTon = Number(amountNano) / 1e9;

          txs.push({
            hash: event.event_id || "",
            type: isOutgoing ? "out" : "in",
            amount: amountTon.toFixed(2),
            amountFloat: amountTon,
            asset: "TON",
            counterparty: isOutgoing
              ? transfer.recipient?.address || "unknown"
              : transfer.sender?.address || "unknown",
            lt: event.lt?.toString() || "0",
          });
        } else if (action.type === "JettonTransfer") {
          const transfer = action.JettonTransfer;
          if (!transfer) continue;

          const jettonSender = transfer.sender?.address || "";
          const isOutgoing =
            jettonSender === address || jettonSender.toLowerCase() === address.toLowerCase();
          const decimals = transfer.jetton?.decimals || 9;
          const rawAmount = BigInt(transfer.amount || "0");
          const amount = Number(rawAmount) / 10 ** decimals;
          const symbol = transfer.jetton?.symbol || "TOKEN";

          txs.push({
            hash: event.event_id || "",
            type: isOutgoing ? "out" : "in",
            amount: amount.toFixed(4),
            amountFloat: amount,
            asset: symbol,
            counterparty: isOutgoing
              ? transfer.recipient?.address || "unknown"
              : transfer.sender?.address || "unknown",
            lt: event.lt?.toString() || "0",
          });
        }
      }
    }

    return txs;
  } catch (error) {
    log.error({ err: getErrorMessage(error), address }, "Failed to fetch transactions");
    return [];
  }
}

/**
 * Build alert message for a whale transaction.
 */
function buildWhaleAlert(wallet: WatchedWallet, tx: ParsedTransaction): string {
  const direction = tx.type === "in" ? "⬅️ Received" : "➡️ Sent";
  const emoji = tx.type === "in" ? "🟢" : "🔴";
  const name = wallet.label || `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
  const counterpartyShort = `${tx.counterparty.slice(0, 6)}...${tx.counterparty.slice(-4)}`;

  return (
    `🐋 **Whale Alert**\n\n` +
    `${emoji} ${direction}\n` +
    `Wallet: **${name}**\n` +
    `Amount: **${tx.amount} ${tx.asset}**\n` +
    `${tx.type === "out" ? "To" : "From"}: \`${counterpartyShort}\`\n\n` +
    `⚡ Quick: "Show transactions for ${wallet.address}"`
  );
}

/**
 * Check a single wallet for new transactions.
 */
async function checkWallet(
  db: Database.Database,
  bridge: TelegramTransport,
  wallet: WatchedWallet
): Promise<void> {
  const txs = await fetchTransactions(wallet.address, 5);
  if (txs.length === 0) return;

  // Find new transactions (after last_seen_lt)
  const lastLt = wallet.last_seen_lt ? BigInt(wallet.last_seen_lt) : BigInt(0);
  const newTxs = txs.filter((tx) => {
    try {
      return BigInt(tx.lt) > lastLt;
    } catch {
      return false;
    }
  });

  if (newTxs.length === 0) return;

  // Update last_seen_lt to the highest lt
  const maxLt = newTxs.reduce((max, tx) => {
    try {
      const lt = BigInt(tx.lt);
      return lt > max ? lt : max;
    } catch {
      return max;
    }
  }, lastLt);

  db.prepare("UPDATE whale_watched_wallets SET last_seen_lt = ? WHERE id = ?").run(
    maxLt.toString(),
    wallet.id
  );

  // Filter significant transactions & alert (dedup by event hash)
  for (const tx of newTxs) {
    // Skip if we already alerted this event
    const eventKey = `${wallet.user_id}:${tx.hash}`;
    if (alertedEvents.has(eventKey)) continue;

    // For TON: alert if >= MIN_TON_ALERT
    // For jettons: alert all (any jetton transfer from a whale is interesting)
    const isSignificant = tx.asset !== "TON" || tx.amountFloat >= MIN_TON_ALERT;

    if (!isSignificant) continue;

    // Mark as alerted
    alertedEvents.add(eventKey);
    if (alertedEvents.size > MAX_ALERTED_CACHE) {
      // Clear oldest half
      const entries = [...alertedEvents];
      alertedEvents.clear();
      entries.slice(entries.length / 2).forEach((e) => alertedEvents.add(e));
    }

    // Store transaction
    db.prepare(
      `INSERT INTO whale_transactions (user_id, wallet_address, wallet_label, tx_hash, tx_type, amount, asset, counterparty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      wallet.user_id,
      wallet.address,
      wallet.label,
      tx.hash,
      tx.type,
      tx.amount,
      tx.asset,
      tx.counterparty
    );

    // Send alert
    const alertMsg = buildWhaleAlert(wallet, tx);
    try {
      await bridge.sendMessage({
        chatId: wallet.user_id.toString(),
        text: alertMsg,
      });
      log.info(
        { userId: wallet.user_id, address: wallet.address, amount: tx.amount, asset: tx.asset },
        "Whale alert sent"
      );
    } catch (err) {
      log.warn({ err: getErrorMessage(err), userId: wallet.user_id }, "Failed to send whale alert");
    }
  }
}

/**
 * Main monitoring tick — check all watched wallets.
 */
async function monitorTick(db: Database.Database, bridge: TelegramTransport): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const wallets = db
      .prepare("SELECT * FROM whale_watched_wallets WHERE active = 1")
      .all() as WatchedWallet[];

    if (wallets.length === 0) return;

    // Batch check — max 5 at a time to avoid rate limits
    for (let i = 0; i < wallets.length; i += 5) {
      const batch = wallets.slice(i, i + 5);
      await Promise.allSettled(batch.map((w) => checkWallet(db, bridge, w)));

      // Small delay between batches
      if (i + 5 < wallets.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  } catch (error) {
    log.error({ err: getErrorMessage(error) }, "Whale watcher tick failed");
  } finally {
    isRunning = false;
  }
}

/**
 * Start the whale watcher background monitor.
 */
export function startWhaleWatcher(context: {
  db: Database.Database;
  bridge: TelegramTransport;
  config: Config;
}): void {
  if (intervalId) {
    log.warn("Whale watcher already running");
    return;
  }

  log.info("Starting whale watcher (30s interval)");
  intervalId = setInterval(() => {
    monitorTick(context.db, context.bridge).catch((err) => {
      log.error({ err: getErrorMessage(err) }, "Unhandled error in whale watcher");
    });
  }, CHECK_INTERVAL_MS);

  // Cleanup old whale transactions every 6 hours (keep last 30 days)
  cleanupIntervalId = setInterval(() => {
    try {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
      const result = context.db
        .prepare("DELETE FROM whale_transactions WHERE detected_at < ?")
        .run(thirtyDaysAgo);
      if (result.changes > 0) {
        log.info({ deleted: result.changes }, "Cleaned up old whale transactions");
      }
    } catch (err) {
      log.error({ err: getErrorMessage(err) }, "Failed to cleanup whale transactions");
    }
  }, 6 * 3600_000);

  // First tick after 10 seconds
  setTimeout(() => {
    monitorTick(context.db, context.bridge).catch((err) => {
      log.error({ err: getErrorMessage(err) }, "Unhandled error in initial whale watcher tick");
    });
  }, 10_000);
}

/**
 * Stop the whale watcher.
 */
export function stopWhaleWatcher(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  alertedEvents.clear();
  log.info("Whale watcher stopped");
}
