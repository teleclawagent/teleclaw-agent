import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { createMarketAppAdapter } from "../adapters/marketapp-adapter.js";

describe("Market.app adapter token scoping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not leak Authorization header across concurrent adapter instances", async () => {
    const seenAuth: string[] = [];

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) seenAuth.push(auth);
      return { ok: true, json: async () => [] } as unknown as Response;
    }) as unknown as Mock;

    vi.stubGlobal("fetch", fetchMock);

    const a = createMarketAppAdapter("token-A");
    const b = createMarketAppAdapter("token-B");

    const [okA, okB] = await Promise.all([a.isAvailable(), b.isAvailable()]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);

    expect(seenAuth).toContain("token-A");
    expect(seenAuth).toContain("token-B");
    expect(seenAuth.filter((t) => t === "token-A").length).toBe(1);
    expect(seenAuth.filter((t) => t === "token-B").length).toBe(1);
  });
});
