/**
 * src/telegram/provider-wizard.ts
 *
 * Multi-provider management with inline button wizards:
 * - /addprovider — add a new AI provider (API key + model selection)
 * - /models — switch between providers/models
 * - /removeprovider — clear custom AI settings
 */

import type { TelegramTransport, CallbackQueryEvent, InlineButton } from "./transport.js";
import type Database from "better-sqlite3";
import {
  getUserSettings,
  setUserProvider,
  setUserModel,
  clearUserSettings,
} from "../session/user-settings.js";
import {
  validateApiKeyFormat,
  getProviderMetadata,
  type SupportedProvider,
} from "../config/providers.js";
import { getModelsForProvider } from "../config/model-catalog.js";

// ── Types ────────────────────────────────────────────────────────────────

interface WizardState {
  step: "select_provider" | "enter_key" | "enter_sub_token" | "select_model";
  provider?: string;
  subType?: "chatgpt" | "claude";
  chatId: string;
  messageId?: number;
  createdAt: number;
}

// Providers shown in the wizard (excludes deprecated/hidden/no-key ones)
const WIZARD_PROVIDERS: SupportedProvider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "groq",
  "openrouter",
  "moonshot",
  "mistral",
  "cerebras",
  "zai",
  "minimax",
  "huggingface",
  "deepseek",
  "together",
  "venice",
  "qwen",
];

const WIZARD_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ── ProviderWizard ───────────────────────────────────────────────────────

export class ProviderWizard {
  private bridge: TelegramTransport;
  private db: Database.Database;

  /** Map<userId, WizardState> for /addprovider flow */
  private wizardStates = new Map<number, WizardState>();

  constructor(bridge: TelegramTransport, db: Database.Database) {
    this.bridge = bridge;
    this.db = db;
  }

  // ── /addprovider ──────────────────────────────────────────────────────

  async handleAddProvider(chatId: string, senderId: number, replyToId?: number): Promise<void> {
    // Show provider selection with subscription options at top
    const subRow: InlineButton[] = [
      { text: "⭐ ChatGPT Sub", callback_data: "pw:sub:chatgpt" },
      { text: "⭐ Claude Sub", callback_data: "pw:sub:claude" },
    ];
    const providerRows = this.buildProviderKeyboard("pw:");
    const rows = [subRow, ...providerRows];

    const msg = await this.bridge.sendMessage({
      chatId,
      text:
        "🔌 **Add AI Provider**\n\n" +
        "⭐ **Got a subscription?** Use your ChatGPT Plus/Pro or Claude Pro/Max plan directly — no extra API charges!\n\n" +
        "Or select an API key provider below:",
      inlineKeyboard: rows,
      replyToId,
    });

    this.wizardStates.set(senderId, {
      step: "select_provider",
      chatId,
      messageId: msg.id,
      createdAt: Date.now(),
    });
  }

  // ── /models ───────────────────────────────────────────────────────────

  async handleModels(chatId: string, senderId: number, replyToId?: number): Promise<void> {
    const settings = getUserSettings(this.db, senderId);
    const currentProvider = settings?.provider || "default";
    const currentModel = settings?.model || "default";

    let header = "🧠 **Model Switcher**\n\n";
    header += `Current: **${currentProvider}** / **${currentModel}**\n\n`;

    if (!settings?.provider && !settings?.apiKey) {
      header += "⚠️ No custom provider set. Using bot defaults.\n";
      header += "Use /addprovider first to add your own API key.\n\n";
    }

    header += "Select a provider to see available models:";

    const rows = this.buildProviderKeyboard("ms:");

    await this.bridge.sendMessage({
      chatId,
      text: header,
      inlineKeyboard: rows,
      replyToId,
    });
  }

  // ── /removeprovider ───────────────────────────────────────────────────

  async handleRemoveProvider(chatId: string, senderId: number, replyToId?: number): Promise<void> {
    const settings = getUserSettings(this.db, senderId);

    if (!settings) {
      await this.bridge.sendMessage({
        chatId,
        text: "ℹ️ No custom provider settings to remove. You're using bot defaults.",
        replyToId,
      });
      return;
    }

    let text = "⚙️ **Your Custom Settings**\n\n";
    text += `Provider: **${settings.provider || "not set"}**\n`;
    text += `Model: **${settings.model || "not set"}**\n`;
    text += `API Key: **${"•".repeat(8)}${settings.apiKey?.slice(-4) || "none"}**\n\n`;
    text += "Remove all custom settings?";

    const keyboard: InlineButton[][] = [
      [
        { text: "🗑 Remove", callback_data: "rp:confirm" },
        { text: "❌ Cancel", callback_data: "rp:cancel" },
      ],
    ];

    await this.bridge.sendMessage({
      chatId,
      text,
      inlineKeyboard: keyboard,
      replyToId,
    });
  }

