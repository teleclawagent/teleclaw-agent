import { dealProposeTool, dealProposeExecutor } from "./propose.js";
import { dealVerifyPaymentTool, dealVerifyPaymentExecutor } from "./verify-payment.js";
import { dealStatusTool, dealStatusExecutor } from "./status.js";
import { dealListTool, dealListExecutor } from "./list.js";
import { dealCancelTool, dealCancelExecutor } from "./cancel.js";
import type { ToolEntry } from "../types.js";

export * from "./propose.js";
export * from "./verify-payment.js";
export * from "./status.js";
export * from "./list.js";
export * from "./cancel.js";

export const tools: ToolEntry[] = [
  { tool: dealProposeTool, executor: dealProposeExecutor, scope: "dm-only" },
  { tool: dealVerifyPaymentTool, executor: dealVerifyPaymentExecutor, scope: "dm-only" },
  { tool: dealStatusTool, executor: dealStatusExecutor },
  { tool: dealListTool, executor: dealListExecutor },
  { tool: dealCancelTool, executor: dealCancelExecutor, scope: "dm-only" },
];
