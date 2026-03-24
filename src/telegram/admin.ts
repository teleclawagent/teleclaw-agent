import type { TelegramConfig, Config } from "../config/schema.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { TelegramTransport } from "./transport.js";
import { getWalletAddress, getWalletBalance } from "../ton/wallet-service.js";
import { Address } from "@ton/core";

import { loadTemplate } from "../workspace/manager.js";
import { isVerbose, setVerbose, createLogger } from "../utils/logger.js";
import { resetSession } from "../session/store.js";
import { getDatabase } from "../memory/database.js";
import { saveConfig } from "../config/loader.js";
import { fetchWithTimeout } from "../utils/fetch.js";
import { execSync } from "child_process";

const log = createLogger("Telegram");
import type { ModulePermissions, ModuleLevel } from "../agent/tools/module-permissions.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import { writePluginSecret, deletePluginSecret, listPluginSecretKeys } from "../sdk/secrets.js";
// User settings imported dynamically in index.ts handleUserSettingsCommand

export interface AdminCommand {
  command: string;
  args: string[];
  chatId: string;
  senderId: number;
}

const VALID_DM_POLICIES = ["open", "allowlist", "admin-only", "disabled"] as const;
const VALID_GROUP_POLICIES = ["open", "allowlist", "admin-only", "disabled"] as const;
const VALID_MODULE_LEVELS = ["open", "admin", "disabled"] as const;

export class AdminHandler {
  private bridge: TelegramTransport;
  private config: TelegramConfig;
  private fullConfig: Config | null;
  private configPath: string | null;
  private agent: AgentRuntime;
  private paused = false;
  private permissions: ModulePermissions | null;
  private registry: ToolRegistry | null;

  constructor(
    bridge: TelegramTransport,
    config: TelegramConfig,
    agent: AgentRuntime,
    permissions?: ModulePermissions,
    registry?: ToolRegistry,
    fullConfig?: Config,
    configPath?: string
  ) {
    this.bridge = bridge;
    this.config = config;
    this.agent = agent;
    this.permissions = permissions ?? null;
    this.registry = registry ?? null;
    this.fullConfig = fullConfig ?? null;
    this.configPath = configPath ?? null;
  }

  isAdmin(userId: number): boolean {
    return this.config.admin_ids.includes(userId);
  }

  isPaused(): boolean {
    return this.paused;
  }

