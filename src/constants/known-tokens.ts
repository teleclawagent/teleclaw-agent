/**
 * Well-known TON token addresses.
 * Single source of truth — import this everywhere instead of hardcoding addresses.
 *
 * When a user says "USDT", "swap to USDT", "USDT balance" etc., resolve to these addresses.
 * All keys are lowercase for case-insensitive matching.
 */

export const NATIVE_TON = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

/**
 * Canonical token ticker → jetton master address mapping.
 * Includes common aliases (e.g. "tether" → USDT).
 */
export const KNOWN_TOKENS: Record<string, string> = {
  // ── Stablecoins ──
  usdt: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", // Tether USD on TON (official)
  "usdt₮": "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", // Unicode symbol variant
  tether: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
  jusdt: "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA", // jUSDT (old bridge)
  usdc: "EQB-MPwrd1G6WKNkLz_VnV6WqBDd_-UAfoRBUiHFOZ-YEgOn", // USDC on TON

  // ── Native TON ──
  ton: NATIVE_TON,
  toncoin: NATIVE_TON,

  // ── Major Telegram tokens ──
  dogs: "EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS",
  not: "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT",
  notcoin: "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT",
  cati: "EQD-cvR0Nz6XAyRBvbhz-abTrRC6sI5tvHvvpeQraV9LABELS",
  hmstr: "EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo",
  hamster: "EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo",
  major: "EQCuPm0XlMFkNNn_ZPVBsEgaqcNjq-OLFv_jMjmFXyGCRKtZ",
  durev: "EQBf6-YoR9v5JFO7pSPpBXYJPkEVlkQNS3JGfqVVlfSKNm5E",

  // ── DeFi tokens ──
  ston: "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO", // STON.fi
  storm: "EQDiAS3mf_ZbYOHN3UbNjYgqYJzZRxPcLfPC6_4wBOTgYUPA", // Storm Trade
};

/**
 * Resolve a user-provided token name to a jetton address.
 * Returns the address as-is if it looks like a TON address (starts with EQ/UQ/0:).
 */
export function resolveTokenAddress(input: string): string {
  const trimmed = input.trim();

  // Already an address
  if (
    trimmed.startsWith("EQ") ||
    trimmed.startsWith("UQ") ||
    trimmed.startsWith("0:") ||
    trimmed.length === 48
  ) {
    return trimmed;
  }

  // Lookup by ticker/alias
  const key = trimmed.toLowerCase();
  return KNOWN_TOKENS[key] || trimmed;
}
