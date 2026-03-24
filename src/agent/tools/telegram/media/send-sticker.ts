import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface SendStickerParams {
  chatId: string;
  sticker: string;
  replyToId?: number;
}

export const telegramSendStickerTool: Tool = {
  name: "telegram_send_sticker",
  description: "Send a sticker to a Telegram chat. Provide a sticker file_id, URL, or file path.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    sticker: Type.String({ description: "Sticker file_id, URL, or file path" }),
    replyToId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
  }),
};

export const telegramSendStickerExecutor: ToolExecutor<SendStickerParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.sendSticker(params.chatId, params.sticker, {
      replyToId: params.replyToId,
    });
    return { success: true, data: { messageId: result.id } };
  } catch (error) {
    log.error({ err: error }, "Error sending sticker");
    return { success: false, error: getErrorMessage(error) };
  }
};
