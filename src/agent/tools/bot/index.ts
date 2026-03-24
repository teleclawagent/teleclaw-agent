/**
 * Bot tools — inline mode integration + model switching.
 */

import type { ToolEntry } from "../types.js";
import { botInlineSendTool, botInlineSendExecutor } from "./inline-send.js";
import { botSwitchModelTool, botSwitchModelExecutor } from "./model-switch.js";

export const tools: ToolEntry[] = [
  {
    tool: botInlineSendTool,
    executor: botInlineSendExecutor,
    scope: "userbot-only",
  },
  {
    tool: botSwitchModelTool,
    executor: botSwitchModelExecutor,
    scope: "always",
  },
];
