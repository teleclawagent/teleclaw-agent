/**
 * Bot tools — model switching.
 */

import type { ToolEntry } from "../types.js";
import { botSwitchModelTool, botSwitchModelExecutor } from "./model-switch.js";

export const tools: ToolEntry[] = [
  {
    tool: botSwitchModelTool,
    executor: botSwitchModelExecutor,
    scope: "always",
  },
];
