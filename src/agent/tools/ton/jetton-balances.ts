import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { loadWallet } from "../../../ton/wallet-service.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");
interface JettonBalancesParams {
  // No parameters - uses agent's wallet
}

/**
 * Jetton balance info
 */
interface JettonBalance {
  symbol: string;
  name: string;
  balance: string; // Human-readable balance
  rawBalance: string; // Raw blockchain units
  decimals: number;
  jettonAddress: string; // Master contract address
  walletAddress: string; // User's jetton wallet address
  verification: string; // whitelist/blacklist/none
  score: number; // 0-100 trust score
  image?: string;
}
export const jettonBalancesTool: Tool = {
  name: "jetton_balances",
  description:
    "List all jetton token balances in your wallet. Returns address, symbol, and balance for each token. Filters out blacklisted/scam tokens. For TON balance, use ton_get_balance.",
  parameters: Type.Object({}),
  category: "data-bearing",
};
function processBalances(data: Record<string, unknown[]>): ToolResult {
  const balances: JettonBalance[] = [];

  for (const item of (data.balances || []) as Record<string, unknown>[]) {
    const { balance, wallet_address, jetton } = item as {
      balance: string;
      wallet_address: { address: string };
      jetton: Record<string, unknown>;
    };

    if ((jetton.verification as string) === "blacklist") continue;

    const decimals = (jetton.decimals as number) || 9;
    const rawBalance = BigInt(balance);
    const divisor = BigInt(10 ** decimals);
    const wholePart = rawBalance / divisor;
    const fractionalPart = rawBalance % divisor;

    const formattedBalance =
      fractionalPart === BigInt(0)
        ? wholePart.toString()
        : `${wholePart}.${fractionalPart.toString().padStart(decimals, "0").replace(/0+$/, "")}`;

    balances.push({
      symbol: (jetton.symbol as string) || "UNKNOWN",
      name: (jetton.name as string) || "Unknown Token",
      balance: formattedBalance,
      rawBalance: balance,
      decimals,
      jettonAddress: (jetton.address as string) || "",
      walletAddress: wallet_address?.address || "",
      verification: (jetton.verification as string) || "none",
      score: (jetton.score as number) || 0,
      image: jetton.image as string | undefined,
    });
  }

  balances.sort((a, b) => {
    if (a.verification === "whitelist" && b.verification !== "whitelist") return -1;
    if (a.verification !== "whitelist" && b.verification === "whitelist") return 1;
    return b.score - a.score;
  });

  const totalJettons = balances.length;
  const whitelisted = balances.filter((b) => b.verification === "whitelist").length;

  let message = `You own ${totalJettons} jetton${totalJettons !== 1 ? "s" : ""}`;
  if (whitelisted > 0) message += ` (${whitelisted} verified)`;

  if (totalJettons === 0) {
    message = "You don't own any jettons yet.";
  } else {
    message += ":\n\n";
    balances.forEach((b) => {
      const verifiedIcon = b.verification === "whitelist" ? "✅" : "";
      message += `${verifiedIcon} ${b.symbol}: ${b.balance}\n`;
      message += `   ${b.name}\n`;
      if (b.verification !== "whitelist" && b.verification !== "none") {
        message += `   ⚠️ ${b.verification}\n`;
      }
    });
  }

  let summary = `${totalJettons} jetton${totalJettons !== 1 ? "s" : ""}`;
  if (whitelisted > 0) summary += ` (${whitelisted} verified)`;
  if (totalJettons > 0) {
    const topTokens = balances.slice(0, 5).map((b) => `${b.symbol} ${b.balance}`);
    summary += `: ${topTokens.join(", ")}`;
    if (balances.length > 5) summary += `, +${balances.length - 5} more`;
  }

  return {
    success: true,
    data: { totalJettons, whitelisted, balances, message, summary },
  };
}

export const jettonBalancesExecutor: ToolExecutor<JettonBalancesParams> = async (
  _params,
  _context
): Promise<ToolResult> => {
  try {
    const walletData = loadWallet();
    if (!walletData) {
      return {
        success: false,
        error: "Wallet not initialized. Contact admin to generate wallet.",
      };
    }

    // Fetch jetton balances from TonAPI
    let response = await tonapiFetch(`/accounts/${walletData.address}/jettons`);

    // Retry on transient errors
    if (response.status === 502 || response.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      response = await tonapiFetch(`/accounts/${walletData.address}/jettons`);
    }

    // TonAPI 401 — try Toncenter fallback
    if (response.status === 401) {
      log.warn("TonAPI 401 — trying Toncenter fallback for jetton balances");
      try {
        const tcUrl = `https://toncenter.com/api/v3/jetton/wallets?owner_address=${encodeURIComponent(walletData.address)}&limit=100`;
        const tcResponse = await fetch(tcUrl, { headers: { Accept: "application/json" } });
        if (tcResponse.ok) {
          const tcData = await tcResponse.json();
          const tcWallets = (tcData.jetton_wallets || []) as Record<string, unknown>[];

          // Toncenter doesn't return metadata in jetton/wallets — fetch each jetton master
          const reformattedBalances = await Promise.all(
            tcWallets.map(async (w) => {
              const jettonAddr = (w.jetton as string) || "";
              let symbol = "UNKNOWN";
              let name = "Unknown Token";
              let decimals = 9;
              let image: string | undefined;

              // Try to fetch jetton metadata from TonAPI (might work for reads even if 401 on account endpoints)
              // Fall back to Toncenter jetton/masters
              try {
                const metaUrl = `https://toncenter.com/api/v3/jetton/masters?address=${encodeURIComponent(jettonAddr)}&limit=1`;
                const metaRes = await fetch(metaUrl, { headers: { Accept: "application/json" } });
                if (metaRes.ok) {
                  const metaData = await metaRes.json();
                  const content = metaData.jetton_masters?.[0]?.jetton_content;
                  if (content) {
                    if (content.symbol) {
                      // On-chain metadata directly available
                      symbol = content.symbol;
                      name = content.name || name;
                      decimals = content.decimals ? Number(content.decimals) : decimals;
                      image = content.image || content.image_data;
                    } else if (content.uri) {
                      // Off-chain metadata — fetch the URI
                      try {
                        const uriRes = await fetch(content.uri, {
                          headers: { Accept: "application/json" },
                          signal: AbortSignal.timeout(5000),
                        });
                        if (uriRes.ok) {
                          const offChain = await uriRes.json();
                          symbol = offChain.symbol || symbol;
                          name = offChain.name || name;
                          decimals = offChain.decimals ? Number(offChain.decimals) : decimals;
                          image = offChain.image || offChain.image_data;
                        }
                      } catch {
                        // Off-chain fetch failed, keep defaults
                      }
                    }
                  }
                }
              } catch {
                // Metadata fetch failed, keep defaults
              }

              return {
                balance: String(w.balance || "0"),
                wallet_address: { address: w.address },
                jetton: {
                  address: jettonAddr,
                  symbol,
                  name,
                  decimals,
                  verification: "none",
                  score: 0,
                  image,
                },
              };
            })
          );

          const data = { balances: reformattedBalances };
          return processBalances(data);
        }
      } catch (tcErr) {
        log.error({ err: tcErr }, "Toncenter fallback also failed");
      }
      return {
        success: false,
        error: "TonAPI authentication error (401). Please check your TonAPI key configuration.",
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `TonAPI error: ${response.status}`,
      };
    }

    const data = await response.json();
    return processBalances(data);
  } catch (error) {
    log.error({ err: error }, "Error in jetton_balances");
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
