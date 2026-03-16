/**
 * 🔢 Anonymous Number Rarity Engine
 *
 * Rarity system for +888 Telegram Anonymous Numbers.
 * Based on real Fragment market data (March 2026):
 *
 * Supply: 136,566 total (Dec 2022 mint, no new supply)
 * Formats: 7-digit (+888 8XXX, ~1,000) and 11-digit (+888 0XXX XXXX, ~135,500)
 * Floor: ~1,774 TON
 * #1 Rarest: +888 8 888 (all 8s — the holy grail)
 *
 * Rarity is determined by:
 * 1. Length (7-digit = automatically premium)
 * 2. Pattern quality (repeating, sequential, palindrome, mirror)
 * 3. Lucky digit composition (8 is king, 6/9 premium, 4 avoided)
 * 4. Digit uniqueness (fewer unique digits = rarer)
 */

import { createLogger } from "../../../utils/logger.js";

const log = createLogger("NumberRarity");

// ─── Types ───────────────────────────────────────────────────────────

export type RarityTier = "S" | "A" | "B" | "C" | "D";

export interface RarityResult {
  number: string;          // formatted: +888 8 XXX or +888 0XXX XXXX
  rawDigits: string;       // digits after 888: "8888" or "07684929"
  totalDigits: number;     // 7 or 11
  tier: RarityTier;
  score: number;           // 0-100
  label: string;           // "Legendary", "Epic", etc.
  tags: string[];          // ["short", "all-eights", "repeating", ...]
  breakdown: {
    lengthScore: number;   // 0-100
    patternScore: number;  // 0-100
    luckyScore: number;    // 0-100
    uniquenessScore: number; // 0-100
  };
  estimatedFloor: {
    min: number;           // TON
    max: number;           // TON
  };
}

// ─── Constants ───────────────────────────────────────────────────────

/** Lucky digits in Chinese numerology (critical for TON/crypto market) */
const LUCKY_DIGITS: Record<string, number> = {
  "8": 10,  // 发 (fā) = prosperity. THE premium digit.
  "6": 7,   // 六 (liù) = smooth/flowing
  "9": 6,   // 九 (jiǔ) = longevity
  "0": 4,   // neutral, but round numbers = clean
  "7": 3,   // 七 (qī) = togetherness (neutral-positive)
  "1": 3,   // 一 (yī) = first/unity
  "2": 2,   // 二 (èr) = pairs (neutral)
  "3": 2,   // 三 (sān) = life (neutral)
  "5": 1,   // 五 (wǔ) = neutral
  "4": -5,  // 四 (sì) = sounds like death. Major penalty.
};

const TIER_CONFIG: Record<RarityTier, { label: string; emoji: string }> = {
  S: { label: "Legendary", emoji: "🔴" },
  A: { label: "Epic", emoji: "🟠" },
  B: { label: "Rare", emoji: "🟡" },
  C: { label: "Uncommon", emoji: "🟢" },
  D: { label: "Common", emoji: "⚪" },
};

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse a number string into clean digits after 888 prefix */
function parseNumber(input: string): { raw: string; afterPrefix: string; totalDigits: number } | null {
  // Accept: "+888 8 036", "8888036", "+888 0768 4929", "88807684929", etc.
  const cleaned = input.replace(/[+\s\-()]/g, "");
  if (!cleaned.startsWith("888")) return null;
  const afterPrefix = cleaned.slice(3);
  if (afterPrefix.length < 1) return null;
  if (!/^\d+$/.test(afterPrefix)) return null;
  return {
    raw: cleaned,
    afterPrefix,
    totalDigits: cleaned.length,
  };
}

/** Count consecutive repeating digits */
function maxConsecutiveRepeat(digits: string): { char: string; count: number } {
  let maxChar = "";
  let maxCount = 0;
  let currentChar = "";
  let currentCount = 0;

  for (const d of digits) {
    if (d === currentChar) {
      currentCount++;
    } else {
      if (currentCount > maxCount) {
        maxCount = currentCount;
        maxChar = currentChar;
      }
      currentChar = d;
      currentCount = 1;
    }
  }
  if (currentCount > maxCount) {
    maxCount = currentCount;
    maxChar = currentChar;
  }
  return { char: maxChar, count: maxCount };
}

