import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

const log = createLogger("Tools");

interface SendVoiceParams {
  chatId: string;
  voice: string;
  caption?: string;
  replyToId?: number;
}

export const telegramSendVoiceTool: Tool = {
  name: "telegram_send_voice",
  description:
    "Send a voice message (OGG/OPUS) to a Telegram chat. Provide a file path or URL. Use for TTS output, voice notes, or audio clips.",
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    voice: Type.String({ description: "Voice file path or URL" }),
    caption: Type.Optional(Type.String({ description: "Optional caption" })),
    replyToId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
  }),
};

export const telegramSendVoiceExecutor: ToolExecutor<SendVoiceParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    let voiceInput: string | Buffer = params.voice;

    // If it's a local file, read it into a buffer
    if (existsSync(params.voice)) {
      voiceInput = await readFile(params.voice);
    }

    const result = await context.bridge.sendVoice(params.chatId, voiceInput, {
      caption: params.caption,
      replyToId: params.replyToId,
    });
    return { success: true, data: { messageId: result.id } };
  } catch (error) {
    log.error({ err: error }, "Error sending voice");
    return { success: false, error: getErrorMessage(error) };
  }
};
