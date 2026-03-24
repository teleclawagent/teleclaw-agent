import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { getWalletAddress } from "../../../ton/wallet-service.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

interface NftListParams {
  address?: string;
  collection?: string;
  limit?: number;
}

export const nftListTool: Tool = {
  name: "nft_list",
  description:
    "Browse NFTs owned by a TON wallet. Defaults to your own wallet. Optionally filter by collection address. Returns name, preview image, and collection metadata per NFT.",
  parameters: Type.Object({
    address: Type.Optional(
      Type.String({
        description: "TON wallet address to query. Defaults to your wallet.",
      })
    ),
    collection: Type.Optional(
      Type.String({
        description: "Filter by collection contract address.",
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max NFTs to return (1-100). Defaults to 50.",
        minimum: 1,
        maximum: 100,
      })
    ),
  }),
  category: "data-bearing",
};

interface NftItem {
  address: string;
  name: string;
  description: string;
  collection: string | null;
  collectionAddress: string | null;
  preview: string | null;
  onSale: boolean;
  salePrice: string | null;
  marketplace: string | null;
  dns: string | null;
  trust: string;
  explorer: string;
}

export const nftListExecutor: ToolExecutor<NftListParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const address = params.address || getWalletAddress();
    if (!address) {
      return {
        success: false,
        error: "No address provided and agent wallet is not initialized.",
      };
    }

    const limit = params.limit || 50;
    const queryParts = [`limit=${limit}`, "indirect_ownership=true"];
    if (params.collection) {
      queryParts.push(`collection=${encodeURIComponent(params.collection)}`);
    }

    const url = `/accounts/${encodeURIComponent(address)}/nfts?${queryParts.join("&")}`;
    let res = await tonapiFetch(url);

    // Retry on transient errors
    if (res.status === 502 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await tonapiFetch(url);
    }

    // TonAPI 401 — try Toncenter fallback
    if (res.status === 401) {
      log.warn("TonAPI 401 — trying Toncenter fallback for NFT list");
      try {
        const tcUrl = `https://toncenter.com/api/v3/nft/items?owner_address=${encodeURIComponent(address)}&limit=${limit}&offset=0`;
        const tcRes = await fetch(tcUrl, { headers: { Accept: "application/json" } });
        if (tcRes.ok) {
          const tcData = await tcRes.json();
          const tcItems = (tcData.nft_items || []) as Record<string, unknown>[];
          const nfts: NftItem[] = tcItems
            .filter((item) => (item.trust as string) !== "blacklist")
            .map((item) => {
              const meta = (item.metadata || {}) as Record<string, unknown>;
              const coll = (item.collection || {}) as Record<string, unknown>;
              return {
                address: (item.address as string) || "",
                name: (meta.name as string) || "Unnamed NFT",
                description: ((meta.description as string) || "").slice(0, 100),
                collection: (coll.name as string) || null,
                collectionAddress: (coll.address as string) || null,
                preview: (meta.image as string) || null,
                onSale: false,
                salePrice: null,
                marketplace: null,
                dns: (item.dns as string) || null,
                trust: (item.trust as string) || "none",
                explorer: `https://tonviewer.com/${item.address}`,
              };
            });

          const summary = `Found ${nfts.length} NFT(s) for ${address} (via Toncenter fallback).`;
          return {
            success: true,
            data: {
              address,
              totalNfts: nfts.length,
              hasMore: tcItems.length >= limit,
              nfts,
              message: summary,
              summary,
            },
          };
        }
      } catch (tcErr) {
        log.error({ err: tcErr }, "Toncenter NFT fallback failed");
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        success: false,
        error: `TonAPI returned ${res.status}: ${text || res.statusText}`,
      };
    }

    const data = await res.json();
    if (!Array.isArray(data.nft_items)) {
      return {
        success: false,
        error: "Invalid API response: missing nft_items array",
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TON API response is untyped
    const rawItems: any[] = data.nft_items;

    // Filter out blacklisted NFTs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TON API response is untyped
    const filtered = rawItems.filter((item: any) => item.trust !== "blacklist");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TON API response is untyped
    const nfts: NftItem[] = filtered.map((item: any) => {
      const meta = item.metadata || {};
      const coll = item.collection || {};
      const sale = item.sale;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TON API response is untyped
      const previews: any[] = item.previews || [];

      // Pick a mid-resolution preview (500x500 if available)
      const preview =
        (previews.length > 1 && previews[1].url) ||
        (previews.length > 0 && previews[0].url) ||
        null;

      let salePrice: string | null = null;
      if (sale?.price?.value) {
        const raw = Number(sale.price.value);
        if (!isNaN(raw) && raw > 0) {
          const amount = raw / 1e9;
          const currency = sale.price.token_name || "TON";
          salePrice = `${amount} ${currency}`;
        }
      }

      return {
        address: item.address,
        name: meta.name || "Unnamed NFT",
        description: (meta.description || "").slice(0, 100),
        collection: coll.name || null,
        collectionAddress: coll.address || null,
        preview,
        onSale: !!sale,
        salePrice,
        marketplace: sale?.marketplace || null,
        dns: item.dns || null,
        trust: item.trust || "none",
        explorer: `https://tonviewer.com/${item.address}`,
      };
    });

    const hasMore = rawItems.length >= limit;
    const summary = `Found ${nfts.length} NFT(s) for ${address}${params.collection ? ` in collection ${params.collection}` : ""}${hasMore ? ` (limit ${limit} reached, there may be more)` : ""}.`;
    const onSaleCount = nfts.filter((n) => n.onSale).length;
    const collections = [...new Set(nfts.map((n) => n.collection).filter(Boolean))];

    const message = `${summary}${onSaleCount > 0 ? ` ${onSaleCount} on sale.` : ""} Collections: ${collections.length > 0 ? collections.join(", ") : "none"}.`;

    return {
      success: true,
      data: {
        address,
        totalNfts: nfts.length,
        hasMore,
        nfts,
        message,
        summary,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Error in nft_list");
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
