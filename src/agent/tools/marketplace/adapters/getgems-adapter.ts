/**
 * Getgems.io Marketplace Adapter
 *
 * Supports: usernames, anonymous numbers, gifts (both on-chain & off-chain)
 * Method: GraphQL API
 * Getgems supports both upgraded (on-chain NFT) and non-upgraded (off-chain) gifts.
 */

import type { MarketplaceAdapter, MarketplaceListing, SearchParams, AssetKind } from "../types.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:Getgems");

const GETGEMS_API = "https://api.getgems.io/graphql";

interface GetgemsNFT {
  address: string;
  name: string;
  sale?: {
    price?: { value: string };
    fullPrice?: string;
  };
  collection?: {
    name: string;
    address: string;
  };
  metadata?: Record<string, unknown>;
  owner?: { address: string };
}

async function queryGetgems(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(GETGEMS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Getgems API ${res.status}`);
  const data = await res.json();
  return data?.data;
}

function nftToListing(nft: GetgemsNFT, assetKind: AssetKind): MarketplaceListing {
  const priceRaw = nft.sale?.fullPrice || nft.sale?.price?.value;
  const priceTon = priceRaw ? Number(priceRaw) / 1e9 : null;

  return {
    marketplace: "getgems",
    assetKind,
    externalId: nft.address,
    url: `https://getgems.io/nft/${nft.address}`,
    identifier: nft.name,
    collection: nft.collection?.name,
    priceTon,
    originalCurrency: "TON",
    originalPrice: priceTon,
    listingType: "fixed",
    seller: nft.owner?.address,
    onChain: true,
  };
}

// Known Getgems collection addresses for Telegram assets
const _COLLECTIONS = {
  usernames: "EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N",
  numbers: "EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N", // Same collection, different NFTs
};

export const getgemsAdapter: MarketplaceAdapter = {
  id: "getgems",
  name: "Getgems",
  supports: ["username", "number", "gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    try {
      // Getgems NFT search query
      const query = `
        query NftSearch($query: String!, $first: Int) {
          alphaNftSearch(query: $query, first: $first) {
            edges {
              node {
                address
                name
                sale { price { value } fullPrice }
                collection { name address }
                owner { address }
              }
            }
          }
        }
      `;

      const searchQuery = params.query || params.collection || "";
      const data = (await queryGetgems(query, {
        query: searchQuery,
        first: params.limit ?? 20,
      })) as { alphaNftSearch?: { edges: Array<{ node: GetgemsNFT }> } };

      if (!data?.alphaNftSearch?.edges) return [];

      let listings = data.alphaNftSearch.edges.map((e) => nftToListing(e.node, params.assetKind));

      // For gift searches, filter to only results matching the requested collection
      // Getgems text search returns any NFT matching the query, not just the collection
      if (params.assetKind === "gift" && params.collection) {
        const colLower = params.collection.toLowerCase();
        listings = listings.filter(
          (l) => l.collection && l.collection.toLowerCase().includes(colLower)
        );
      }

      return listings.filter((l) => {
        if (params.maxPrice && l.priceTon && l.priceTon > params.maxPrice) return false;
        return true;
      });
    } catch (err) {
      log.error({ err }, "Getgems search failed");
      return [];
    }
  },

  async getListing(assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    try {
      const query = `
        query NftByAddress($address: String!) {
          nftItemByAddress(address: $address) {
            address
            name
            sale { price { value } fullPrice }
            collection { name address }
            owner { address }
          }
        }
      `;

      const data = (await queryGetgems(query, { address: identifier })) as {
        nftItemByAddress?: GetgemsNFT;
      };

      if (!data?.nftItemByAddress) return null;
      return nftToListing(data.nftItemByAddress, assetKind);
    } catch (err) {
      log.error({ err }, "Getgems getListing failed");
      return null;
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(GETGEMS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
