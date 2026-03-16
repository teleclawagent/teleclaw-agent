import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../../../../constants/limits.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface QuoteReplyParams {
  chatId: string;
  replyToId: number;
  text: string;
}

export const telegramQuoteReplyTool: Tool = {
  name: "telegram_quote_reply",
  description: "Reply to a specific message with a quote. The reply will show the original message.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    replyToId: Type.Number({ description: "Message ID to reply to" }),
    text: Type.String({
      description: "Reply text",
      maxLength: TELEGRAM_MAX_MESSAGE_LENGTH,
    }),
  }),
};

export const telegramQuoteReplyExecutor: ToolExecutor<QuoteReplyParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.sendMessage({
      chatId: params.chatId,
      text: params.text,
      replyToId: params.replyToId,
    });
    return {
      success: true,
      data: { messageId: result.id, repliedTo: params.replyToId },
    };
  } catch (error) {
    log.error({ err: error }, "Error sending quote reply");
    return { success: false, error: getErrorMessage(error) };
  }
};
