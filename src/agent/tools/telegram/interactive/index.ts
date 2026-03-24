import { telegramCreatePollTool, telegramCreatePollExecutor } from "./create-poll.js";
import { telegramReactTool, telegramReactExecutor } from "./react.js";
import { telegramSendDiceTool, telegramSendDiceExecutor } from "./send-dice.js";
import type { ToolEntry } from "../../types.js";

export { telegramCreatePollTool, telegramCreatePollExecutor };
export { telegramReactTool, telegramReactExecutor };
export { telegramSendDiceTool, telegramSendDiceExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramCreatePollTool, executor: telegramCreatePollExecutor },
  { tool: telegramReactTool, executor: telegramReactExecutor },
  { tool: telegramSendDiceTool, executor: telegramSendDiceExecutor },
];
