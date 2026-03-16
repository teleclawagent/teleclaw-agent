import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface CreatePollParams {
  chatId: string;
  question: string;
  options: string[];
  isAnonymous?: boolean;
  allowsMultipleAnswers?: boolean;
  replyToId?: number;
}

export const telegramCreatePollTool: Tool = {
  name: "telegram_create_poll",
  description: "Create a poll in a Telegram chat.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    question: Type.String({ description: "Poll question (max 300 characters)", maxLength: 300 }),
    options: Type.Array(Type.String(), {
      description: "Poll options (2-10)",
      minItems: 2,
      maxItems: 10,
    }),
    isAnonymous: Type.Optional(Type.Boolean({ description: "Anonymous voting (default: true)" })),
    allowsMultipleAnswers: Type.Optional(
      Type.Boolean({ description: "Allow multiple answers (default: false)" })
    ),
    replyToId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
  }),
};

export const telegramCreatePollExecutor: ToolExecutor<CreatePollParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.sendPoll(params.chatId, params.question, params.options, {
      isAnonymous: params.isAnonymous,
      allowsMultiple: params.allowsMultipleAnswers,
      replyToId: params.replyToId,
    });
    return {
      success: true,
      data: { messageId: result.id, question: params.question, optionCount: params.options.length },
    };
  } catch (error) {
    log.error({ err: error }, "Error creating poll");
    return { success: false, error: getErrorMessage(error) };
  }
};
