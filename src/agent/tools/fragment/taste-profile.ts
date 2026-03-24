/**
 * 👤 Taste Profile — Learn user preferences from example usernames.
 *
 * Instead of asking users to pick categories manually,
 * we ask them to share usernames they like or own.
 * From those examples, we build a taste profile:
 * - Preferred length ranges
 * - Keyword themes they gravitate to
 * - Pattern preferences (numeric, clean words, brandable)
 * - Price range comfort
 *
 * When a new listing appears, we score it against each user's
 * taste profile for personalized matching.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { categorizeUsername, type CategoryKey } from "./categorizer.js";
import { checkUsername } from "./fragment-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("TasteProfile");

// ─── Types ───────────────────────────────────────────────────────────

interface TasteProfile {
  userId: number;
  examples: string[];
  categoryWeights: Record<string, number>; // category → weight (0-1)
  avgLength: number;
  lengthRange: { min: number; max: number };
  avgPrice: number;
  priceRange: { min: number; max: number };
  patterns: string[]; // preferred patterns: "numeric", "single_word", "brandable", etc.
  keywords: string[]; // extracted keywords from examples
  updatedAt: string;
}

// ─── DB ──────────────────────────────────────────────────────────────

function ensureProfileTable(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS mm_taste_profiles (
      user_id INTEGER PRIMARY KEY,
      examples TEXT NOT NULL,
      category_weights TEXT NOT NULL,
      avg_length REAL NOT NULL DEFAULT 5,
      length_min INTEGER NOT NULL DEFAULT 3,
      length_max INTEGER NOT NULL DEFAULT 15,
      avg_price REAL,
      price_min REAL,
      price_max REAL,
      patterns TEXT NOT NULL DEFAULT '[]',
      keywords TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ─── Profile Builder ─────────────────────────────────────────────────

function buildProfile(
  userId: number,
  examples: string[],
  valuations: Array<{ username: string; priceRaw?: number; categories: CategoryKey[] }>
): TasteProfile {
  // Count category occurrences across all examples
  const catCounts: Record<string, number> = {};
  const allKeywords: string[] = [];

  for (const v of valuations) {
    for (const cat of v.categories) {
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    // Extract sub-words as keywords
    const clean = v.username.replace(/^@/, "").toLowerCase();
    // Split by common separators and extract meaningful parts
    const parts = clean.match(/[a-z]+|[0-9]+/g) || [clean];
    allKeywords.push(...parts.filter((p) => p.length >= 2));
  }

  // Normalize to weights (0-1)
  const maxCount = Math.max(...Object.values(catCounts), 1);
  const categoryWeights: Record<string, number> = {};
  for (const [cat, count] of Object.entries(catCounts)) {
    // Filter out length-only categories from weights — they're too generic
    if (["ultra_short", "short", "medium", "standard"].includes(cat)) continue;
    categoryWeights[cat] = Math.round((count / maxCount) * 100) / 100;
  }

  // Length stats
  const lengths = examples.map((e) => e.replace(/^@/, "").length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const lengthRange = {
    min: Math.min(...lengths),
    max: Math.max(...lengths),
  };

  // Price stats
  const prices = valuations
    .map((v) => v.priceRaw)
    .filter((p): p is number => p !== undefined && p > 0);
  const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const priceRange =
    prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 };

  // Pattern preferences
  const patterns: string[] = [];
  const patternCats: CategoryKey[] = [
    "numeric",
    "repeating",
    "palindrome",
    "brandable",
    "single_word",
    "emoji_name",
  ];
  for (const pat of patternCats) {
    if (categoryWeights[pat]) patterns.push(pat);
  }

  // Deduplicate keywords
  const uniqueKeywords = [...new Set(allKeywords)].slice(0, 30);

  return {
    userId,
    examples,
    categoryWeights,
    avgLength: Math.round(avgLength * 10) / 10,
    lengthRange,
    avgPrice: Math.round(avgPrice),
    priceRange,
    patterns,
    keywords: uniqueKeywords,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Score how well a username matches a user's taste profile.
 * Returns 0-100 score.
 */
