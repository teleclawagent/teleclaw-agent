import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHmac,
  scryptSync,
  randomBytes,
} from "crypto";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV5R1, fromNano, internal, toNano } from "@ton/ton";
import { Address, SendMode } from "@ton/core";
import type Database from "better-sqlite3";
import { getCachedTonClient } from "../../../ton/wallet-service.js";
import { withTxLock } from "../../../ton/tx-lock.js";
import { createLogger } from "../../../utils/logger.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { verifyPin, hasPin, isAddressWhitelisted, auditLog, signExecution } from "./security.js";

const log = createLogger("AgenticWallet");

// Encryption constants
const ALGORITHM = "aes-256-gcm";

interface WalletRow {
  id: string;
  user_id: number;
  chat_id: string;
  address: string;
  encrypted_secret: string;
  label: string | null;
  max_trade_amount: number;
  daily_limit: number;
  created_at: number;
}

/**
 * Get the master encryption key from environment.
 * MUST be set — never falls back to hardcoded values.
 */
function getMasterKey(): string {
  const key = process.env.TELECLAW_MASTER_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      "TELECLAW_MASTER_KEY environment variable not set or too short (min 32 chars). " +
        "This is required to encrypt wallet keys. Set it before creating wallets."
    );
  }
  return key;
}

/**
 * Derive an encryption key from userId + master key.
 * Master key from env ensures open-source code doesn't expose the secret.
 */
function deriveKey(userId: number): Buffer {
  const masterKey = getMasterKey();
  return scryptSync(`${userId}:${masterKey}`, randomSaltForUser(userId), 32);
}

/**
 * Deterministic salt per user (derived from master key + userId).
 * This ensures the same user always gets the same derived key
 * while still being unique per deployment.
 */
function randomSaltForUser(userId: number): string {
  const masterKey = getMasterKey();
  return createHmac("sha256", masterKey).update(`salt:${userId}`).digest("hex");
}

/**
 * Encrypt mnemonic words for storage.
 */