/** Check for sequential digits (ascending or descending) */
function longestSequential(digits: string): number {
  let maxLen = 1;
  let ascLen = 1;
  let descLen = 1;

  for (let i = 1; i < digits.length; i++) {
    const curr = parseInt(digits[i]);
    const prev = parseInt(digits[i - 1]);
    if (curr === prev + 1) {
      ascLen++;
      descLen = 1;
    } else if (curr === prev - 1) {
      descLen++;
      ascLen = 1;
    } else {
      ascLen = 1;
      descLen = 1;
    }
    maxLen = Math.max(maxLen, ascLen, descLen);
  }
  return maxLen;
}

/** Check if digits form a palindrome */
function isPalindrome(digits: string): boolean {
  return digits === digits.split("").reverse().join("");
}

/** Check for repeating block patterns: ABAB, AABB, ABCABC */
function hasBlockPattern(digits: string): { type: string; score: number } | null {
  const len = digits.length;

  // ABABABAB (2-char repeat)
  if (len >= 4) {
    const block2 = digits.slice(0, 2);
    const repeat2 = block2.repeat(Math.ceil(len / 2)).slice(0, len);
    if (digits === repeat2) return { type: "AB-repeat", score: 80 };
  }

  // ABCABC (3-char repeat)
  if (len >= 6) {
    const block3 = digits.slice(0, 3);
    const repeat3 = block3.repeat(Math.ceil(len / 3)).slice(0, len);
    if (digits === repeat3) return { type: "ABC-repeat", score: 70 };
  }

  // ABCDABCD (4-char repeat)
  if (len >= 8) {
    const block4 = digits.slice(0, 4);
    const repeat4 = block4.repeat(Math.ceil(len / 4)).slice(0, len);
    if (digits === repeat4) return { type: "ABCD-repeat", score: 65 };
  }

  // AABB pattern
  if (len >= 4 && len % 2 === 0) {
    let isAABB = true;
    for (let i = 0; i < len; i += 2) {
      if (digits[i] !== digits[i + 1]) { isAABB = false; break; }
    }
    if (isAABB) return { type: "AABB", score: 60 };
  }

  // Half mirror: first half == second half
  if (len >= 4 && len % 2 === 0) {
    const half = len / 2;
    if (digits.slice(0, half) === digits.slice(half)) {
      return { type: "mirror-half", score: 55 };
    }
  }

  return null;
}

/** Check if all digits are the same */
function isAllSame(digits: string): boolean {
  return new Set(digits).size === 1;
}

/** Check for round number (ends with multiple 0s) */
function trailingZeros(digits: string): number {
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === "0") count++;
    else break;
  }
  return count;
}

// ─── Scoring Functions ───────────────────────────────────────────────

function scoreLengthComponent(totalDigits: number): number {
  // 7-digit numbers are ~0.7% of supply = inherently premium
  if (totalDigits === 7) return 100;
  if (totalDigits === 11) return 20;
  // Shouldn't happen, but handle gracefully
  return Math.max(0, 50 - (totalDigits - 7) * 5);
}

function scorePatternComponent(afterPrefix: string): { score: number; tags: string[] } {
  const tags: string[] = [];
  let score = 0;

  // All same digit (e.g., 8888 or 00000000)
  if (isAllSame(afterPrefix)) {
    score = 100;
    tags.push("all-same");
    if (afterPrefix[0] === "8") tags.push("all-eights");
    return { score, tags };
  }

  // Consecutive repeating
  const repeat = maxConsecutiveRepeat(afterPrefix);
  if (repeat.count >= afterPrefix.length - 1) {
    score = Math.max(score, 90);
    tags.push("near-perfect-repeat");
  } else if (repeat.count >= 6) {
    score = Math.max(score, 85);
    tags.push("strong-repeat-6+");
  } else if (repeat.count >= 5) {
    score = Math.max(score, 75);
    tags.push("repeat-5");
  } else if (repeat.count >= 4) {
    score = Math.max(score, 60);
    tags.push("repeat-4");
  } else if (repeat.count >= 3) {
    score = Math.max(score, 35);
    tags.push("repeat-3");
  }

  // Sequential
  const seqLen = longestSequential(afterPrefix);
  if (seqLen >= afterPrefix.length) {
    score = Math.max(score, 90);
    tags.push("full-sequential");
  } else if (seqLen >= 6) {
    score = Math.max(score, 70);
    tags.push("sequential-6+");
  } else if (seqLen >= 4) {
    score = Math.max(score, 45);
    tags.push("sequential-4");
  }

  // Palindrome
  if (isPalindrome(afterPrefix)) {
    score = Math.max(score, 65);
    tags.push("palindrome");
  }

  // Block patterns
  const block = hasBlockPattern(afterPrefix);
  if (block) {
    score = Math.max(score, block.score);
    tags.push(block.type);
  }

  // Round numbers (trailing zeros)
  const zeros = trailingZeros(afterPrefix);
  if (zeros >= 5) {
    score = Math.max(score, 55);
    tags.push("round-5+");
  } else if (zeros >= 3) {
    score = Math.max(score, 35);
    tags.push("round-3+");
  }

  return { score, tags };
}

