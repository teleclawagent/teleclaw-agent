// Note: send-stars and send-stars-gift removed - they don't actually transfer Stars
// Telegram doesn't have an API to transfer Stars between users
// Stars can only be used to: tip creators, buy gifts, purchase digital goods

import { telegramGetStarsBalanceTool, telegramGetStarsBalanceExecutor } from "./get-balance.js";
import {
  telegramGetStarsTransactionsTool,
  telegramGetStarsTransactionsExecutor,
} from "./get-transactions.js";
import type { ToolEntry } from "../../types.js";

export { telegramGetStarsBalanceTool, telegramGetStarsBalanceExecutor };
export { telegramGetStarsTransactionsTool, telegramGetStarsTransactionsExecutor };

export const tools: ToolEntry[] = [
  {
    tool: telegramGetStarsBalanceTool,
    executor: telegramGetStarsBalanceExecutor,
    scope: "dm-only",
  },
  {
    tool: telegramGetStarsTransactionsTool,
    executor: telegramGetStarsTransactionsExecutor,
    scope: "dm-only",
  },
];
