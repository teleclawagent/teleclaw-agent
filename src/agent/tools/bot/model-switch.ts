/**
 * Tool: bot_switch_model — Allows the agent to switch its own model/provider at runtime.
 * Only the admin/owner can trigger this via natural language (e.g. "switch to GPT-5.4").
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolContext, ToolResult, ToolExecutor } from "../types.js";
import {
  getUserSettings,
  setUserProvider,
  setUserModel,
  clearUserSettings,
} from "../../../session/user-settings.js";
import { getModelsForProvider } from "../../../config/model-catalog.js";
import { getProviderMetadata, type SupportedProvider } from "../../../config/providers.js";
import { getDatabase } from "../../../memory/database.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("BotModelSwitch");

export const botSwitchModelTool: Tool = {
  name: "bot_switch_model",
  description:
    "Switch the active AI model or provider. Use when the user asks to change model, switch to GPT/Claude/etc. " +
    "Can also list available models for a provider. Actions: switch, list, current, reset.",
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("switch"),
        Type.Literal("list"),
        Type.Literal("current"),
        Type.Literal("reset"),
      ],
      { description: "Action to perform" }
    ),
    provider: Type.Optional(
      Type.String({
        description:
          "Provider name (e.g. anthropic, openai, openai-codex, google, xai, groq). Required for switch if changing provider.",
      })
    ),
    model: Type.Optional(
      Type.String({
        description: "Model ID to switch to (e.g. claude-opus-4-6, gpt-5.4). Required for switch.",
      })
    ),
  }),
  category: "action",
};

export const botSwitchModelExecutor: ToolExecutor = async (
  params: unknown,
  context: ToolContext
): Promise<ToolResult> => {
  const p = params as Record<string, unknown>;
  const action = p.action as string;
  const senderId = context.senderId;

  if (!senderId) {
    return { success: false, error: "Cannot determine user identity" };
  }

  const db = getDatabase().getDb();

  if (action === "current") {
    const settings = getUserSettings(db, senderId);
    const globalConfig = context.config?.agent;
    const provider = settings?.provider || globalConfig?.provider || "anthropic";
    const model = settings?.model || globalConfig?.model || "unknown";
    const isCustom = !!settings?.provider || !!settings?.model;

    return {
      success: true,
      data: {
        provider,
        model,
        isCustom,
        message: `Current: ${provider}/${model}${isCustom ? " (custom)" : " (bot default)"}`,
      },
    };
  }

  if (action === "list") {
    const providerArg = (p.provider as string) || "anthropic";
    const providerKey = providerArg === "claude-code" ? "anthropic" : providerArg;
    const models = getModelsForProvider(providerKey);
    let meta: { displayName: string };
    try {
      meta = getProviderMetadata(providerArg as SupportedProvider);
    } catch {
      meta = { displayName: providerArg };
    }

    if (models.length === 0) {
      return {
        success: true,
        data: {
          provider: providerArg,
          models: [],
          message: `No models found for ${meta.displayName}`,
        },
      };
    }

    return {
      success: true,
      data: {
        provider: providerArg,
        displayName: meta.displayName,
        models: models.map((m) => ({ id: m.value, name: m.name, description: m.description })),
      },
    };
  }

  if (action === "reset") {
    clearUserSettings(db, senderId);
    return { success: true, data: { message: "Reset to bot defaults." } };
  }

  if (action === "switch") {
    const model = p.model as string;
    const provider = p.provider as string | undefined;

    if (!model) {
      return { success: false, error: "Model ID is required for switching." };
    }

    if (provider) {
      const settings = getUserSettings(db, senderId);
      const apiKey = settings?.apiKey || "";
      setUserProvider(db, senderId, provider, apiKey, model);
      log.info({ senderId, provider, model }, "Agent switched model via tool");

      let meta: { displayName: string };
      try {
        meta = getProviderMetadata(provider as SupportedProvider);
      } catch {
        meta = { displayName: provider };
      }

      return {
        success: true,
        data: { provider, model, message: `Switched to ${meta.displayName} / ${model}` },
      };
    }

    setUserModel(db, senderId, model);
    log.info({ senderId, model }, "Agent switched model via tool");

    return {
      success: true,
      data: { model, message: `Switched to ${model}` },
    };
  }

  return { success: false, error: `Unknown action: ${action}` };
};
