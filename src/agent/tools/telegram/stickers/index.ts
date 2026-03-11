import { telegramSearchStickersTool, telegramSearchStickersExecutor } from "./search-stickers.js";
import { telegramSearchGifsTool, telegramSearchGifsExecutor } from "./search-gifs.js";
import { telegramGetMyStickersTool, telegramGetMyStickersExecutor } from "./get-my-stickers.js";
import { telegramAddStickerSetTool, telegramAddStickerSetExecutor } from "./add-sticker-set.js";
import type { ToolEntry } from "../../types.js";

export { telegramSearchStickersTool, telegramSearchStickersExecutor };
export { telegramSearchGifsTool, telegramSearchGifsExecutor };
export { telegramGetMyStickersTool, telegramGetMyStickersExecutor };
export { telegramAddStickerSetTool, telegramAddStickerSetExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramSearchStickersTool, executor: telegramSearchStickersExecutor },
  { tool: telegramSearchGifsTool, executor: telegramSearchGifsExecutor },
  { tool: telegramGetMyStickersTool, executor: telegramGetMyStickersExecutor },
  { tool: telegramAddStickerSetTool, executor: telegramAddStickerSetExecutor },
];