  // ── Callback Query Router ─────────────────────────────────────────────

  async handleCallback(event: CallbackQueryEvent): Promise<boolean> {
    const { data, userId, queryId, chatId, messageId } = event;

    // pw: = provider wizard (addprovider)
    if (data.startsWith("pw:")) {
      await this.handleAddProviderCallback(data.slice(3), userId, chatId, messageId, queryId);
      return true;
    }

    // ms: = model switch
    if (data.startsWith("ms:")) {
      await this.handleModelSwitchCallback(data.slice(3), userId, chatId, messageId, queryId);
      return true;
    }

    // rp: = remove provider
    if (data.startsWith("rp:")) {
      await this.handleRemoveProviderCallback(data.slice(3), userId, chatId, messageId, queryId);
      return true;
    }

    return false;
  }

  // ── Text Message Handler (for API key input) ─────────────────────────

  async handleTextMessage(chatId: string, senderId: number, text: string): Promise<boolean> {
    const state = this.wizardStates.get(senderId);
    if (!state || state.chatId !== chatId) {
      return false;
    }
    if (state.step !== "enter_key" && state.step !== "enter_sub_token") {
      return false;
    }

    // Handle subscription token input
    if (state.step === "enter_sub_token") {
      return this.handleSubscriptionToken(chatId, senderId, text.trim(), state);
    }

    // Check expiry
    if (Date.now() - state.createdAt > WIZARD_EXPIRY_MS) {
      this.wizardStates.delete(senderId);
      return false;
    }

    const provider = state.provider as SupportedProvider;
    const apiKey = text.trim();

    // Validate key format
    const validationError = validateApiKeyFormat(provider, apiKey);
    if (validationError) {
      await this.bridge.sendMessage({
        chatId,
        text: `❌ ${validationError}\n\nTry again or send /cancel to abort.`,
      });
      return true;
    }

    // Save the provider + key
    const meta = getProviderMetadata(provider);
    setUserProvider(this.db, senderId, provider, apiKey);

    // Now show model selection
    state.step = "select_model";
    state.createdAt = Date.now();

    const models = getModelsForProvider(provider);
    if (models.length === 0) {
      // No model catalog — just use default
      setUserModel(this.db, senderId, meta.defaultModel);
      this.wizardStates.delete(senderId);

      await this.bridge.sendMessage({
        chatId,
        text:
          `✅ **${meta.displayName}** configured!\n\n` +
          `Model: **${meta.defaultModel}**\n\n` +
          `⚠️ Delete your message containing the API key for security.`,
      });
      return true;
    }

    const rows: InlineButton[][] = [];
    let currentRow: InlineButton[] = [];

    for (const model of models) {
      if (currentRow.length >= 2) {
        rows.push(currentRow);
        currentRow = [];
      }
      // Truncate callback data to fit 64 byte limit
      const cbData = `pw:m:${model.value.slice(0, 50)}`;
      currentRow.push({ text: `${model.name}`, callback_data: cbData });
    }
    if (currentRow.length > 0) rows.push(currentRow);

    await this.bridge.sendMessage({
      chatId,
      text:
        `✅ API key saved for **${meta.displayName}**!\n\n` +
        `⚠️ Delete your message containing the API key.\n\n` +
        `Now select a model:`,
      inlineKeyboard: rows,
    });

    return true;
  }

  // ── Private: Callback Handlers ────────────────────────────────────────

