import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { fetchWithTimeout } from "../../../utils/fetch.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

interface DexScreenerParams {
  query: string;
}

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { name: string; symbol: string; address: string };
  quoteToken: { name: string; symbol: string; address: string };
  priceUsd: string;
  priceNative: string;
  priceChange: Record<string, number>;
  volume: Record<string, number>;
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  txns: Record<string, { buys: number; sells: number }>;
  pairCreatedAt: number;
  info?: {
    websites?: Array<{ url: string }>;
    socials?: Array<{ url: string; type: string }>;
  };
}

export const dexScreenerTool: Tool = {
  name: "dexscreener_search",
  description:
    "Search DexScreener for token info on TON (or any chain). Returns price, market cap, liquidity, volume, " +
    "pair address, contract address, and links. Best source for accurate real-time token data. " +
    "Use this FIRST when asked about any token's price, market cap, or trading info.",
  category: "data-bearing",
  parameters: Type.Object({
    query: Type.String({
      description:
        "Token name, symbol, or contract address to search (e.g., 'Teleclaw', 'NOT', 'EQD01Tw...')",
    }),
  }),
};

export const dexScreenerExecutor: ToolExecutor<DexScreenerParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { query } = params;
    const isAddress = query.startsWith("EQ") || query.startsWith("UQ") || query.length > 40;

    let pairs: DexPair[] = [];

    if (isAddress) {
      const resp = await fetchWithTimeout(
        `https://api.dexscreener.com/tokens/v1/ton/${encodeURIComponent(query)}`,
        { timeoutMs: 10_000 }
      );
      if (resp.ok) {
        const data = (await resp.json()) as DexPair[] | { pairs: DexPair[] };
        pairs = Array.isArray(data) ? data : data?.pairs || [];
      }
    }

    if (pairs.length === 0) {
      const resp = await fetchWithTimeout(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
        { timeoutMs: 10_000 }
      );
      if (resp.ok) {
        const data = (await resp.json()) as { pairs: DexPair[] };
        pairs = (data?.pairs || []).filter((p) => p.chainId === "ton");
      }
    }

    if (pairs.length === 0) {
      return {
        success: true,
        data: {
          found: false,
          message: `No token found on DexScreener for "${query}" on TON chain.`,
        },
      };
    }

    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    const topPairs = pairs.slice(0, 3).map((p) => ({
      dex: p.dexId,
      pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      pairAddress: p.pairAddress,
      baseToken: {
        name: p.baseToken?.name,
        symbol: p.baseToken?.symbol,
        address: p.baseToken?.address,
      },
      price: { usd: p.priceUsd, native: p.priceNative },
      priceChange: p.priceChange,
      volume24h: p.volume?.h24,
      liquidity: p.liquidity,
      fdv: p.fdv,
      marketCap: p.marketCap,
      txns24h: p.txns?.h24,
      pairCreatedAt: p.pairCreatedAt
        ? new Date(p.pairCreatedAt).toISOString().split("T")[0]
        : undefined,
      url: p.url,
      info: {
        website: p.info?.websites?.[0]?.url,
        twitter: p.info?.socials?.find((s) => s.type === "twitter")?.url,
        telegram: p.info?.socials?.find((s) => s.type === "telegram")?.url,
      },
    }));

    const main = topPairs[0];
    let message = `**${main.baseToken.name} (${main.baseToken.symbol})**\n`;
    message += `• Price: $${main.price.usd}\n`;
    message += `• Market Cap: $${Number(main.marketCap || 0).toLocaleString()}\n`;
    message += `• 24h Volume: $${Number(main.volume24h || 0).toLocaleString()}\n`;
    message += `• Liquidity: $${Number(main.liquidity?.usd || 0).toLocaleString()}\n`;
    message += `• DEX: ${main.dex}\n`;
    message += `• Contract: ${main.baseToken.address}\n`;
    if (main.pairCreatedAt) message += `• Created: ${main.pairCreatedAt}\n`;
    if (main.txns24h)
      message += `• 24h Txns: ${main.txns24h.buys} buys / ${main.txns24h.sells} sells\n`;

    return {
      success: true,
      data: { found: true, pairs: topPairs, message },
    };
  } catch (error) {
    log.error({ err: error }, "Error in dexscreener_search");
    return { success: false, error: getErrorMessage(error) };
  }
};
