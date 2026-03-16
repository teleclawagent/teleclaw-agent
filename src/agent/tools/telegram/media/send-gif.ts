import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface SendGifParams {
  chatId: string;
  gif: string;
  caption?: string;
  replyToId?: number;
}

export const telegramSendGifTool: Tool = {
  name: "telegram_send_gif",
  description: "Send a GIF animation to a Telegram chat. Provide a URL or file path.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    gif: Type.String({ description: "GIF URL or file path" }),
    caption: Type.Optional(Type.String({ description: "Optional caption" })),
    replyToId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
  }),
};

export const telegramSendGifExecutor: ToolExecutor<SendGifParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.sendAnimation(params.chatId, params.gif, {
      caption: params.caption,
      replyToId: params.replyToId,
    });
    return { success: true, data: { messageId: result.id } };
  } catch (error) {
    log.error({ err: error }, "Error sending GIF");
    return { success: false, error: getErrorMessage(error) };
  }
};