  parseCommand(message: string): AdminCommand | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith("/") && !trimmed.startsWith("!") && !trimmed.startsWith(".")) {
      return null;
    }

    const parts = trimmed.split(/\s+/);
    // Strip bot mention suffix (e.g. /mymodel@BotName → mymodel)
    const rawCommand = parts[0].slice(1).toLowerCase();
    const command = rawCommand.includes("@") ? rawCommand.split("@")[0] : rawCommand;
    const args = parts.slice(1);

    return {
      command,
      args,
      chatId: "",
      senderId: 0,
    };
  }

  /**
   * Handle /start — first user to send /start becomes admin automatically.
   * Also supports legacy /start <claim_code> for backward compatibility.
   * Returns response string if handled, null if not a start attempt.
   */
  async handleClaimAttempt(command: AdminCommand, senderId: number): Promise<string | null> {
    if (command.command !== "start") return null;

    // Already has admin(s) — check for legacy claim code
    if (this.config.admin_ids.length > 0) {
      if (command.args.length > 0) {
        const code = command.args[0].toUpperCase();
        const expectedCode = this.config.admin_claim_code;
        if (expectedCode && code === expectedCode.toUpperCase()) {
          // Legacy claim code matches — add as admin
          if (!this.config.admin_ids.includes(senderId)) {
            this.config.admin_ids.push(senderId);
          }
          (this.config as Record<string, unknown>).admin_claim_code = undefined;
          if (this.fullConfig && this.configPath) {
            if (!this.fullConfig.telegram.admin_ids.includes(senderId)) {
              this.fullConfig.telegram.admin_ids.push(senderId);
            }
            delete (this.fullConfig.telegram as Record<string, unknown>).admin_claim_code;
            try {
              saveConfig(this.fullConfig, this.configPath);
              log.info({ senderId }, "Admin claimed via legacy code and persisted");
            } catch (err) {
              log.error({ err }, "Failed to persist admin claim");
            }
          }
          return `✅ You are now an admin!\n\nWelcome to Teleclaw. Use /help to see available commands.`;
        }
      }
      return null;
    }

    // No admins yet — first /start sender becomes admin automatically
    this.config.admin_ids.push(senderId);
    (this.config as Record<string, unknown>).admin_claim_code = undefined;

    if (this.fullConfig && this.configPath) {
      this.fullConfig.telegram.admin_ids = [senderId];
      this.fullConfig.telegram.owner_id = senderId;
      delete (this.fullConfig.telegram as Record<string, unknown>).admin_claim_code;
      try {
        saveConfig(this.fullConfig, this.configPath);
        log.info({ senderId }, "First user auto-claimed as admin");
      } catch (err) {
        log.error({ err }, "Failed to persist admin claim");
      }
    }

    return `✅ You are now the admin!\n\nWelcome to Teleclaw. Send me a message to get started.`;
  }

  async handleCommand(
    command: AdminCommand,
    chatId: string,
    senderId: number,
    isGroup?: boolean
  ): Promise<string> {
    if (!this.isAdmin(senderId)) {
      // Check if this is a claim attempt
      const claimResult = await this.handleClaimAttempt({ ...command, chatId, senderId }, senderId);
      if (claimResult) return claimResult;

      return "⛔ Admin access required";
    }

    command.chatId = chatId;
    command.senderId = senderId;

    switch (command.command) {
      case "status":
        return await this.handleStatusCommand(command);
      case "clear":
        return await this.handleClearCommand(command);
      case "loop":
        return this.handleLoopCommand(command);
      case "model":
        return this.handleModelCommand(command);
      case "policy":
        return this.handlePolicyCommand(command);
      case "pause":
        return this.handlePauseCommand();
      case "resume":
        return this.handleResumeCommand();
      case "wallet":
        return await this.handleWalletCommand();
      case "strategy":
        return this.handleStrategyCommand(command);
      case "stop":
        return await this.handleStopCommand();
      case "verbose":
        return this.handleVerboseCommand();
      case "rag":
        return this.handleRagCommand(command);
      case "modules":
        return this.handleModulesCommand(command, isGroup ?? false);
      case "plugin":
        return this.handlePluginCommand(command);
      case "reset":
        return this.handleResetCommand(command);
      case "history":
        return await this.handleHistoryCommand(command);
      case "settings":
        return this.handleSettingsCommand(command);
      case "portfolio":
        return await this.handlePortfolioCommand();
      case "sniper":
        return this.handleSniperCommand();
      case "alerts":
        return this.handleAlertsCommand();
      case "update":
        return await this.handleUpdateCommand(command);
      case "version":
        return await this.handleVersionCommand();
      case "help":
        return this.handleHelpCommand();
      case "ping":
        return "🏓 Pong!";
      default:
        return `❓ Unknown command: /${command.command}\n\nUse /help for available commands.`;
    }
  }

  private async handleStatusCommand(command: AdminCommand): Promise<string> {
    const activeChatIds = this.agent.getActiveChatIds();
    const chatCount = activeChatIds.length;
    const cfg = this.agent.getConfig();

    // Show per-user effective config if available
    let effectiveProvider: string = cfg.agent.provider;
    let effectiveModel: string = cfg.agent.model;
    let isCustom = false;
    try {
      const { getUserSettings } = await import("../session/user-settings.js");
      const { getDatabase } = await import("../memory/database.js");
      const db = getDatabase().getDb();
      const settings = getUserSettings(db, command.senderId);
      if (settings) {
        if (settings.provider) {
          effectiveProvider = settings.provider;
          isCustom = true;
        }
        if (settings.model) {
          effectiveModel = settings.model;
          isCustom = true;
        }
      }
    } catch {
      /* fallback to global */
    }

    let status = "🤖 **Teleclaw Status**\n\n";
    status += `${this.paused ? "⏸️ **PAUSED**\n" : ""}`;
    status += `💬 Active conversations: ${chatCount}\n`;
    status += `🧠 Provider: ${effectiveProvider}${isCustom ? " (custom)" : ""}\n`;
    status += `🤖 Model: ${effectiveModel}${isCustom ? " (custom)" : ""}\n`;
    status += `🔄 Max iterations: ${cfg.agent.max_agentic_iterations}\n`;
    status += `📬 DM policy: ${this.config.dm_policy}\n`;
    status += `👥 Group policy: ${this.config.group_policy}\n`;

    if (this.config.require_mention) {
      status += `🔔 Mention required: Yes\n`;
    }

    if (isCustom) {
      status += `\n📌 _Default: ${cfg.agent.provider}/${cfg.agent.model}_`;
    }

    return status;
  }

  private async handleClearCommand(command: AdminCommand): Promise<string> {
    const targetChatId = command.args[0] || command.chatId;

    try {
      this.agent.clearHistory(targetChatId);
      return `✅ Cleared conversation history for chat: ${targetChatId}`;
    } catch (error) {
      return `❌ Error clearing history: ${error}`;
    }
  }

  private handleLoopCommand(command: AdminCommand): string {
    const n = parseInt(command.args[0], 10);
    if (isNaN(n) || n < 1 || n > 50) {
      const current = this.agent.getConfig().agent.max_agentic_iterations || 5;
      return `🔄 Current loop: **${current}** iterations\n\nUsage: /loop <1-50>`;
    }
    this.agent.getConfig().agent.max_agentic_iterations = n;
    return `🔄 Max iterations set to **${n}**`;
  }

  private handleModelCommand(command: AdminCommand): string {
    const cfg = this.agent.getConfig();
    const provider = cfg.agent.provider || "anthropic";

    if (command.args.length === 0) {
      return (
        `Current: ${provider}/${cfg.agent.model}\n` +
        `\n/model <model_name> to switch\n` +
        `/model status for details`
      );
    }

    if (command.args[0] === "status") {
      let response = `🧠 **Model:** \`${cfg.agent.model}\`\n📡 **Provider:** ${provider}\n`;
      try {
        const catalog = require("../../config/model-catalog.js") as {
          MODEL_OPTIONS: Record<
            string,
            Array<{ value: string; name: string; description: string }>
          >;
        };
        const key = provider === "claude-code" ? "anthropic" : provider;
        const provModels = catalog.MODEL_OPTIONS[key];
        if (provModels) {
          response += `\n**Available:**\n`;
          for (const m of provModels) {
            const marker = m.value === cfg.agent.model ? " ✅" : "";
            response += `• \`${m.value}\`${marker} — ${m.description}\n`;
          }
        }
      } catch {
        // catalog unavailable
      }
      return response;
    }

    const newModel = command.args[0];
    const oldModel = cfg.agent.model;
    cfg.agent.model = newModel;

    // Persist to config file
    try {
      const { readRawConfig, setNestedValue, writeRawConfig } =
        require("../../config/configurable-keys.js") as {
          readRawConfig: () => Record<string, unknown>;
          setNestedValue: (obj: Record<string, unknown>, path: string, value: unknown) => void;
          writeRawConfig: (config: Record<string, unknown>) => void;
        };
      const raw = readRawConfig();
      setNestedValue(raw, "agent.model", newModel);
      writeRawConfig(raw);
    } catch {
      // Config save failed — still works for this session
    }

    return `🧠 Model: \`${oldModel}\` → \`${newModel}\`\n_Saved. Active immediately._`;
  }

  private handlePolicyCommand(command: AdminCommand): string {
    if (command.args.length < 2) {
      return (
        `📬 DM policy: **${this.config.dm_policy}**\n` +
        `👥 Group policy: **${this.config.group_policy}**\n\n` +
        `Usage:\n/policy dm <${VALID_DM_POLICIES.join("|")}>\n/policy group <${VALID_GROUP_POLICIES.join("|")}>`
      );
    }

    const [target, value] = command.args;

    if (target === "dm") {
      if (!(VALID_DM_POLICIES as readonly string[]).includes(value)) {
        return `❌ Invalid DM policy. Valid: ${VALID_DM_POLICIES.join(", ")}`;
      }
      const old = this.config.dm_policy;
      this.config.dm_policy = value as typeof this.config.dm_policy;
      return `📬 DM policy: **${old}** → **${value}**`;
    }

    if (target === "group") {
      if (!(VALID_GROUP_POLICIES as readonly string[]).includes(value)) {
        return `❌ Invalid group policy. Valid: ${VALID_GROUP_POLICIES.join(", ")}`;
      }
      const old = this.config.group_policy;
      this.config.group_policy = value as typeof this.config.group_policy;
      return `👥 Group policy: **${old}** → **${value}**`;
    }

    return `❌ Unknown target: ${target}. Use "dm" or "group".`;
  }

  private handlePauseCommand(): string {
    if (this.paused) return "⏸️ Already paused.";
    this.paused = true;
    return "⏸️ Agent paused. Use /resume to restart.";
  }

  private handleResumeCommand(): string {
    if (!this.paused) return "▶️ Already running.";
    this.paused = false;
    return "▶️ Agent resumed.";
  }

  private handleStrategyCommand(_command: AdminCommand): string {
    return `📊 Strategy settings moved to STRATEGY.md workspace file. Edit it directly.`;
  }

  private async handleStopCommand(): Promise<string> {
    log.info("🛑 [Admin] /stop command received - shutting down");
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000);
    return "🛑 Shutting down...";
  }

  private async handleWalletCommand(): Promise<string> {
    const address = getWalletAddress();
    if (!address) return "❌ No wallet configured.";

    const result = await getWalletBalance(address);
    if (!result) return "❌ Failed to fetch balance.";

    const friendly = Address.parse(address).toString({ bounceable: false });
    return `💎 **${result.balance} TON**\n📍 \`${friendly}\``;
  }

  getBootstrapContent(): string | null {
    try {
      return loadTemplate("BOOTSTRAP.md");
    } catch {
      return null;
    }
  }

  private handleVerboseCommand(): string {
    const next = !isVerbose();
    setVerbose(next);
    return next ? "🔊 Verbose logging **ON**" : "🔇 Verbose logging **OFF**";
  }

  private handleRagCommand(command: AdminCommand): string {
    const cfg = this.agent.getConfig();
    const sub = command.args[0]?.toLowerCase();

    if (sub === "status") {
      const enabled = cfg.tool_rag.enabled;
      const topK = cfg.tool_rag.top_k;
      const toolIndex = this.registry?.getToolIndex();
      const indexed = toolIndex?.isIndexed ? "Yes" : "No";
      const totalTools = this.registry?.count ?? 0;
      return (
        `🔍 **Tool RAG Status**\n\n` +
        `Enabled: ${enabled ? "✅ ON" : "❌ OFF"}\n` +
        `Indexed: ${indexed}\n` +
        `Top-K: ${topK}\n` +
        `Total tools: ${totalTools}\n` +
        `Always include: ${cfg.tool_rag.always_include.length} patterns`
      );
    }

    if (sub === "topk") {
      const n = parseInt(command.args[1], 10);
      if (isNaN(n) || n < 5 || n > 200) {
        return `🔍 Current top_k: **${cfg.tool_rag.top_k}**\n\nUsage: /rag topk <5-200>`;
      }
      const old = cfg.tool_rag.top_k;
      cfg.tool_rag.top_k = n;
      return `🔍 Tool RAG top_k: **${old}** → **${n}**`;
    }

    // Toggle ON/OFF
    const next = !cfg.tool_rag.enabled;
    cfg.tool_rag.enabled = next;
    return next ? "🔍 Tool RAG **ON**" : "🔇 Tool RAG **OFF**";
  }

  private handleModulesCommand(command: AdminCommand, isGroup: boolean): string {
    if (!this.permissions || !this.registry) {
      return "❌ Module permissions not available";
    }

    if (!isGroup) {
      return "❌ /modules is only available in groups";
    }

    const chatId = command.chatId;
    const sub = command.args[0]?.toLowerCase();

    if (!sub) {
      return this.listModules(chatId);
    }

    switch (sub) {
      case "set":
        return this.setModuleLevel(chatId, command.args[1], command.args[2], command.senderId);
      case "info":
        return this.showModuleInfo(command.args[1], chatId);
      case "reset":
        return this.resetModules(chatId, command.args[1]);
      default:
        return `❌ Unknown subcommand: "${sub}"\n\nUsage: /modules | /modules set <module> <level> | /modules info <module> | /modules reset [module]`;
    }
  }

  private listModules(chatId: string): string {
    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    const modules = this.registry.getAvailableModules();
    const overrides = this.permissions.getOverrides(chatId);

    const lines: string[] = ["🧩 **Modules** (this group)\n"];

    for (const mod of modules) {
      const count = this.registry.getModuleToolCount(mod);
      const level = overrides.get(mod) ?? "open";
      const isProtected = this.permissions.isProtected(mod);

      let icon: string;
      switch (level) {
        case "open":
          icon = "✅";
          break;
        case "admin":
          icon = "🔐";
          break;
        case "disabled":
          icon = "❌";
          break;
      }

      const toolWord = count === 1 ? "tool" : "tools";
      const protectedMark = isProtected ? " 🔒" : "";
      lines.push(` ${icon} **${mod}**   ${count} ${toolWord}  ${level}${protectedMark}`);
    }

    lines.push("");
    lines.push("Levels: `open` | `admin` | `disabled`");
    lines.push("Usage: `/modules set <module> <level>`");

    return lines.join("\n");
  }

  private setModuleLevel(
    chatId: string,
    module: string | undefined,
    level: string | undefined,
    senderId: number
  ): string {
    if (!module || !level) {
      return "❌ Usage: /modules set <module> <level>";
    }

    module = module.toLowerCase();
    level = level.toLowerCase();

    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    const available = this.registry.getAvailableModules();
    if (!available.includes(module)) {
      return `❌ Unknown module: "${module}"`;
    }

    if (this.permissions.isProtected(module)) {
      return `⛔ Module "${module}" is protected`;
    }

    if (!(VALID_MODULE_LEVELS as readonly string[]).includes(level)) {
      return `❌ Invalid level: "${level}". Valid: ${VALID_MODULE_LEVELS.join(", ")}`;
    }

    const oldLevel = this.permissions.getLevel(chatId, module);
    this.permissions.setLevel(chatId, module, level as ModuleLevel, senderId);

    const icons: Record<string, string> = { open: "✅", admin: "🔐", disabled: "❌" };
    return `${icons[level]} **${module}**: ${oldLevel} → ${level}`;
  }

  private showModuleInfo(module: string | undefined, chatId: string): string {
    if (!module) {
      return "❌ Usage: /modules info <module>";
    }

    module = module.toLowerCase();

    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    const available = this.registry.getAvailableModules();
    if (!available.includes(module)) {
      return `❌ Unknown module: "${module}"`;
    }

    const tools = this.registry.getModuleTools(module);
    const count = tools.length;
    const toolWord = count === 1 ? "tool" : "tools";
    const level = this.permissions.getLevel(chatId, module);
    const isProtected = this.permissions.isProtected(module);
    const protectedMark = isProtected ? " 🔒" : "";

    const lines: string[] = [
      `📦 Module "**${module}**" — ${level}${protectedMark} (${count} ${toolWord})\n`,
    ];

    for (const t of tools) {
      lines.push(` ${t.name}   ${t.scope}`);
    }

    return lines.join("\n");
  }

  private resetModules(chatId: string, module: string | undefined): string {
    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    if (module) {
      module = module.toLowerCase();
      const available = this.registry.getAvailableModules();
      if (!available.includes(module)) {
        return `❌ Unknown module: "${module}"`;
      }
      if (this.permissions.isProtected(module)) {
        return `⛔ Module "${module}" is protected (already open)`;
      }
      this.permissions.resetModule(chatId, module);
      return `✅ **${module}** → open`;
    }

    this.permissions.resetAll(chatId);
    return "✅ All modules reset to **open**";
  }

  private handlePluginCommand(command: AdminCommand): string {
    const sub = command.args[0]?.toLowerCase();

    if (!sub) {
      return (
        "🔌 **Plugin Secrets**\n\n" +
        "**/plugin set** <name> <key> <value>\n" +
        "Set a secret for a plugin\n\n" +
        "**/plugin unset** <name> <key>\n" +
        "Remove a secret\n\n" +
        "**/plugin keys** <name>\n" +
        "List configured secret keys"
      );
    }

    switch (sub) {
      case "set": {
        const [, pluginName, key, ...valueParts] = command.args;
        if (!pluginName || !key || valueParts.length === 0) {
          return "❌ Usage: /plugin set <name> <key> <value>";
        }
        const value = valueParts.join(" ");
        writePluginSecret(pluginName, key, value);
        return `✅ Secret **${key}** saved for **${pluginName}**\n\n⚠️ Restart agent or reload plugin for changes to take effect.`;
      }

      case "unset": {
        const [, pluginName, key] = command.args;
        if (!pluginName || !key) {
          return "❌ Usage: /plugin unset <name> <key>";
        }
        const deleted = deletePluginSecret(pluginName, key);
        return deleted
          ? `✅ Secret **${key}** removed from **${pluginName}**`
          : `⚠️ Secret **${key}** not found for **${pluginName}**`;
      }

      case "keys": {
        const [, pluginName] = command.args;
        if (!pluginName) {
          return "❌ Usage: /plugin keys <name>";
        }
        const keys = listPluginSecretKeys(pluginName);
        if (keys.length === 0) {
          return `🔌 **${pluginName}** — no secrets configured`;
        }
        return `🔌 **${pluginName}** secrets:\n${keys.map((k) => `  • ${k}`).join("\n")}`;
      }

      default:
        return `❌ Unknown subcommand: "${sub}"\n\nUsage: /plugin set|unset|keys <name> ...`;
    }
  }

  private handleResetCommand(command: AdminCommand): string {
    try {
      resetSession(command.chatId);
      return "🔄 Session reset. Context cleared, memory preserved.";
    } catch (error) {
      return `❌ Error resetting session: ${error}`;
    }
  }

  private async handleHistoryCommand(command: AdminCommand): Promise<string> {
    try {
      const db = getDatabase().getDb();
      const rows = db
        .prepare(
          "SELECT sender_name, text, timestamp FROM tg_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 10"
        )
        .all(command.chatId) as Array<{
        sender_name: string;
        text: string;
        timestamp: number;
      }>;

      if (rows.length === 0) return "📭 No messages found for this chat.";

      const lines = rows.reverse().map((r) => {
        const date = new Date(r.timestamp);
        const time = date.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Istanbul",
        });
        const name = r.sender_name || "Unknown";
        const text =
          r.text && r.text.length > 80 ? r.text.slice(0, 80) + "…" : r.text || "(no text)";
        return `[${time}] **${name}**: ${text}`;
      });

      return `📜 **Last ${rows.length} messages**\n\n${lines.join("\n")}`;
    } catch (error) {
      return `❌ Error fetching history: ${error}`;
    }
  }

  private handleSettingsCommand(_command: AdminCommand): string {
    const cfg = this.agent.getConfig();
    const address = getWalletAddress();
    const truncatedAddr = address
      ? `${address.slice(0, 6)}…${address.slice(-4)}`
      : "Not configured";

    const ragEnabled = cfg.tool_rag.enabled;
    const ragTopK = cfg.tool_rag.top_k;

    return (
      `⚙️ **Current Settings**\n\n` +
      `🧠 **Model:** ${cfg.agent.model}\n` +
      `🏢 **Provider:** ${cfg.agent.provider}\n` +
      `🔄 **Max iterations:** ${cfg.agent.max_agentic_iterations}\n\n` +
      `📬 **DM policy:** ${this.config.dm_policy}\n` +
      `👥 **Group policy:** ${this.config.group_policy}\n` +
      `🔔 **Require mention:** ${this.config.require_mention ? "Yes" : "No"}\n\n` +
      `🔍 **Tool RAG:** ${ragEnabled ? "ON" : "OFF"} (top_k: ${ragTopK})\n\n` +
      `💎 **Wallet:** \`${truncatedAddr}\``
    );
  }

  private async handlePortfolioCommand(): Promise<string> {
    const address = getWalletAddress();
    if (!address) return "❌ No wallet configured.";

    const result = await getWalletBalance(address);
    if (!result) return "❌ Failed to fetch balance.";

    const friendly = Address.parse(address).toString({ bounceable: false });
    return (
      `📊 **Portfolio**\n\n` +
      `💎 **${result.balance} TON**\n` +
      `📍 \`${friendly}\`\n\n` +
      `💡 Ask naturally for full portfolio: _"Show my gift portfolio"_`
    );
  }

  private handleSniperCommand(): string {
    return (
      `🎯 **Sniper Commands**\n\n` +
      `Use natural language:\n` +
      `• _"Show my active snipers"_\n` +
      `• _"Snipe [gift] under [price] TON"_\n` +
      `• _"Cancel all snipers"_`
    );
  }

  private handleAlertsCommand(): string {
    return (
      `🔔 **Alert Commands**\n\n` +
      `Use natural language:\n` +
      `• _"Show my alerts"_\n` +
      `• _"Alert me when [gift] drops below [price] TON"_\n` +
      `• _"Cancel all alerts"_`
    );
  }

  private async handleVersionCommand(): Promise<string> {
    let currentVersion = "unknown";
    try {
      const { createRequire } = await import("module");
      const req = createRequire(import.meta.url);
      currentVersion = (req("../../package.json") as { version: string }).version;
    } catch {
      /* ignore */
    }

    let latestVersion = "unknown";
    try {
      const res = await fetchWithTimeout("https://registry.npmjs.org/teleclaw/latest", {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { version: string };
        latestVersion = data.version;
      }
    } catch {
      /* ignore */
    }

    const upToDate = currentVersion === latestVersion;
    return (
      `📦 **Teleclaw Version**\n\n` +
      `Current: **${currentVersion}**\n` +
      `Latest: **${latestVersion}**\n\n` +
      (upToDate ? "✅ You're up to date!" : "⬆️ Update available! Use /update to upgrade.")
    );
  }

  private async handleUpdateCommand(command: AdminCommand): Promise<string> {
    const force = command.args[0] === "force" || command.args[0] === "yes";

    // Check current vs latest
    let currentVersion = "unknown";
    try {
      const { createRequire } = await import("module");
      const req = createRequire(import.meta.url);
      currentVersion = (req("../../package.json") as { version: string }).version;
    } catch {
      /* ignore */
    }

    let latestVersion = "unknown";
    let changelog = "";
    try {
      const res = await fetchWithTimeout("https://registry.npmjs.org/teleclaw/latest", {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { version: string; description?: string };
        latestVersion = data.version;
        changelog = data.description || "";
      }
    } catch {
      /* ignore */
    }

    if (currentVersion === latestVersion && !force) {
      return `✅ Already on latest version (**${currentVersion}**). Use /update force to reinstall.`;
    }

    if (!force) {
      return (
        `⬆️ **Update Available**\n\n` +
        `Current: **${currentVersion}**\n` +
        `Latest: **${latestVersion}**\n` +
        (changelog ? `\n${changelog}\n` : "") +
        `\nSend **/update yes** to install and restart.`
      );
    }

    // Execute update
    try {
      await this.bridge.sendMessage({
        chatId: command.chatId,
        text: `⏳ Updating to **${latestVersion}**...`,
      });

      execSync("npm install -g teleclaw@latest", {
        timeout: 120_000,
        stdio: "pipe",
      });

      await this.bridge.sendMessage({
        chatId: command.chatId,
        text: `✅ Updated to **${latestVersion}**! Restarting...`,
      });

      // Restart after short delay
      setTimeout(() => {
        log.info("🔄 Restarting after update...");
        process.kill(process.pid, "SIGUSR2");
      }, 1000);

      return "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Update failed");
      return `❌ Update failed: ${msg}\n\nTry manually: \`npm install -g teleclaw@latest\``;
    }
  }

  private handleHelpCommand(): string {
    return `🤖 **Teleclaw Admin Commands**

📋 **Info**
/ping — Check if agent is alive
/status — Agent status & info
/help — Show this help message
/settings — View all current settings
/history — Last 10 messages in chat

🔌 **Multi-Provider**
/addprovider — Add a new AI provider
/models — Switch AI model (inline buttons)
/removeprovider — Remove custom AI settings

🧠 **Agent**
/model <name> — Switch LLM model
/loop <1-50> — Set max agentic iterations
/reset — Reset session context
/clear [chat_id] — Clear conversation history

📬 **Access**
/policy <dm|group> <value> — Change access policy
/modules [set|info|reset] — Per-group module permissions

💎 **Wallet & Trading**
/wallet — TON wallet balance
/portfolio — Portfolio summary
/strategy [buy|sell <percent>] — Trading thresholds
/sniper — Sniper commands
/alerts — Alert management

⬆️ **Updates**
/version — Check current & latest version
/update — Update to latest version

🔧 **System**
/rag [status|topk <n>] — Toggle Tool RAG
/verbose — Toggle debug logging
/plugin set|unset|keys <name> ... — Plugin secrets
/pause / /resume — Pause or resume agent
/stop — Emergency shutdown
/task <description> — Give agent a task
/boot — Run bootstrap setup`;
  }
}