function scoreLuckyComponent(afterPrefix: string): number {
  let total = 0;
  const counts: Record<string, number> = {};

  for (const d of afterPrefix) {
    total += LUCKY_DIGITS[d] ?? 0;
    counts[d] = (counts[d] || 0) + 1;
  }

  // Normalize: max possible = all 8s = 10 * length
  const maxPossible = 10 * afterPrefix.length;
  const minPossible = -5 * afterPrefix.length;
  const range = maxPossible - minPossible;

  // Shift to 0-100 scale
  const normalized = Math.round(((total - minPossible) / range) * 100);

  // Bonus: heavy concentration of 8s
  const eightRatio = (counts["8"] || 0) / afterPrefix.length;
  const bonus = Math.round(eightRatio * 20);

  // Penalty: any 4s
  const fourCount = counts["4"] || 0;
  const penalty = fourCount * 8;

  return Math.max(0, Math.min(100, normalized + bonus - penalty));
}

function scoreUniquenessComponent(afterPrefix: string): number {
  const uniqueDigits = new Set(afterPrefix).size;
  const len = afterPrefix.length;

  // Fewer unique digits = more memorable = rarer
  // 1 unique digit (all same) = 100
  // 2 unique = 80
  // 3 unique = 55
  // 4 unique = 35
  // 5+ = diminishing
  if (uniqueDigits === 1) return 100;
  if (uniqueDigits === 2) return 80;
  if (uniqueDigits === 3) return 55;
  if (uniqueDigits === 4) return 35;
  if (uniqueDigits === 5) return 20;
  if (uniqueDigits === 6) return 10;
  return 5;
}

// ─── Main Rarity Calculator ─────────────────────────────────────────

export function calculateRarity(input: string): RarityResult | null {
  const parsed = parseNumber(input);
  if (!parsed) return null;

  const { raw, afterPrefix, totalDigits } = parsed;
  const isShort = totalDigits === 7;

  // Score components
  const lengthScore = scoreLengthComponent(totalDigits);
  const { score: patternScore, tags: patternTags } = scorePatternComponent(afterPrefix);
  const luckyScore = scoreLuckyComponent(afterPrefix);
  const uniquenessScore = scoreUniquenessComponent(afterPrefix);

  // Weighted total
  // For short numbers: pattern matters most (length already gives huge base)
  // For standard numbers: pattern is the primary differentiator
  const weights = isShort
    ? { length: 0.30, pattern: 0.35, lucky: 0.20, uniqueness: 0.15 }
    : { length: 0.15, pattern: 0.40, lucky: 0.25, uniqueness: 0.20 };

  let totalScore = Math.round(
    lengthScore * weights.length +
    patternScore * weights.pattern +
    luckyScore * weights.lucky +
    uniquenessScore * weights.uniqueness
  );

  // Special case: +888 8 888 is THE rarest number
  if (raw === "8888888" || (afterPrefix === "8888" && isShort)) {
    totalScore = 100;
  }

  // Clamp
  totalScore = Math.max(0, Math.min(100, totalScore));

  // Determine tier
  let tier: RarityTier;
  if (isShort) {
    // Short numbers are minimum B tier
    if (totalScore >= 85) tier = "S";
    else if (totalScore >= 70) tier = "A";
    else tier = "B"; // even random short numbers are B tier
  } else {
    // Standard 11-digit
    if (totalScore >= 80) tier = "S";
    else if (totalScore >= 60) tier = "A";
    else if (totalScore >= 40) tier = "B";
    else if (totalScore >= 25) tier = "C";
    else tier = "D";
  }

  // Build tags
  const tags: string[] = [];
  if (isShort) tags.push("short");
  else tags.push("standard");
  tags.push(...patternTags);

  // Check specific digit properties
  const eightCount = afterPrefix.split("").filter((d) => d === "8").length;
  if (eightCount >= afterPrefix.length * 0.5 && !tags.includes("all-eights")) {
    tags.push("eight-heavy");
  }
  if (afterPrefix.includes("4")) tags.push("has-four");

  // Estimated floor price range (based on real March 2026 Fragment data)
  const estimatedFloor = estimatePrice(tier, isShort, totalScore, patternScore, afterPrefix);

  // Format the number
  const formatted = isShort
    ? `+888 ${afterPrefix.slice(0, 1)} ${afterPrefix.slice(1)}`
    : `+888 ${afterPrefix.slice(0, 4)} ${afterPrefix.slice(4)}`;

  return {
    number: formatted,
    rawDigits: afterPrefix,
    totalDigits,
    tier,
    score: totalScore,
    label: TIER_CONFIG[tier].label,
    tags,
    breakdown: {
      lengthScore,
      patternScore,
      luckyScore,
      uniquenessScore,
    },
    estimatedFloor,
  };
}