  private async handleAddProviderCallback(
    data: string,
    userId: number,
    chatId: string,
    messageId: number,
    queryId: string
  ): Promise<void> {
    // Model selection from wizard: pw:m:<model>
    if (data.startsWith("m:")) {
      const modelId = data.slice(2);
      const state = this.wizardStates.get(userId);

      if (!state || state.step !== "select_model") {
        await this.bridge.answerCallbackQuery(queryId, {
          message: "Session expired. Use /addprovider again.",
          alert: true,
        });
        return;
      }

      setUserModel(this.db, userId, modelId);
      this.wizardStates.delete(userId);

      const provider = state.provider || "unknown";
      const meta = getProviderMetadata(provider as SupportedProvider);

      await this.bridge.editMessage({
        chatId,
        messageId,
        text:
          `✅ **${meta.displayName}** configured!\n\n` +
          `Model: **${modelId}**\n\n` +
          `You can switch models anytime with /models`,
      });
      await this.bridge.answerCallbackQuery(queryId, { message: "✅ Provider configured!" });
      return;
    }

    // Subscription flows: pw:sub:chatgpt or pw:sub:claude
    if (data.startsWith("sub:")) {
      const subType = data.slice(4) as "chatgpt" | "claude";

      this.wizardStates.set(userId, {
        step: "enter_sub_token",
        subType,
        chatId,
        messageId,
        createdAt: Date.now(),
      });

      if (subType === "chatgpt") {
        await this.bridge.editMessage({
          chatId,
          messageId,
          text:
            "⭐ **ChatGPT Subscription Setup**\n\n" +
            "Uses your ChatGPT Plus/Pro plan — no extra API charges!\n\n" +
            "**Steps:**\n" +
            "1. Install Codex CLI:\n`npm install -g @openai/codex`\n\n" +
            "2. Login:\n`codex login`\n" +
            "(browser opens → sign in with your OpenAI account)\n\n" +
            "3. After login, paste the token shown in terminal here.\n" +
            "Or if you see no token, just send `auto` and I'll try to detect it.\n\n" +
            "Send /cancel to abort.",
        });
      } else {
        await this.bridge.editMessage({
          chatId,
          messageId,
          text:
            "⭐ **Claude Subscription Setup**\n\n" +
            "Uses your Claude Pro/Max plan — no extra API charges!\n\n" +
            "**Steps:**\n" +
            "1. Install Claude Code:\n`npm install -g @anthropic-ai/claude-code`\n\n" +
            "2. Login:\n`claude login`\n" +
            "(type /login → browser opens → sign in)\n" +
            "(wait for 'Successfully logged in')\n" +
            "(type /exit to close)\n\n" +
            "3. Get your token:\n`claude setup-token`\n\n" +
            "4. Copy the token (starts with `sk-ant-oat01-...`) and paste it here.\n\n" +
            "Send /cancel to abort.",
        });
      }
      await this.bridge.answerCallbackQuery(queryId, {
        message: `${subType === "chatgpt" ? "ChatGPT" : "Claude"} setup`,
      });
      return;
    }

    // Provider selection: pw:<provider_id>
    const provider = data as SupportedProvider;
    const meta = getProviderMetadata(provider);

    this.wizardStates.set(userId, {
      step: "enter_key",
      provider,
      chatId,
      messageId,
      createdAt: Date.now(),
    });

    // Providers that don't need API keys
    const noKeyProviders = ["cocoon", "local", "copilot", "chutes", "cloudflare-ai", "litellm"];
    if (noKeyProviders.includes(provider)) {
      setUserProvider(this.db, userId, provider, "");
      setUserModel(this.db, userId, meta.defaultModel);
      this.wizardStates.delete(userId);

      await this.bridge.editMessage({
        chatId,
        messageId,
        text:
          `✅ **${meta.displayName}** configured!\n\n` +
          `Model: **${meta.defaultModel}**\n` +
          `No API key needed.\n\n` +
          `Switch models with /models`,
      });
      await this.bridge.answerCallbackQuery(queryId, { message: "✅ Configured!" });
      return;
    }

    let keyInstructions = `🔑 **${meta.displayName}**\n\n`;
    keyInstructions += `Send your API key now.\n`;
    keyInstructions += `Format: \`${meta.keyHint}\`\n`;
    if (meta.consoleUrl) {
      keyInstructions += `Get one: ${meta.consoleUrl}\n`;
    }
    keyInstructions += `\nSend /cancel to abort.`;

    await this.bridge.editMessage({
      chatId,
      messageId,
      text: keyInstructions,
    });
    await this.bridge.answerCallbackQuery(queryId, { message: `Selected ${meta.displayName}` });
  }

