import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

// ── Pin ──

interface PinMessageParams {
  chatId: string;
  messageId: number;
  silent?: boolean;
}

export const telegramPinMessageTool: Tool = {
  name: "telegram_pin_message",
  description: "Pin a message in a chat. Requires admin privileges in groups.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    messageId: Type.Number({ description: "Message ID to pin" }),
    silent: Type.Optional(
      Type.Boolean({ description: "Pin without notification (default: false)" })
    ),
  }),
};

export const telegramPinMessageExecutor: ToolExecutor<PinMessageParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    await context.bridge.pinMessage(params.chatId, params.messageId, params.silent);
    return { success: true, data: { pinned: true, messageId: params.messageId } };
  } catch (error) {
    log.error({ err: error }, "Error pinning message");
    return { success: false, error: getErrorMessage(error) };
  }
};

// ── Unpin ──

interface UnpinMessageParams {
  chatId: string;
  messageId: number;
}

export const telegramUnpinMessageTool: Tool = {
  name: "telegram_unpin_message",
  description: "Unpin a message in a chat. Requires admin privileges in groups.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    messageId: Type.Number({ description: "Message ID to unpin" }),
  }),
};

export const telegramUnpinMessageExecutor: ToolExecutor<UnpinMessageParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    await context.bridge.unpinMessage(params.chatId, params.messageId);
    return { success: true, data: { unpinned: true, messageId: params.messageId } };
  } catch (error) {
    log.error({ err: error }, "Error unpinning message");
    return { success: false, error: getErrorMessage(error) };
  }
};