// ─── Price Estimation ────────────────────────────────────────────────

function estimatePrice(
  tier: RarityTier,
  isShort: boolean,
  score: number,
  patternScore: number,
  afterPrefix: string
): { min: number; max: number } {
  if (isShort) {
    // Short number pricing (based on real sold data):
    // +888 8 888 = 300,000 TON
    // +888 8 777 = 651,358 TON (recent sale, market was higher)
    // +888 8 000 = 130,000 TON
    // +888 8 333 = 60,777 TON
    // Random shorts: 31,000-60,000 TON
    if (isAllSame(afterPrefix)) return { min: 200_000, max: 500_000 };
    if (patternScore >= 80) return { min: 80_000, max: 300_000 };
    if (patternScore >= 50) return { min: 40_000, max: 120_000 };
    return { min: 25_000, max: 70_000 };
  }

  // Standard 11-digit pricing:
  switch (tier) {
    case "S": // full repeating, all-same, strong sequential
      if (isAllSame(afterPrefix)) return { min: 35_000, max: 80_000 };
      return { min: 15_000, max: 55_000 };
    case "A": // 0000 series, double blocks, partial strong patterns
      if (isAllSame(afterPrefix.slice(0, 4)) || isAllSame(afterPrefix.slice(4))) return { min: 20_000, max: 55_000 };
      return { min: 5_000, max: 30_000 };
    case "B": // notable patterns, 4+ repeats, some structure
      return { min: 2_000, max: 6_000 };
    case "C": // mild patterns, 3 repeats, some lucky digits
      return { min: 1_800, max: 2_500 };
    case "D": // floor — no patterns
    default:
      return { min: 1_774, max: 1_900 };
  }
}

// ─── Formatting ──────────────────────────────────────────────────────

export function formatRarityReport(result: RarityResult): string {
  const tierInfo = TIER_CONFIG[result.tier];
  const priceRange = result.estimatedFloor;

  const lines = [
    `${tierInfo.emoji} *${result.number}*`,
    ``,
    `🏆 Tier: *${result.tier} — ${tierInfo.label}*`,
    `📊 Rarity Score: ${result.score}/100`,
    ``,
    `*Breakdown:*`,
    `  📏 Length: ${result.breakdown.lengthScore}/100${result.totalDigits === 7 ? " (SHORT — premium)" : ""}`,
    `  🎯 Pattern: ${result.breakdown.patternScore}/100`,
    `  🍀 Lucky Digits: ${result.breakdown.luckyScore}/100`,
    `  ✨ Uniqueness: ${result.breakdown.uniquenessScore}/100`,
    ``,
    `🏷️ Tags: ${result.tags.join(", ") || "—"}`,
    `💰 Est. Range: ${priceRange.min.toLocaleString()}-${priceRange.max.toLocaleString()} TON`,
  ];

  return lines.join("\n");
}

// ─── Batch Analysis ──────────────────────────────────────────────────

export function compareNumbers(inputs: string[]): RarityResult[] {
  const results: RarityResult[] = [];
  for (const input of inputs) {
    const result = calculateRarity(input);
    if (result) results.push(result);
  }
  return results.sort((a, b) => b.score - a.score);
}

// ─── Exports ─────────────────────────────────────────────────────────

export { parseNumber, TIER_CONFIG, LUCKY_DIGITS };