  private async handleModelSwitchCallback(
    data: string,
    userId: number,
    chatId: string,
    messageId: number,
    queryId: string
  ): Promise<void> {
    // ms:p:<provider> — show models for provider
    if (data.startsWith("p:")) {
      const provider = data.slice(2) as SupportedProvider;
      const models = getModelsForProvider(provider);
      const meta = getProviderMetadata(provider);

      if (models.length === 0) {
        await this.bridge.answerCallbackQuery(queryId, {
          message: `No models available for ${meta.displayName}`,
          alert: true,
        });
        return;
      }

      const settings = getUserSettings(this.db, userId);
      const currentModel = settings?.model || "";

      const rows: InlineButton[][] = [];
      let currentRow: InlineButton[] = [];

      for (const model of models) {
        if (currentRow.length >= 2) {
          rows.push(currentRow);
          currentRow = [];
        }
        const marker = model.value === currentModel ? "✅ " : "";
        const cbData = `ms:s:${provider}:${model.value.slice(0, 40)}`;
        currentRow.push({
          text: `${marker}${model.name}`,
          callback_data: cbData,
        });
      }
      if (currentRow.length > 0) rows.push(currentRow);

      // Back button
      rows.push([{ text: "⬅️ Back", callback_data: "ms:back" }]);

      await this.bridge.editMessage({
        chatId,
        messageId,
        text: `🧠 **${meta.displayName}** Models:\n\nTap to switch:`,
        inlineKeyboard: rows,
      });
      await this.bridge.answerCallbackQuery(queryId, {});
      return;
    }

    // ms:s:<provider>:<model> — switch to this model
    if (data.startsWith("s:")) {
      const rest = data.slice(2);
      const colonIdx = rest.indexOf(":");
      if (colonIdx === -1) {
        await this.bridge.answerCallbackQuery(queryId, {
          message: "Invalid selection",
          alert: true,
        });
        return;
      }
      const provider = rest.slice(0, colonIdx) as SupportedProvider;
      const modelId = rest.slice(colonIdx + 1);

      const settings = getUserSettings(this.db, userId);

      // Check if user has API key for this provider
      const currentProvider = settings?.provider;
      if (currentProvider !== provider && !settings?.apiKey) {
        await this.bridge.answerCallbackQuery(queryId, {
          message: `⚠️ You need to set up ${provider} first. Use /addprovider`,
          alert: true,
        });
        return;
      }

      // If switching providers but user has a key, update provider too
      if (currentProvider !== provider && settings?.apiKey) {
        // Keep existing key — user might be switching between providers
        // They'll need to /addprovider for a different provider's key
        await this.bridge.answerCallbackQuery(queryId, {
          message: `⚠️ Your API key is for ${currentProvider}. Use /addprovider for ${provider}.`,
          alert: true,
        });
        return;
      }

      setUserModel(this.db, userId, modelId);

      const meta = getProviderMetadata(provider);
      await this.bridge.editMessage({
        chatId,
        messageId,
        text: `✅ Switched to **${meta.displayName}** / **${modelId}**`,
      });
      await this.bridge.answerCallbackQuery(queryId, { message: `✅ Switched to ${modelId}` });
      return;
    }

    // ms:back — back to provider list
    if (data === "back") {
      const settings = getUserSettings(this.db, userId);
      const currentProvider = settings?.provider || "default";
      const currentModel = settings?.model || "default";

      const rows = this.buildProviderKeyboard("ms:");

      await this.bridge.editMessage({
        chatId,
        messageId,
        text:
          `🧠 **Model Switcher**\n\n` +
          `Current: **${currentProvider}** / **${currentModel}**\n\n` +
          `Select a provider:`,
        inlineKeyboard: rows,
      });
      await this.bridge.answerCallbackQuery(queryId, {});
      return;
    }

    // ms:<provider> — shortcut to show models
    await this.handleModelSwitchCallback(`p:${data}`, userId, chatId, messageId, queryId);
  }

  private async handleRemoveProviderCallback(
    data: string,
    userId: number,
    chatId: string,
    messageId: number,
    queryId: string
  ): Promise<void> {
    if (data === "confirm") {
      clearUserSettings(this.db, userId);
      await this.bridge.editMessage({
        chatId,
        messageId,
        text: "✅ Custom settings removed. Using bot defaults now.",
      });
      await this.bridge.answerCallbackQuery(queryId, { message: "✅ Settings cleared" });
      return;
    }

    if (data === "cancel") {
      await this.bridge.editMessage({
        chatId,
        messageId,
        text: "❌ Cancelled. Your settings are unchanged.",
      });
      await this.bridge.answerCallbackQuery(queryId, { message: "Cancelled" });
      return;
    }
  }

  // ── Private: Subscription Token Handler ────────────────────────────────