export function matchScore(
  profile: TasteProfile,
  targetCategories: CategoryKey[],
  targetUsername: string,
  targetPrice?: number
): number {
  let score = 0;
  let maxScore = 0;

  // ── Category overlap (50% weight) ──
  maxScore += 50;
  const weightedOverlap = targetCategories.reduce((sum, cat) => {
    return sum + (profile.categoryWeights[cat] || 0);
  }, 0);
  const maxPossibleWeight = Math.max(...Object.values(profile.categoryWeights), 0.01);
  score += Math.min(50, (weightedOverlap / maxPossibleWeight) * 50);

  // ── Length preference (20% weight) ──
  maxScore += 20;
  const targetLen = targetUsername.replace(/^@/, "").length;
  if (targetLen >= profile.lengthRange.min && targetLen <= profile.lengthRange.max) {
    // Within range — full points
    score += 20;
  } else {
    // Distance penalty
    const dist = Math.min(
      Math.abs(targetLen - profile.lengthRange.min),
      Math.abs(targetLen - profile.lengthRange.max)
    );
    score += Math.max(0, 20 - dist * 4);
  }

  // ── Keyword similarity (20% weight) ──
  maxScore += 20;
  const targetClean = targetUsername.replace(/^@/, "").toLowerCase();
  const targetParts = targetClean.match(/[a-z]+|[0-9]+/g) || [targetClean];
  const keywordHits = profile.keywords.filter((k) =>
    targetParts.some((p) => p.includes(k) || k.includes(p))
  ).length;
  score += Math.min(20, (keywordHits / Math.max(profile.keywords.length, 1)) * 60);

  // ── Price range (10% weight) ──
  maxScore += 10;
  if (targetPrice !== undefined && profile.priceRange.max > 0) {
    if (targetPrice >= profile.priceRange.min && targetPrice <= profile.priceRange.max * 1.5) {
      score += 10;
    } else if (targetPrice < profile.priceRange.min) {
      score += 7; // Cheaper than usual — still good
    } else {
      const overshoot = targetPrice / profile.priceRange.max;
      score += Math.max(0, 10 - overshoot * 3);
    }
  } else {
    score += 5; // No price data — neutral
  }

  return Math.round(Math.min(100, (score / maxScore) * 100));
}

// ─── Tools ───────────────────────────────────────────────────────────

interface SetupProfileParams {
  examples: string[];
  max_budget?: number;
}

export const tasteSetupTool: Tool = {
  name: "mm_setup_profile",
  description:
    "👤 Set up your taste profile by sharing 3-10 usernames you like or own. " +
    "Teleclaw analyzes them to understand your preferences (themes, length, price range). " +
    "When matching usernames are listed for sale, you'll be notified automatically. " +
    "Much better than picking categories manually — let your examples speak.",
  category: "action",
  parameters: Type.Object({
    examples: Type.Array(
      Type.String({ description: "A username you like or own (with or without @)" }),
      {
        description: "3-10 example usernames that represent your taste",
        minItems: 3,
        maxItems: 10,
      }
    ),
    max_budget: Type.Optional(
      Type.Number({
        description: "Max TON you'd spend on a single username",
        minimum: 0,
      })
    ),
  }),
};

export const tasteSetupExecutor: ToolExecutor<SetupProfileParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureProfileTable(context);

    // 🔒 Token Gate: verify $TELECLAW holdings for matchmaker features
    const { checkTokenGate } = await import("./token-gate.js");
    const gateResult = await checkTokenGate(context.db, context.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    const { examples, max_budget } = params;

    // Categorize + valuate all examples
    const valuations = [];
    for (const ex of examples) {
      const clean = ex.replace(/^@/, "").toLowerCase();
      const cats = categorizeUsername(clean);
      const status = await checkUsername(clean);
      valuations.push({
        username: `@${clean}`,
        categories: cats.categories,
        labels: cats.labels,
        priceRaw: status?.priceRaw,
        status: status?.status,
      });
    }

    // Build profile
    const profile = buildProfile(
      context.senderId,
      examples.map((e) => `@${e.replace(/^@/, "").toLowerCase()}`),
      valuations
    );

    // Override price range if budget specified
    if (max_budget) {
      profile.priceRange.max = max_budget;
    }

    // Save to DB
    context.db
      .prepare(
        `INSERT OR REPLACE INTO mm_taste_profiles
         (user_id, examples, category_weights, avg_length, length_min, length_max,
          avg_price, price_min, price_max, patterns, keywords, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        context.senderId,
        JSON.stringify(profile.examples),
        JSON.stringify(profile.categoryWeights),
        profile.avgLength,
        profile.lengthRange.min,
        profile.lengthRange.max,
        profile.avgPrice,
        profile.priceRange.min,
        profile.priceRange.max,
        JSON.stringify(profile.patterns),
        JSON.stringify(profile.keywords),
        profile.updatedAt
      );

    // Format category weights for display (top 5)
    const topCats = Object.entries(profile.categoryWeights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    const catBars = topCats
      .map(([cat, weight]) => {
        const bar = "█".repeat(Math.round(weight * 10)) + "░".repeat(10 - Math.round(weight * 10));
        return `  ${bar} ${cat} (${Math.round(weight * 100)}%)`;
      })
      .join("\n");

    const exampleAnalysis = valuations
      .map((v) => `  ${v.username} → ${v.labels.slice(0, 3).join(", ")}`)
      .join("\n");

    return {
      success: true,
      data: {
        profile: {
          topCategories: topCats.map(([cat]) => cat),
          avgLength: profile.avgLength,
          lengthRange: profile.lengthRange,
          priceRange: profile.priceRange,
          patterns: profile.patterns,
          keywordCount: profile.keywords.length,
        },
        message:
          `👤 Taste profile created!\n\n` +
          `Your examples:\n${exampleAnalysis}\n\n` +
          `Your preference profile:\n${catBars}\n\n` +
          `Length preference: ${profile.lengthRange.min}-${profile.lengthRange.max} chars (avg: ${profile.avgLength})\n` +
          `${max_budget ? `Budget: up to ${max_budget} TON\n` : ""}` +
          `Keywords: ${profile.keywords.slice(0, 10).join(", ")}\n\n` +
          `✅ You'll be notified when matching usernames are listed for sale.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Setup profile error");
    return { success: false, error: String(error) };
  }
};

