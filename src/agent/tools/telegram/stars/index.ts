import type { ToolEntry } from "../../types.js";

// All stars tools were userbot-only and have been removed
// Note: send-stars and send-stars-gift were already removed - they don't actually transfer Stars
// Telegram doesn't have an API to transfer Stars between users
// Stars can only be used to: tip creators, buy gifts, purchase digital goods
export const tools: ToolEntry[] = [];
