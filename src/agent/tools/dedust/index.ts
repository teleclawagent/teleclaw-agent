import { dedustQuoteTool, dedustQuoteExecutor } from "./quote.js";
import { dedustSwapTool, dedustSwapExecutor } from "./swap.js";
import { dedustPoolsTool, dedustPoolsExecutor } from "./pools.js";
import { dedustPricesTool, dedustPricesExecutor } from "./prices.js";
import { dedustTokenInfoTool, dedustTokenInfoExecutor } from "./token-info.js";
import type { ToolEntry } from "../types.js";

export { dedustQuoteTool, dedustQuoteExecutor };
export { dedustSwapTool, dedustSwapExecutor };
export { dedustPoolsTool, dedustPoolsExecutor };
export { dedustPricesTool, dedustPricesExecutor };
export { dedustTokenInfoTool, dedustTokenInfoExecutor };

export const tools: ToolEntry[] = [
  { tool: dedustSwapTool, executor: dedustSwapExecutor, scope: "dm-only" },
  { tool: dedustQuoteTool, executor: dedustQuoteExecutor },
  { tool: dedustPoolsTool, executor: dedustPoolsExecutor },
  { tool: dedustPricesTool, executor: dedustPricesExecutor },
  { tool: dedustTokenInfoTool, executor: dedustTokenInfoExecutor },
];
