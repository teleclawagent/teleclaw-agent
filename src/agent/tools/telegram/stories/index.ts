import { telegramSendStoryTool, telegramSendStoryExecutor } from "./send-story.js";
import type { ToolEntry } from "../../types.js";

export { telegramSendStoryTool, telegramSendStoryExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramSendStoryTool, executor: telegramSendStoryExecutor, scope: "dm-only" },
];