  private async handleSubscriptionToken(
    chatId: string,
    senderId: number,
    token: string,
    state: WizardState
  ): Promise<boolean> {
    // Check expiry
    if (Date.now() - state.createdAt > WIZARD_EXPIRY_MS) {
      this.wizardStates.delete(senderId);
      return false;
    }

    if (state.subType === "chatgpt") {
      if (token.toLowerCase() === "auto") {
        // Try auto-detect from Codex CLI
        try {
          const { isCodexOAuthConfigured } = await import("../providers/openai-codex-oauth.js");
          if (isCodexOAuthConfigured()) {
            setUserProvider(this.db, senderId, "openai-codex", "");
            setUserModel(this.db, senderId, "gpt-5.4");
            this.wizardStates.delete(senderId);

            await this.bridge.sendMessage({
              chatId,
              text:
                "✅ **ChatGPT Subscription** connected!\n\n" +
                "Auto-detected from Codex CLI.\n" +
                "Model: **gpt-5.4**\n\n" +
                "Switch models with /models",
            });
            return true;
          }
        } catch {
          // Not installed
        }
        await this.bridge.sendMessage({
          chatId,
          text: "❌ Codex CLI not found or not logged in.\n\nInstall it first: `npm install -g @openai/codex`\nThen: `codex login`\n\nOr paste your API key directly.",
        });
        return true;
      }

      // Accept token or API key
      if (token.startsWith("sk-")) {
        setUserProvider(this.db, senderId, "openai", token);
        setUserModel(this.db, senderId, "gpt-5.4");
        this.wizardStates.delete(senderId);

        await this.bridge.sendMessage({
          chatId,
          text:
            "✅ **OpenAI** configured!\n\n" +
            "Model: **gpt-5.4**\n\n" +
            "⚠️ Delete your message containing the key.\n" +
            "Switch models with /models",
        });
        return true;
      }

      await this.bridge.sendMessage({
        chatId,
        text: "❌ Invalid token. Send `auto` to auto-detect, or paste an API key starting with `sk-`.\n\nSend /cancel to abort.",
      });
      return true;
    }

    if (state.subType === "claude") {
      if (token.startsWith("sk-ant-")) {
        setUserProvider(this.db, senderId, "claude-code", token);
        setUserModel(this.db, senderId, "claude-opus-4-6");
        this.wizardStates.delete(senderId);

        await this.bridge.sendMessage({
          chatId,
          text:
            "✅ **Claude Subscription** connected!\n\n" +
            "Model: **claude-opus-4-6**\n\n" +
            "⚠️ Delete your message containing the token.\n" +
            "Switch models with /models",
        });
        return true;
      }

      await this.bridge.sendMessage({
        chatId,
        text: "❌ Invalid token. It should start with `sk-ant-oat01-...`\n\nRun `claude setup-token` and paste the full token.\n\nSend /cancel to abort.",
      });
      return true;
    }

    return false;
  }

  // ── Private: Helpers ──────────────────────────────────────────────────

  private buildProviderKeyboard(prefix: string): InlineButton[][] {
    const rows: InlineButton[][] = [];
    let currentRow: InlineButton[] = [];

    for (const providerId of WIZARD_PROVIDERS) {
      if (currentRow.length >= 3) {
        rows.push(currentRow);
        currentRow = [];
      }

      const meta = getProviderMetadata(providerId);
      // Short display name for buttons
      const shortName = meta.displayName.split("(")[0].trim().split(" ")[0];
      const cbData = prefix === "ms:" ? `ms:p:${providerId}` : `${prefix}${providerId}`;

      currentRow.push({
        text: shortName,
        callback_data: cbData,
      });
    }
    if (currentRow.length > 0) rows.push(currentRow);

    return rows;
  }

  /** Clean up expired wizard states */
  cleanup(): void {
    const now = Date.now();
    for (const [userId, state] of this.wizardStates) {
      if (now - state.createdAt > WIZARD_EXPIRY_MS) {
        this.wizardStates.delete(userId);
      }
    }
  }

  /** Check if user is in a wizard flow (to intercept text messages) */
  isInWizard(userId: number): boolean {
    const state = this.wizardStates.get(userId);
    if (!state) return false;
    if (Date.now() - state.createdAt > WIZARD_EXPIRY_MS) {
      this.wizardStates.delete(userId);
      return false;
    }
    return state.step === "enter_key" || state.step === "enter_sub_token";
  }

  /** Handle /cancel during wizard */
  cancelWizard(userId: number): boolean {
    if (this.wizardStates.has(userId)) {
      this.wizardStates.delete(userId);
      return true;
    }
    return false;
  }
}
