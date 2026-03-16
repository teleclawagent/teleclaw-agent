import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface ForwardMessageParams {
  fromChatId: string;
  toChatId: string;
  messageId: number;
}

export const telegramForwardMessageTool: Tool = {
  name: "telegram_forward_message",
  description: "Forward a message from one chat to another.",
  parameters: Type.Object({
    fromChatId: Type.String({ description: "Source chat ID" }),
    toChatId: Type.String({ description: "Destination chat ID" }),
    messageId: Type.Number({ description: "Message ID to forward" }),
  }),
};

export const telegramForwardMessageExecutor: ToolExecutor<ForwardMessageParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.forwardMessage(
      params.fromChatId,
      params.toChatId,
      params.messageId
    );
    return {
      success: true,
      data: { forwardedMessageId: result.id, from: params.fromChatId, to: params.toChatId },
    };
  } catch (error) {
    log.error({ err: error }, "Error forwarding message");
    return { success: false, error: getErrorMessage(error) };
  }
};
