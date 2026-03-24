// src/agent/tools/web/search.ts

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { WEB_SEARCH_MAX_RESULTS } from "../../../constants/limits.js";
import { sanitizeForContext } from "../../../utils/sanitize.js";
import { getErrorMessage } from "../../../utils/errors.js";
import type { Config } from "../../../config/schema.js";

// ── Types ──────────────────────────────────────────────────────────────

interface WebSearchParams {
  query: string;
  count?: number;
  country?: string;
  language?: string;
  freshness?: "day" | "week" | "month" | "year";
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
}

type ProviderName = "brave" | "gemini" | "grok" | "kimi" | "perplexity";

// ── Cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const cache = new Map<string, { ts: number; data: SearchResponse }>();

function getCached(key: string): SearchResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: SearchResponse): void {
  cache.set(key, { ts: Date.now(), data });
  // Prune old entries periodically
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

// ── Provider Detection ─────────────────────────────────────────────────

function getApiKey(
  config: Config | undefined,
  configKey: string,
  ...envKeys: string[]
): string | undefined {
  // Check config first
  const configVal = (config as Record<string, unknown>)?.[configKey];
  if (typeof configVal === "string" && configVal.length > 0) return configVal;
  // Check env vars
  for (const ek of envKeys) {
    const v = process.env[ek];
    if (v && v.length > 0) return v;
  }
  return undefined;
}

interface ProviderDetection {
  name: ProviderName;
  key: string;
}

const PROVIDER_ORDER: Array<{
  name: ProviderName;
  configKey: string;
  envKeys: string[];
}> = [
  { name: "brave", configKey: "brave_api_key", envKeys: ["BRAVE_API_KEY"] },
  { name: "gemini", configKey: "gemini_api_key", envKeys: ["GEMINI_API_KEY"] },
  { name: "grok", configKey: "xai_api_key", envKeys: ["XAI_API_KEY"] },
  { name: "kimi", configKey: "kimi_api_key", envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"] },
  { name: "perplexity", configKey: "perplexity_api_key", envKeys: ["PERPLEXITY_API_KEY"] },
];

function detectProvider(config: Config | undefined, preferred?: string): ProviderDetection | null {
  // If a specific provider is preferred, try it first
  if (preferred && preferred !== "auto") {
    const entry = PROVIDER_ORDER.find((p) => p.name === preferred);
    if (entry) {
      const key = getApiKey(config, entry.configKey, ...entry.envKeys);
      if (key) return { name: entry.name, key };
    }
  }
  // Auto-detect: try each in order
  for (const entry of PROVIDER_ORDER) {
    const key = getApiKey(config, entry.configKey, ...entry.envKeys);
    if (key) return { name: entry.name, key };
  }
  return null;
}

// ── Provider Implementations ───────────────────────────────────────────

async function searchBrave(
  apiKey: string,
  query: string,
  count: number,
  opts: { country?: string; language?: string; freshness?: string }
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(count) });
  if (opts.country) params.set("country", opts.country);
  if (opts.language) params.set("search_lang", opts.language);
  if (opts.freshness) params.set("freshness", opts.freshness);

  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Brave Search API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };

  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.description,
  }));
}

async function searchGemini(apiKey: string, query: string, count: number): Promise<SearchResult[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gemini API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: { uri: string; title: string };
        }>;
        searchEntryPoint?: { renderedContent?: string };
        groundingSupports?: Array<{
          segment?: { text?: string };
          groundingChunkIndices?: number[];
        }>;
      };
    }>;
  };

  const candidate = data.candidates?.[0];
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const supports = candidate?.groundingMetadata?.groundingSupports ?? [];
  const mainText = candidate?.content?.parts?.[0]?.text ?? "";

  if (chunks.length === 0 && mainText) {
    // No grounding chunks — return the generated answer as a single result
    return [{ title: "Gemini Search Result", url: "", content: mainText.slice(0, 1000) }];
  }

  return chunks.slice(0, count).map((chunk, i) => {
    // Find matching support text for this chunk
    const supportText = supports.find((s) => s.groundingChunkIndices?.includes(i))?.segment?.text;

    return {
      title: chunk.web?.title ?? "Search Result",
      url: chunk.web?.uri ?? "",
      content: supportText ?? mainText.slice(0, 300),
    };
  });
}