// ─── View Profile ────────────────────────────────────────────────────

export const tasteViewTool: Tool = {
  name: "mm_my_profile",
  description: "View your current taste profile and preferences.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const tasteViewExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureProfileTable(context);

    const row = context.db
      .prepare(`SELECT * FROM mm_taste_profiles WHERE user_id = ?`)
      .get(context.senderId) as Record<string, unknown> | undefined;

    if (!row) {
      return {
        success: true,
        data: {
          message:
            "No taste profile yet. Use mm_setup_profile with 3-10 example usernames to create one.",
        },
      };
    }

    const weights: Record<string, number> = JSON.parse(row.category_weights as string);
    const examples: string[] = JSON.parse(row.examples as string);
    const keywords: string[] = JSON.parse(row.keywords as string);
    const patterns: string[] = JSON.parse(row.patterns as string);

    const topCats = Object.entries(weights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    const catBars = topCats
      .map(([cat, weight]) => {
        const bar = "█".repeat(Math.round(weight * 10)) + "░".repeat(10 - Math.round(weight * 10));
        return `  ${bar} ${cat} (${Math.round(weight * 100)}%)`;
      })
      .join("\n");

    return {
      success: true,
      data: {
        message:
          `👤 Your Taste Profile\n\n` +
          `Examples: ${examples.join(", ")}\n\n` +
          `Preferences:\n${catBars}\n\n` +
          `Length: ${row.length_min}-${row.length_max} chars (avg: ${row.avg_length})\n` +
          `${(row.price_max as number) > 0 ? `Budget: ${row.price_min}-${row.price_max} TON\n` : ""}` +
          `Patterns: ${patterns.length > 0 ? patterns.join(", ") : "none specific"}\n` +
          `Keywords: ${keywords.slice(0, 15).join(", ")}\n\n` +
          `Last updated: ${row.updated_at}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "View profile error");
    return { success: false, error: String(error) };
  }
};

// ─── Find Matches for a Listing (internal use by matchmaker) ─────────

/**
 * Score all taste profiles against a new listing.
 * Returns user IDs with match scores above threshold.
 */
export function findMatchingBuyers(
  ctx: ToolContext,
  listingUsername: string,
  listingCategories: CategoryKey[],
  listingPrice?: number,
  minScore: number = 40
): Array<{ userId: number; score: number }> {
  try {
    const profiles = ctx.db.prepare(`SELECT * FROM mm_taste_profiles`).all() as Array<
      Record<string, unknown>
    >;

    const matches: Array<{ userId: number; score: number }> = [];

    for (const row of profiles) {
      const profile: TasteProfile = {
        userId: row.user_id as number,
        examples: JSON.parse(row.examples as string),
        categoryWeights: JSON.parse(row.category_weights as string),
        avgLength: row.avg_length as number,
        lengthRange: { min: row.length_min as number, max: row.length_max as number },
        avgPrice: (row.avg_price as number) || 0,
        priceRange: { min: (row.price_min as number) || 0, max: (row.price_max as number) || 0 },
        patterns: JSON.parse(row.patterns as string),
        keywords: JSON.parse(row.keywords as string),
        updatedAt: row.updated_at as string,
      };

      const score = matchScore(profile, listingCategories, listingUsername, listingPrice);
      if (score >= minScore) {
        matches.push({ userId: profile.userId, score });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  } catch (error) {
    log.error({ err: error }, "findMatchingBuyers error");
    return [];
  }
}
