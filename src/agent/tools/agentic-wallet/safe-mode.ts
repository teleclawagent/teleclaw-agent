/**
 * 🟢 Safe Mode Trading — User keeps full custody.
 *
 * Agent prepares transactions, sends TON Connect deeplinks.
 * User approves each tx in their own wallet (Tonkeeper, MyTonWallet, etc.)
 * No private keys, no custody, no risk for Teleclaw.
 *
 * Supported operations:
 * - Token swaps via DeDust/STON.fi
 * - Fragment username bidding
 * - Fragment number purchasing
 * - Gift NFT transfers
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { createLogger } from "../../../utils/logger.js";
import { getErrorMessage } from "../../../utils/errors.js";

const log = createLogger("SafeMode");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureSafeModeTables(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS safe_mode_wallets (
      user_id INTEGER PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      wallet_app TEXT DEFAULT 'tonkeeper',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS safe_mode_txs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tx_type TEXT NOT NULL,
      description TEXT NOT NULL,
      deeplink TEXT NOT NULL,
      amount REAL,
      asset TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'expired', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_safe_mode_txs_user ON safe_mode_txs(user_id);
    CREATE INDEX IF NOT EXISTS idx_safe_mode_txs_status ON safe_mode_txs(status);
  `);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── TON Connect Deeplink Builders ───────────────────────────────────

type WalletApp = "tonkeeper" | "mytonwallet" | "tonhub";

const DEEPLINK_PREFIXES: Record<WalletApp, string> = {
  tonkeeper: "https://app.tonkeeper.com/transfer/",
  mytonwallet: "https://mytonwallet.app/transfer/",
  tonhub: "https://tonhub.com/transfer/",
};

function buildTransferDeeplink(
  walletApp: WalletApp,
  to: string,
  amount: string, // in nanotons
  payload?: string, // base64 encoded BOC
  stateInit?: string,
): string {
  const base = `${DEEPLINK_PREFIXES[walletApp]}${to}`;
  const params = new URLSearchParams();
  params.set("amount", amount);
  if (payload) params.set("bin", payload);
  if (stateInit) params.set("init", stateInit);
  return `${base}?${params.toString()}`;
}

function buildUniversalLink(
  to: string,
  amount: string,
  payload?: string,
): string {
  // tc:// universal link format (works with any TON Connect-compatible wallet)
  const params = new URLSearchParams();
  params.set("to", to);
  params.set("amount", amount);
  if (payload) params.set("payload", payload);
  return `https://app.tonkeeper.com/transfer/${to}?amount=${amount}${payload ? `&bin=${payload}` : ""}`;
}

// ─── Tool: Connect Wallet (Safe Mode) ────────────────────────────────

interface ConnectWalletParams {
  wallet_address: string;
  wallet_app?: string;
}

export const safeConnectTool: Tool = {
  name: "safe_wallet_connect",
  description:
    "🟢 Connect your wallet for Safe Mode trading.\n\n" +
    "Safe Mode = YOU keep full control. Teleclaw prepares transactions, you approve them in your wallet.\n" +
    "No private keys leave your device. No custody risk.\n\n" +
    "Supported wallets: Tonkeeper, MyTonWallet, Tonhub.\n" +
    "Just provide your wallet address — that's it.",
  category: "action",
  parameters: Type.Object({
    wallet_address: Type.String({ description: "Your TON wallet address (EQ... or UQ...)" }),
    wallet_app: Type.Optional(
      Type.String({ description: "Wallet app: tonkeeper (default), mytonwallet, tonhub" })
    ),
  }),
};

export const safeConnectExecutor: ToolExecutor<ConnectWalletParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureSafeModeTables(context);

    const validApps = ["tonkeeper", "mytonwallet", "tonhub"];
    const walletApp = (params.wallet_app || "tonkeeper").toLowerCase();
    if (!validApps.includes(walletApp)) {
      return { success: false, error: `Invalid wallet app. Supported: ${validApps.join(", ")}` };
    }

    // Address validation via @ton/core
    try {
      const { Address } = await import("@ton/core");
      Address.parse(params.wallet_address);
    } catch {
      return { success: false, error: "Invalid TON address format. Should start with EQ or UQ (e.g. from Tonkeeper)." };
    }

    context.db
      .prepare(
        `INSERT INTO safe_mode_wallets (user_id, wallet_address, wallet_app, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET wallet_address = ?, wallet_app = ?, updated_at = datetime('now')`
      )
      .run(
        context.senderId,
        params.wallet_address,
        walletApp,
        params.wallet_address,
        walletApp
      );

    return {
      success: true,
      data: {
        address: params.wallet_address,
        walletApp,
        mode: "safe",
        message:
          `🟢 Safe Mode wallet connected!\n\n` +
          `Address: \`${params.wallet_address}\`\n` +
          `Wallet: ${walletApp}\n\n` +
          `How it works:\n` +
          `1. You request a trade (e.g. "swap 10 TON for DOGS")\n` +
          `2. I prepare the transaction and send you a deeplink\n` +
          `3. You tap the link → opens in ${walletApp} → review & approve\n` +
          `4. Done! Your keys never leave your wallet.\n\n` +
          `To switch to Auto Mode (custody), use trading_mode_set.`,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error connecting safe mode wallet");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Tool: Prepare Swap ──────────────────────────────────────────────

interface SafeSwapParams {
  from_asset: string;
  to_asset: string;
  amount: number;
  slippage?: number;
}

export const safeSwapTool: Tool = {
  name: "safe_swap",
  description:
    "🟢 Prepare a token swap and get a deeplink to approve in your wallet.\n\n" +
    "Teleclaw simulates the swap on STON.fi, shows you the expected output and price impact, " +
    "then gives you a one-tap link to execute in your wallet.\n\n" +
    "Examples:\n" +
    "• 'swap 10 TON for DOGS'\n" +
    "• 'buy 50 TON worth of NOT'\n" +
    "• 'sell all DOGS for TON'",
  category: "action",
  parameters: Type.Object({
    from_asset: Type.String({ description: "Asset to sell (e.g. 'TON', or jetton address)" }),
    to_asset: Type.String({ description: "Asset to buy (e.g. 'DOGS', or jetton address)" }),
    amount: Type.Number({ description: "Amount to swap", minimum: 0.01 }),
    slippage: Type.Optional(Type.Number({ description: "Slippage tolerance 0.01 = 1% (default: 1%)", minimum: 0.001, maximum: 0.5 })),
  }),
};

export const safeSwapExecutor: ToolExecutor<SafeSwapParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureSafeModeTables(context);

    const wallet = context.db
      .prepare(`SELECT wallet_address, wallet_app FROM safe_mode_wallets WHERE user_id = ?`)
      .get(context.senderId) as { wallet_address: string; wallet_app: string } | undefined;

    if (!wallet) {
      return {
        success: false,
        error: "No Safe Mode wallet connected. Use safe_wallet_connect first.",
      };
    }

    const slippage = params.slippage ?? 0.01;

    // Resolve well-known token tickers to addresses
    const KNOWN_TOKENS: Record<string, string> = {
      ton: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
      dogs: "EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS",
      not: "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT",
      cati: "EQD-cvR0Nz6XAyRBvbhz-abTrRC6sI5tvHvvpeQraV9LABELS",
      hmstr: "EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo",
      major: "EQCuPm0XlMFkNNn_ZPVBsEgaqcNjq-OLFv_jMjmFXyGCRKtZ",
      durev: "EQBf6-YoR9v5JFO7pSPpBXYJPkEVlkQNS3JGfqVVlfSKNm5E",
    };

    const NATIVE_TON = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
    const fromAddress = KNOWN_TOKENS[params.from_asset.toLowerCase()] || params.from_asset;
    const toAddress = KNOWN_TOKENS[params.to_asset.toLowerCase()] || params.to_asset;
    const isTonInput = fromAddress === NATIVE_TON;

    // Simulate swap via STON.fi API
    const { StonApiClient } = await import("@ston-fi/api");
    const stonApi = new StonApiClient();

    const fromAssetInfo = await stonApi.getAsset(fromAddress);
    const fromDecimals = fromAssetInfo?.decimals ?? 9;

    const amountStr = params.amount.toFixed(fromDecimals);
    const [whole, frac = ""] = amountStr.split(".");
    const offerUnits = BigInt(
      whole + (frac + "0".repeat(fromDecimals)).slice(0, fromDecimals)
    ).toString();

    const simulation = await stonApi.simulateSwap({
      offerAddress: fromAddress,
      askAddress: toAddress,
      offerUnits,
      slippageTolerance: slippage.toString(),
    });

    if (!simulation?.router) {
      return { success: false, error: "No liquidity found for this pair. Check token addresses." };
    }

    const priceImpact = parseFloat(simulation.priceImpact || "0");
    if (priceImpact > 0.1) {
      return {
        success: false,
        error: `⚠️ Price impact is ${(priceImpact * 100).toFixed(1)}% — way too high. Try a smaller amount.`,
      };
    }

    const toAssetInfo = await stonApi.getAsset(toAddress);
    const askDecimals = toAssetInfo?.decimals ?? 9;
    const expectedOutput = Number(simulation.askUnits) / 10 ** askDecimals;
    const minOutput = Number(simulation.minAskUnits) / 10 ** askDecimals;

    // Build deeplink for the swap
    // For TON→Jetton swaps, we send TON to the router with a swap payload
    const { dexFactory } = await import("@ston-fi/sdk");
    const { getCachedTonClient } = await import("../../../ton/wallet-service.js");
    const client = await getCachedTonClient();

    const contracts = dexFactory(simulation.router);
    const router = client.open(contracts.Router.create(simulation.router.address));
    const proxyTon = contracts.pTON.create(simulation.router.ptonMasterAddress);

    let txParams;
    if (isTonInput) {
      txParams = await router.getSwapTonToJettonTxParams({
        userWalletAddress: wallet.wallet_address,
        proxyTon,
        askJettonAddress: toAddress,
        offerAmount: BigInt(simulation.offerUnits),
        minAskAmount: BigInt(simulation.minAskUnits),
      });
    } else {
      txParams = await router.getSwapJettonToTonTxParams({
        userWalletAddress: wallet.wallet_address,
        proxyTon,
        offerJettonAddress: fromAddress,
        offerAmount: BigInt(simulation.offerUnits),
        minAskAmount: BigInt(simulation.minAskUnits),
      });
    }

    // Build deeplink
    const walletApp = wallet.wallet_app as WalletApp;
    // txParams.to is an Address object — convert to user-friendly string
    const toAddr = typeof txParams.to === "string"
      ? txParams.to
      : txParams.to.toString({ bounceable: true, testOnly: false });
    const deeplink = buildTransferDeeplink(
      walletApp,
      toAddr,
      txParams.value.toString(),
      txParams.body ? txParams.body.toBoc().toString("base64") : undefined,
    );

    // Save TX record
    const txId = generateId("stx");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    context.db
      .prepare(
        `INSERT INTO safe_mode_txs (id, user_id, tx_type, description, deeplink, amount, asset, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        txId,
        context.senderId,
        "swap",
        `Swap ${params.amount} ${params.from_asset} → ${expectedOutput.toFixed(4)} ${params.to_asset}`,
        deeplink,
        params.amount,
        params.to_asset,
        expiresAt
      );

    const priceImpactStr = priceImpact > 0.01
      ? `⚠️ ${(priceImpact * 100).toFixed(1)}%`
      : `✅ ${(priceImpact * 100).toFixed(2)}%`;

    return {
      success: true,
      data: {
        txId,
        swap: {
          from: `${params.amount} ${params.from_asset}`,
          to: `~${expectedOutput.toFixed(4)} ${params.to_asset}`,
          minReceive: `${minOutput.toFixed(4)} ${params.to_asset}`,
          priceImpact: priceImpactStr,
          slippage: `${(slippage * 100).toFixed(1)}%`,
          dex: "STON.fi",
        },
        deeplink,
        walletApp: wallet.wallet_app,
        expiresIn: "10 minutes",
        message:
          `🟢 Swap prepared!\n\n` +
          `${params.amount} ${params.from_asset} → ~${expectedOutput.toFixed(4)} ${params.to_asset}\n` +
          `Min receive: ${minOutput.toFixed(4)}\n` +
          `Price impact: ${priceImpactStr}\n` +
          `Slippage: ${(slippage * 100).toFixed(1)}%\n\n` +
          `👆 Tap the link above to approve in ${wallet.wallet_app}.\n` +
          `Expires in 10 minutes.`,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error preparing safe swap");
    return { success: false, error: `Swap preparation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Tool: Prepare TON Transfer ──────────────────────────────────────

interface SafeTransferParams {
  to_address: string;
  amount: number;
  comment?: string;
}

export const safeTransferTool: Tool = {
  name: "safe_transfer",
  description:
    "🟢 Prepare a TON transfer and get a deeplink to approve in your wallet.\n" +
    "Simple TON send — enter recipient, amount, optional comment.",
  category: "action",
  parameters: Type.Object({
    to_address: Type.String({ description: "Recipient TON address" }),
    amount: Type.Number({ description: "Amount of TON to send", minimum: 0.01 }),
    comment: Type.Optional(Type.String({ description: "Transfer comment/memo" })),
  }),
};

export const safeTransferExecutor: ToolExecutor<SafeTransferParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureSafeModeTables(context);

    const wallet = context.db
      .prepare(`SELECT wallet_address, wallet_app FROM safe_mode_wallets WHERE user_id = ?`)
      .get(context.senderId) as { wallet_address: string; wallet_app: string } | undefined;

    if (!wallet) {
      return {
        success: false,
        error: "No Safe Mode wallet connected. Use safe_wallet_connect first.",
      };
    }

    const { toNano } = await import("@ton/ton");
    const amountNano = toNano(params.amount.toString()).toString();

    const walletApp = wallet.wallet_app as WalletApp;
    let deeplink = buildTransferDeeplink(walletApp, params.to_address, amountNano);
    if (params.comment) {
      deeplink += `&text=${encodeURIComponent(params.comment)}`;
    }

    const txId = generateId("stx");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    context.db
      .prepare(
        `INSERT INTO safe_mode_txs (id, user_id, tx_type, description, deeplink, amount, asset, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(txId, context.senderId, "transfer", `Send ${params.amount} TON to ${params.to_address}`, deeplink, params.amount, "TON", expiresAt);

    return {
      success: true,
      data: {
        txId,
        to: params.to_address,
        amount: `${params.amount} TON`,
        comment: params.comment,
        deeplink,
        walletApp: wallet.wallet_app,
        expiresIn: "10 minutes",
        message:
          `🟢 Transfer prepared!\n\n` +
          `${params.amount} TON → ${params.to_address}\n` +
          `${params.comment ? `Comment: ${params.comment}\n` : ""}` +
          `\n👆 Tap the link to approve in ${wallet.wallet_app}.`,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error preparing safe transfer");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Tool: View TX History ───────────────────────────────────────────

export const safeTxHistoryTool: Tool = {
  name: "safe_tx_history",
  description: "🟢 View your recent Safe Mode transaction history.",
  category: "data-bearing",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 50 })),
  }),
};

export const safeTxHistoryExecutor: ToolExecutor<{ limit?: number }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureSafeModeTables(context);

    const txs = context.db
      .prepare(
        `SELECT id, tx_type, description, amount, asset, status, created_at
         FROM safe_mode_txs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(context.senderId, params.limit ?? 10) as Array<{
      id: string;
      tx_type: string;
      description: string;
      amount: number | null;
      asset: string | null;
      status: string;
      created_at: string;
    }>;

    return {
      success: true,
      data: {
        total: txs.length,
        transactions: txs,
      },
    };
  } catch (err: unknown) {
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};
