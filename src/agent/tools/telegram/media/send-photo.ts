import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface SendPhotoParams {
  chatId: string;
  photo: string;
  caption?: string;
  replyToId?: number;
}

export const telegramSendPhotoTool: Tool = {
  name: "telegram_send_photo",
  description: "Send a photo to a Telegram chat. Provide a URL or file path.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    photo: Type.String({ description: "Photo URL or file path" }),
    caption: Type.Optional(Type.String({ description: "Optional caption" })),
    replyToId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
  }),
};

export const telegramSendPhotoExecutor: ToolExecutor<SendPhotoParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.sendPhoto(params.chatId, params.photo, {
      caption: params.caption,
      replyToId: params.replyToId,
    });
    return { success: true, data: { messageId: result.id } };
  } catch (error) {
    log.error({ err: error }, "Error sending photo");
    return { success: false, error: getErrorMessage(error) };
  }
};
