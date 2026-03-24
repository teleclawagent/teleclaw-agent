import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { getCachedTonClient, getTonPrice } from "../../../ton/wallet-service.js";
import { Address } from "@ton/core";
import { fromNano } from "@ton/ton";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Portfolio");

interface TokenHolding {
  symbol: string;
  name: string;
  balance: string;
  balanceRaw: string;
  decimals: number;
  jettonAddress: string;
  priceUsd: number | null;
  valueUsd: number | null;
  change24h: number | null;
  verified: boolean;
}

/**
 * Fetch full portfolio for an address — TON + all jettons with USD values.
 */
async function fetchPortfolio(address: string): Promise<{
  tonBalance: string;
  tonValueUsd: number | null;
  tonPriceUsd: number | null;
  tokens: TokenHolding[];
  totalValueUsd: number | null;
  error?: string;
}> {
  // 1. Get TON balance
  let tonBalance = "0";
  try {
    const client = await getCachedTonClient();
    const addr = Address.parse(address);
    const balance = await client.getBalance(addr);
    tonBalance = fromNano(balance);
  } catch (err) {
    log.error({ err: getErrorMessage(err) }, "Failed to get TON balance");
  }

  // 2. Get TON price
  const tonPriceData = await getTonPrice();
  const tonPriceUsd = tonPriceData?.usd ?? null;
  const tonValueUsd = tonPriceUsd ? parseFloat(tonBalance) * tonPriceUsd : null;

  // 3. Get all jetton balances with prices
  const tokens: TokenHolding[] = [];
  try {
    const response = await tonapiFetch(`/accounts/${address}/jettons?currencies=usd`);

    if (response.ok) {
      const data = await response.json();

      for (const item of data.balances || []) {
        const { balance, jetton, price } = item;

        // Skip blacklisted/scam tokens
        if (jetton.verification === "blacklist") continue;

        const decimals = jetton.decimals || 9;
        const rawAmount = BigInt(balance);
        const divisor = BigInt(10 ** decimals);
        const whole = rawAmount / divisor;
        const frac = rawAmount % divisor;
        const formattedBalance =
          frac === BigInt(0)
            ? whole.toString()
            : `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;

        // Skip zero balances
        if (rawAmount === BigInt(0)) continue;

        const priceUsd = price?.prices?.USD ?? null;
        const balanceFloat = Number(rawAmount) / 10 ** decimals;
        const valueUsd = priceUsd ? balanceFloat * priceUsd : null;

        // 24h change from price data
        const change24h = price?.diff_24h?.USD ? parseFloat(price.diff_24h.USD) : null;

        tokens.push({
          symbol: jetton.symbol || "???",
          name: jetton.name || "Unknown",
          balance: formattedBalance,
          balanceRaw: balance,
          decimals,
          jettonAddress: jetton.address,
          priceUsd,
          valueUsd,
          change24h,
          verified: jetton.verification === "whitelist",
        });
      }
    }
  } catch (err) {
    log.error({ err: getErrorMessage(err) }, "Failed to fetch jetton balances");
  }

  // Sort by value (highest first), unpriced at bottom
  tokens.sort((a, b) => {
    if (a.valueUsd === null && b.valueUsd === null) return 0;
    if (a.valueUsd === null) return 1;
    if (b.valueUsd === null) return -1;
    return b.valueUsd - a.valueUsd;
  });

  // Total portfolio value
  let totalValueUsd: number | null = tonValueUsd;
  for (const t of tokens) {
    if (t.valueUsd !== null) {
      totalValueUsd = (totalValueUsd ?? 0) + t.valueUsd;
    }
  }

  return { tonBalance, tonValueUsd, tonPriceUsd, tokens, totalValueUsd };
}

// ─── Tool: Portfolio Overview ────────────────────────────────────────

const portfolioTool: Tool = {
  name: "portfolio_show",
  description:
    "Show a full portfolio breakdown for a TON wallet address. Displays TON balance, all jetton holdings with USD values, 24h price changes, and total portfolio value. Works for any address — your own or anyone else's.",
  category: "data-bearing",
  parameters: Type.Object({
    address: Type.String({
      description: "TON wallet address to view portfolio for (EQ... or UQ... format)",
    }),
  }),
};

const portfolioExecutor: ToolExecutor<{ address: string }> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    // Validate address
    try {
      Address.parse(params.address);
    } catch {
      return { success: false, error: `Invalid TON address: ${params.address}` };
    }

    const portfolio = await fetchPortfolio(params.address);

    // Build formatted output
    const addrShort = `${params.address.slice(0, 6)}...${params.address.slice(-4)}`;

    let msg = `💼 **Portfolio: ${addrShort}**\n\n`;

    // TON
    msg += `**TON:** ${parseFloat(portfolio.tonBalance).toFixed(2)} TON`;
    if (portfolio.tonValueUsd !== null) {
      msg += ` ($${portfolio.tonValueUsd.toFixed(2)})`;
    }
    msg += `\n`;

    // Tokens
    if (portfolio.tokens.length > 0) {
      msg += `\n**Tokens:**\n`;
      for (const t of portfolio.tokens.slice(0, 20)) {
        const changeEmoji =
          t.change24h === null
            ? ""
            : t.change24h >= 0
              ? ` 🟢 +${t.change24h.toFixed(1)}%`
              : ` 🔴 ${t.change24h.toFixed(1)}%`;

        const valueStr = t.valueUsd !== null ? ` ($${t.valueUsd.toFixed(2)})` : "";
        const verifiedMark = t.verified ? " ✅" : "";

        msg += `• **${t.symbol}${verifiedMark}:** ${t.balance}${valueStr}${changeEmoji}\n`;
      }

      if (portfolio.tokens.length > 20) {
        msg += `\n_...and ${portfolio.tokens.length - 20} more tokens_\n`;
      }
    }

    // Total
    if (portfolio.totalValueUsd !== null) {
      msg += `\n━━━━━━━━━━━━━━━━━━\n`;
      msg += `**Total Value: $${portfolio.totalValueUsd.toFixed(2)}**\n`;
    }

    if (portfolio.tonPriceUsd) {
      msg += `\n_TON price: $${portfolio.tonPriceUsd.toFixed(2)}_`;
    }

    return {
      success: true,
      data: {
        address: params.address,
        tonBalance: portfolio.tonBalance,
        tonValueUsd: portfolio.tonValueUsd,
        tonPriceUsd: portfolio.tonPriceUsd,
        tokens: portfolio.tokens,
        totalValueUsd: portfolio.totalValueUsd,
        tokenCount: portfolio.tokens.length,
        message: msg,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Token Price Check ─────────────────────────────────────────

const priceCheckTool: Tool = {
  name: "portfolio_price",
  description:
    "Get current price and 24h change for a specific token. Works with jetton contract addresses or well-known tokens.",
  category: "data-bearing",
  parameters: Type.Object({
    token: Type.String({
      description: "Token contract address (EQ... format) or 'ton' for TON price",
    }),
  }),
};

const priceCheckExecutor: ToolExecutor<{ token: string }> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    if (params.token.toLowerCase() === "ton") {
      const tonPrice = await getTonPrice();
      if (!tonPrice) {
        return { success: false, error: "Could not fetch TON price." };
      }
      return {
        success: true,
        data: {
          symbol: "TON",
          priceUsd: tonPrice.usd,
          source: tonPrice.source,
          message: `**TON:** $${tonPrice.usd.toFixed(4)} (via ${tonPrice.source})`,
        },
      };
    }

    // Jetton price via TonAPI
    const response = await tonapiFetch(`/rates?tokens=${params.token}&currencies=usd`);

    if (!response.ok) {
      return { success: false, error: `Could not fetch price for ${params.token}` };
    }

    const data = await response.json();
    const rateKey = Object.keys(data?.rates || {})[0];
    if (!rateKey) {
      return { success: false, error: "Token not found or no price data available." };
    }

    const price = data.rates[rateKey]?.prices?.USD;
    const diff24h = data.rates[rateKey]?.diff_24h?.USD;

    return {
      success: true,
      data: {
        token: params.token,
        priceUsd: price,
        change24h: diff24h ? parseFloat(diff24h) : null,
        message: `**Price:** $${price?.toFixed(6) ?? "N/A"}${diff24h ? ` (${parseFloat(diff24h) >= 0 ? "+" : ""}${parseFloat(diff24h).toFixed(1)}% 24h)` : ""}`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Compare Portfolios ────────────────────────────────────────

const comparePortfolioTool: Tool = {
  name: "portfolio_compare",
  description:
    "Compare two wallet addresses side by side — total values, shared tokens, unique holdings.",
  category: "data-bearing",
  parameters: Type.Object({
    address1: Type.String({ description: "First wallet address" }),
    address2: Type.String({ description: "Second wallet address" }),
  }),
};

const comparePortfolioExecutor: ToolExecutor<{
  address1: string;
  address2: string;
}> = async (params, _context): Promise<ToolResult> => {
  try {
    Address.parse(params.address1);
    Address.parse(params.address2);
  } catch {
    return { success: false, error: "One or both addresses are invalid." };
  }

  try {
    const [p1, p2] = await Promise.all([
      fetchPortfolio(params.address1),
      fetchPortfolio(params.address2),
    ]);

    const addr1Short = `${params.address1.slice(0, 6)}...${params.address1.slice(-4)}`;
    const addr2Short = `${params.address2.slice(0, 6)}...${params.address2.slice(-4)}`;

    // Find shared and unique tokens
    const tokens1 = new Set(p1.tokens.map((t) => t.symbol));
    const tokens2 = new Set(p2.tokens.map((t) => t.symbol));
    const shared = [...tokens1].filter((t) => tokens2.has(t));
    const unique1 = [...tokens1].filter((t) => !tokens2.has(t));
    const unique2 = [...tokens2].filter((t) => !tokens1.has(t));

    return {
      success: true,
      data: {
        wallet1: {
          address: params.address1,
          totalUsd: p1.totalValueUsd,
          tokenCount: p1.tokens.length,
        },
        wallet2: {
          address: params.address2,
          totalUsd: p2.totalValueUsd,
          tokenCount: p2.tokens.length,
        },
        sharedTokens: shared,
        uniqueToWallet1: unique1,
        uniqueToWallet2: unique2,
        message:
          `📊 **Portfolio Comparison**\n\n` +
          `**${addr1Short}:** $${p1.totalValueUsd?.toFixed(2) ?? "?"} (${p1.tokens.length} tokens)\n` +
          `**${addr2Short}:** $${p2.totalValueUsd?.toFixed(2) ?? "?"} (${p2.tokens.length} tokens)\n\n` +
          `Shared tokens: ${shared.length > 0 ? shared.join(", ") : "None"}\n` +
          `Only in #1: ${unique1.length > 0 ? unique1.slice(0, 10).join(", ") : "None"}\n` +
          `Only in #2: ${unique2.length > 0 ? unique2.slice(0, 10).join(", ") : "None"}`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Export ──────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: portfolioTool, executor: portfolioExecutor },
  { tool: priceCheckTool, executor: priceCheckExecutor },
  { tool: comparePortfolioTool, executor: comparePortfolioExecutor },
];
