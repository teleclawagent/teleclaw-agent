import { telegramSendPhotoTool, telegramSendPhotoExecutor } from "./send-photo.js";
import { telegramSendVoiceTool, telegramSendVoiceExecutor } from "./send-voice.js";
import { telegramSendStickerTool, telegramSendStickerExecutor } from "./send-sticker.js";
import { telegramSendGifTool, telegramSendGifExecutor } from "./send-gif.js";
import { visionAnalyzeTool, visionAnalyzeExecutor } from "./vision-analyze.js";
import type { ToolEntry } from "../../types.js";

export { telegramSendPhotoTool, telegramSendPhotoExecutor };
export { telegramSendVoiceTool, telegramSendVoiceExecutor };
export { telegramSendStickerTool, telegramSendStickerExecutor };
export { telegramSendGifTool, telegramSendGifExecutor };
export { visionAnalyzeTool, visionAnalyzeExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramSendPhotoTool, executor: telegramSendPhotoExecutor },
  { tool: telegramSendVoiceTool, executor: telegramSendVoiceExecutor },
  { tool: telegramSendStickerTool, executor: telegramSendStickerExecutor },
  { tool: telegramSendGifTool, executor: telegramSendGifExecutor },
  { tool: visionAnalyzeTool, executor: visionAnalyzeExecutor },
];