async function searchGrok(apiKey: string, query: string, count: number): Promise<SearchResult[]> {
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-3",
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL, and a brief description for each.`,
        },
      ],
      search_parameters: {
        mode: "auto",
        max_search_results: count,
        return_citations: true,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Grok API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        citations?: Array<{ url?: string; title?: string; snippet?: string }>;
      };
    }>;
  };

  const choice = data.choices?.[0]?.message;
  const citations = choice?.citations ?? [];

  if (citations.length > 0) {
    return citations.slice(0, count).map((c) => ({
      title: c.title ?? "Search Result",
      url: c.url ?? "",
      content: c.snippet ?? "",
    }));
  }

  // Fallback: return the content as a single result
  const content = choice?.content ?? "";
  if (content) {
    return [{ title: "Grok Search Result", url: "", content: content.slice(0, 1500) }];
  }
  return [];
}

async function searchKimi(apiKey: string, query: string, count: number): Promise<SearchResult[]> {
  const resp = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "kimi-latest",
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\n\nReturn the top ${count} results as JSON array: [{"title":"...","url":"...","content":"..."}]`,
        },
      ],
      use_search: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Kimi API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        search_results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
    }>;
  };

  const choice = data.choices?.[0]?.message;

  // Try structured search_results first
  if (choice?.search_results && choice.search_results.length > 0) {
    return choice.search_results.slice(0, count).map((r) => ({
      title: r.title ?? "Search Result",
      url: r.url ?? "",
      content: r.snippet ?? "",
    }));
  }

  // Try parsing JSON from content
  const content = choice?.content ?? "";
  try {
    const parsed = JSON.parse(content.replace(/```json?\n?|\n?```/g, "").trim());
    if (Array.isArray(parsed)) {
      return parsed.slice(0, count).map((r: Record<string, string>) => ({
        title: r.title ?? "Search Result",
        url: r.url ?? "",
        content: r.content ?? r.snippet ?? "",
      }));
    }
  } catch {
    // Not JSON — return as single result
  }

  if (content) {
    return [{ title: "Kimi Search Result", url: "", content: content.slice(0, 1500) }];
  }
  return [];
}

async function searchPerplexity(
  apiKey: string,
  query: string,
  count: number
): Promise<SearchResult[]> {
  const resp = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: query }],
      max_tokens: 1024,
      return_citations: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Perplexity API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  const citations = data.citations ?? [];

  if (citations.length > 0) {
    return citations.slice(0, count).map((url, i) => ({
      title: `Result ${i + 1}`,
      url,
      content: content.slice(0, 500),
    }));
  }

  if (content) {
    return [{ title: "Perplexity Search Result", url: "", content: content.slice(0, 1500) }];
  }
  return [];
}

// ── Tool Definition ────────────────────────────────────────────────────

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns results with title, URL, and content snippet. Auto-detects search provider from configured API keys.",
  category: "data-bearing",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results (default 5, max ${WEB_SEARCH_MAX_RESULTS})`,
      })
    ),
    country: Type.Optional(
      Type.String({ description: "2-letter country code for regional results (e.g., US, DE)" })
    ),
    language: Type.Optional(
      Type.String({ description: "Language code for results (e.g., en, de, tr)" })
    ),
    freshness: Type.Optional(
      Type.Union(
        [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
        { description: "Filter by recency: day, week, month, or year" }
      )
    ),
  }),
};

// ── Executor ───────────────────────────────────────────────────────────

export const webSearchExecutor: ToolExecutor<WebSearchParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const config = context.config;
    const preferred = (config as Record<string, unknown>)?.search_provider as string | undefined;
    const provider = detectProvider(config, preferred);

    if (!provider) {
      return {
        success: false,
        error:
          "No web search API key configured. Set one of: brave_api_key, gemini_api_key, xai_api_key, kimi_api_key, or perplexity_api_key in config.yaml (or corresponding env vars like BRAVE_API_KEY).",
      };
    }

    const { query, count = 5, country, language, freshness } = params;
    const maxResults = Math.min(Math.max(1, count), WEB_SEARCH_MAX_RESULTS);

    // Check cache
    const cacheKey = `${provider.name}:${query}:${maxResults}:${country ?? ""}:${language ?? ""}:${freshness ?? ""}`;
    const cached = getCached(cacheKey);
    if (cached) return { success: true, data: cached };

    let results: SearchResult[];

    switch (provider.name) {
      case "brave":
        results = await searchBrave(provider.key, query, maxResults, {
          country,
          language,
          freshness,
        });
        break;
      case "gemini":
        results = await searchGemini(provider.key, query, maxResults);
        break;
      case "grok":
        results = await searchGrok(provider.key, query, maxResults);
        break;
      case "kimi":
        results = await searchKimi(provider.key, query, maxResults);
        break;
      case "perplexity":
        results = await searchPerplexity(provider.key, query, maxResults);
        break;
    }

    const sanitizedResults = results.map((r) => ({
      title: sanitizeForContext(r.title),
      url: r.url,
      content: sanitizeForContext(r.content),
      ...(r.score != null ? { score: r.score } : {}),
    }));

    const response: SearchResponse = {
      query,
      provider: provider.name,
      results: sanitizedResults,
    };

    setCache(cacheKey, response);

    return { success: true, data: response };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
