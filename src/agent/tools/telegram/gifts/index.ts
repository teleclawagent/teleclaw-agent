import {
  telegramGetAvailableGiftsTool,
  telegramGetAvailableGiftsExecutor,
} from "./get-available-gifts.js";
import { telegramGetMyGiftsTool, telegramGetMyGiftsExecutor } from "./get-my-gifts.js";
import { telegramGetResaleGiftsTool, telegramGetResaleGiftsExecutor } from "./get-resale-gifts.js";
import {
  telegramGetCollectibleInfoTool,
  telegramGetCollectibleInfoExecutor,
} from "./get-collectible-info.js";
import type { ToolEntry } from "../../types.js";

export { telegramGetAvailableGiftsTool, telegramGetAvailableGiftsExecutor };
export { telegramGetMyGiftsTool, telegramGetMyGiftsExecutor };
export { telegramGetResaleGiftsTool, telegramGetResaleGiftsExecutor };
export { telegramGetCollectibleInfoTool, telegramGetCollectibleInfoExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramGetAvailableGiftsTool, executor: telegramGetAvailableGiftsExecutor },
  { tool: telegramGetMyGiftsTool, executor: telegramGetMyGiftsExecutor },
  { tool: telegramGetResaleGiftsTool, executor: telegramGetResaleGiftsExecutor },
  { tool: telegramGetCollectibleInfoTool, executor: telegramGetCollectibleInfoExecutor },
];