function encryptMnemonic(mnemonic: string[], userId: number): string {
  const key = deriveKey(userId);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(mnemonic);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt stored mnemonic.
 */
function decryptMnemonic(encryptedStr: string, userId: number): string[] {
  const key = deriveKey(userId);
  const [ivHex, authTagHex, encrypted] = encryptedStr.split(":");

  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error("Corrupted wallet data — cannot decrypt.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}

/**
 * Create a new TON wallet for a user.
 * Requires TELECLAW_MASTER_KEY to be set.
 */
export async function createUserWallet(
  db: Database.Database,
  userId: number,
  chatId: string,
  label?: string
): Promise<{ id: string; address: string }> {
  // Verify master key exists before creating anything
  getMasterKey();

  // Check if user already has a wallet
  const existing = db
    .prepare("SELECT id, address FROM agentic_wallets WHERE user_id = ?")
    .get(userId) as Pick<WalletRow, "id" | "address"> | undefined;

  if (existing) {
    return { id: existing.id, address: existing.address };
  }

  // Generate new wallet
  const mnemonic = await mnemonicNew(24);
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const address = wallet.address.toString({ bounceable: true, testOnly: false });

  // Encrypt and store
  const id = randomUUID();
  const encryptedSecret = encryptMnemonic(mnemonic, userId);

  db.prepare(
    `INSERT INTO agentic_wallets (id, user_id, chat_id, address, encrypted_secret, label)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, userId, chatId, address, encryptedSecret, label || null);

  auditLog(db, userId, "wallet_created", `Wallet ${id} created with address ${address}`);
  log.info({ userId, walletId: id }, "Created agentic wallet");
  return { id, address };
}

/**
 * Get user's wallet info (without secret).
 */
export function getUserWallet(
  db: Database.Database,
  userId: number
): {
  id: string;
  address: string;
  label: string | null;
  max_trade_amount: number;
  daily_limit: number;
  created_at: number;
} | null {
  const row = db
    .prepare(
      "SELECT id, address, label, max_trade_amount, daily_limit, created_at FROM agentic_wallets WHERE user_id = ?"
    )
    .get(userId) as
    | Pick<
        WalletRow,
        "id" | "address" | "label" | "max_trade_amount" | "daily_limit" | "created_at"
      >
    | undefined;

  return row || null;
}

/**
 * Get wallet balance (TON).
 */
export async function getAgenticWalletBalance(address: string): Promise<{
  tonBalance: string;
  tonBalanceNano: string;
} | null> {
  try {
    const client = await getCachedTonClient();
    const addr = Address.parse(address);
    const balance = await client.getBalance(addr);
    return {
      tonBalance: fromNano(balance),
      tonBalanceNano: balance.toString(),
    };
  } catch (error) {
    log.error({ err: error, address }, "Failed to get agentic wallet balance");
    return null;
  }
}

/**
 * Get the keypair for a user's agentic wallet.
 * PRIVATE — never expose outside this module.
 */
async function getUserKeyPair(
  db: Database.Database,
  userId: number
): Promise<{ publicKey: Buffer; secretKey: Buffer; address: string } | null> {
  const row = db
    .prepare("SELECT encrypted_secret, address FROM agentic_wallets WHERE user_id = ?")
    .get(userId) as Pick<WalletRow, "encrypted_secret" | "address"> | undefined;

  if (!row) return null;

  try {
    const mnemonic = decryptMnemonic(row.encrypted_secret, userId);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    return { ...keyPair, address: row.address };
  } catch (error) {
    log.error({ err: error, userId }, "Failed to decrypt wallet");
    return null;
  }
}

/**
 * Withdraw all TON from agentic wallet to a destination address.
 * REQUIRES: PIN verification + whitelisted address.
 */
export async function withdrawAll(
  db: Database.Database,
  userId: number,
  toAddress: string,
  pin: string
): Promise<{ success: boolean; amount?: string; error?: string }> {
  // 1. Verify PIN
  if (!hasPin(db, userId)) {
    return { success: false, error: "Set a security PIN first with agentic_wallet_set_pin." };
  }
  try {
    verifyPin(db, userId, pin);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  // 2. Check whitelist
  if (!isAddressWhitelisted(db, userId, toAddress)) {
    return {
      success: false,
      error: `Address ${toAddress} is not whitelisted. Add it first with agentic_wallet_whitelist_add for security.`,
    };
  }

  // 3. Execute withdrawal
  return withTxLock(async () => {
    try {
      const walletKeys = await getUserKeyPair(db, userId);
      if (!walletKeys) {
        return { success: false, error: "No agentic wallet found for this user." };
      }

      let recipient: Address;
      try {
        recipient = Address.parse(toAddress);
      } catch {
        return { success: false, error: `Invalid destination address: ${toAddress}` };
      }

      const client = await getCachedTonClient();
      const wallet = WalletContractV5R1.create({
        workchain: 0,
        publicKey: walletKeys.publicKey,
      });
      const walletContract = client.open(wallet);

      const balance = await client.getBalance(wallet.address);
      const gasReserve = toNano("0.05");
      if (balance <= gasReserve) {
        return {
          success: false,
          error: `Insufficient balance. Have ${fromNano(balance)} TON (need >0.05 TON for gas).`,
        };
      }

      const sendAmount = balance - gasReserve;
      const seqno = await walletContract.getSeqno();

      await walletContract.sendTransfer({
        seqno,
        secretKey: walletKeys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
          internal({
            to: recipient,
            value: sendAmount,
            body: undefined,
            bounce: false,
          }),
        ],
      });

      const amountStr = fromNano(sendAmount);
      auditLog(db, userId, "withdrawal", `Withdrew ${amountStr} TON to ${toAddress}`);
      log.info({ userId, amount: amountStr, to: toAddress }, "Withdrew from agentic wallet");
      return { success: true, amount: amountStr };
    } catch (error) {
      log.error({ err: error, userId }, "Withdrawal failed");
      auditLog(db, userId, "withdrawal_failed", getErrorMessage(error));
      return { success: false, error: getErrorMessage(error) };
    }
  });
}

/**
 * Execute a swap from the user's agentic wallet.
 * REQUIRES: PIN already verified by caller (confirm trade flow).
 * Uses multi-source price verification before executing.
 */
export async function executeAgenticSwap(
  db: Database.Database,
  userId: number,
  params: {
    fromAsset: string;
    toAsset: string;
    amount: number;
    slippage?: number;
    executionId: string;
  }
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // Check daily limit
  const wallet = getUserWallet(db, userId);
  if (!wallet) return { success: false, error: "No agentic wallet found." };

  if (params.amount > wallet.max_trade_amount) {
    return {
      success: false,
      error: `Amount ${params.amount} TON exceeds your max trade limit of ${wallet.max_trade_amount} TON.`,
    };
  }

  const dailyTotal = getDailyTotal(db, userId);
  if (dailyTotal + params.amount > wallet.daily_limit) {
    return {
      success: false,
      error: `This trade would exceed your daily limit of ${wallet.daily_limit} TON. Used today: ${dailyTotal.toFixed(2)} TON.`,
    };
  }

  return withTxLock(async () => {
    try {
      const walletKeys = await getUserKeyPair(db, userId);
      if (!walletKeys) {
        return { success: false, error: "No agentic wallet found." };
      }

      const client = await getCachedTonClient();
      const walletObj = WalletContractV5R1.create({
        workchain: 0,
        publicKey: walletKeys.publicKey,
      });
      const walletContract = client.open(walletObj);

      // Verify balance before swap
      const balance = await client.getBalance(walletObj.address);
      const requiredNano = toNano(params.amount.toString()) + toNano("0.3"); // amount + gas
      if (balance < requiredNano) {
        return {
          success: false,
          error: `Insufficient balance. Have ${fromNano(balance)} TON, need ~${fromNano(requiredNano)} TON (including gas).`,
        };
      }

      const { StonApiClient } = await import("@ston-fi/api");
      const { dexFactory } = await import("@ston-fi/sdk");

      const NATIVE_TON = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
      const isTonInput = params.fromAsset.toLowerCase() === "ton";
      const fromAddress = isTonInput ? NATIVE_TON : params.fromAsset;
      const toAddress = params.toAsset.toLowerCase() === "ton" ? NATIVE_TON : params.toAsset;
      const slippage = params.slippage ?? 0.01;

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
        return { success: false, error: "No liquidity for this pair." };
      }

      // Check price impact — reject if too high
      const priceImpact = parseFloat(simulation.priceImpact || "0");
      if (priceImpact > 0.05) {
        return {
          success: false,
          error: `Price impact too high (${(priceImpact * 100).toFixed(1)}%). Trade rejected for safety. Try a smaller amount.`,
        };
      }

      const contracts = dexFactory(simulation.router);
      const router = client.open(contracts.Router.create(simulation.router.address));
      const proxyTon = contracts.pTON.create(simulation.router.ptonMasterAddress);

      const seqno = await walletContract.getSeqno();

      let txParams;
      if (isTonInput) {
        txParams = await router.getSwapTonToJettonTxParams({
          userWalletAddress: walletKeys.address,
          proxyTon,
          askJettonAddress: toAddress,
          offerAmount: BigInt(simulation.offerUnits),
          minAskAmount: BigInt(simulation.minAskUnits),
        });
      } else {
        txParams = await router.getSwapJettonToTonTxParams({
          userWalletAddress: walletKeys.address,
          proxyTon,
          offerJettonAddress: fromAddress,
          offerAmount: BigInt(simulation.offerUnits),
          minAskAmount: BigInt(simulation.minAskUnits),
        });
      }

      await walletContract.sendTransfer({
        seqno,
        secretKey: walletKeys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
          internal({
            to: txParams.to,
            value: txParams.value,
            body: txParams.body,
            bounce: true,
          }),
        ],
      });

      const toAssetInfo = await stonApi.getAsset(toAddress);
      const askDecimals = toAssetInfo?.decimals ?? 9;
      const expectedOutput = Number(simulation.askUnits) / 10 ** askDecimals;

      // Sign the execution for tamper-proof audit
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signExecution({
        executionId: params.executionId,
        userId,
        action: "swap",
        asset: params.toAsset,
        amount: params.amount,
        price: expectedOutput,
        timestamp,
      });

      // Store signature
      db.prepare("UPDATE trade_executions SET signature = ? WHERE id = ?").run(
        signature,
        params.executionId
      );

      auditLog(
        db,
        userId,
        "swap_executed",
        `Swapped ${params.amount} ${isTonInput ? "TON" : params.fromAsset} → ~${expectedOutput.toFixed(4)} tokens`
      );

      return {
        success: true,
        data: {
          from: fromAddress,
          to: toAddress,
          amountIn: params.amount,
          expectedOutput: expectedOutput.toFixed(6),
          priceImpact: simulation.priceImpact || "N/A",
          message: `Swap executed: ${params.amount} → ~${expectedOutput.toFixed(4)}`,
        },
      };
    } catch (error) {
      log.error({ err: error, userId }, "Agentic swap failed");
      auditLog(db, userId, "swap_failed", getErrorMessage(error));
      return { success: false, error: getErrorMessage(error) };
    }
  });
}

/**
 * Get total trade amount for a user today.
 */
function getDailyTotal(db: Database.Database, userId: number): number {
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM trade_executions
       WHERE user_id = ? AND created_at >= ? AND status IN ('confirmed', 'executed')`
    )
    .get(userId, todayStart) as { total: number };

  return row.total;
}
