import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface DeleteMessageParams {
  chatId: string;
  messageIds: number[];
  revoke?: boolean;
}

export const telegramDeleteMessageTool: Tool = {
  name: "telegram_delete_message",
  description:
    "Delete one or more messages from a chat. Can delete your own messages and (in groups where you're admin) other people's messages.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    messageIds: Type.Array(Type.Number(), {
      description: "Array of message IDs to delete",
      minItems: 1,
      maxItems: 100,
    }),
    revoke: Type.Optional(
      Type.Boolean({
        description: "Delete for everyone (default: true)",
        default: true,
      })
    ),
  }),
};

export const telegramDeleteMessageExecutor: ToolExecutor<DeleteMessageParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    await context.bridge.deleteMessages(params.chatId, params.messageIds);
    return {
      success: true,
      data: { deleted: params.messageIds.length, messageIds: params.messageIds },
    };
  } catch (error) {
    log.error({ err: error }, "Error deleting messages");
    return { success: false, error: getErrorMessage(error) };
  }
};
