import type { Api } from "telegram";
import type { PluginMessageEvent, PluginCallbackEvent } from "@teleclaw-agent/sdk";
import { loadConfig, getDefaultConfigPath } from "./config/index.js";
import { ensureAndLoadEnv } from "./config/env.js";
import { loadSoul } from "./soul/index.js";
import { AgentRuntime } from "./agent/runtime.js";
import { TelegramBridge, type TelegramMessage } from "./telegram/bridge.js";
import { BotBridge } from "./telegram/bot-bridge.js";
import type { TelegramTransport, CallbackQueryEvent } from "./telegram/transport.js";
import { MessageHandler } from "./telegram/handlers.js";
import { AdminHandler } from "./telegram/admin.js";
import { MessageDebouncer } from "./telegram/debounce.js";
import { getDatabase, closeDatabase, initializeMemory, type MemorySystem } from "./memory/index.js";
import { getWalletAddress } from "./ton/wallet-service.js";
import { setTonapiKey } from "./constants/api-endpoints.js";
import { setToncenterApiKey } from "./ton/endpoint.js";
import { TELECLAW_ROOT } from "./workspace/paths.js";
import { TELEGRAM_CONNECTION_RETRIES, TELEGRAM_FLOOD_SLEEP_THRESHOLD } from "./constants/limits.js";
import { join } from "path";
import { ToolRegistry } from "./agent/tools/registry.js";
import { registerAllTools } from "./agent/tools/register-all.js";
import { loadEnhancedPlugins, type PluginModuleWithHooks } from "./agent/tools/plugin-loader.js";
import type { HookName, AgentStartEvent, AgentStopEvent } from "./sdk/hooks/types.js";
import { createHookRunner } from "./sdk/hooks/runner.js";
import type { SDKDependencies } from "./sdk/index.js";
import { getProviderMetadata, type SupportedProvider } from "./config/providers.js";
import { readRawConfig, setNestedValue, writeRawConfig } from "./config/configurable-keys.js";
import { loadModules } from "./agent/tools/module-loader.js";
import { ModulePermissions } from "./agent/tools/module-permissions.js";
import { SHUTDOWN_TIMEOUT_MS } from "./constants/timeouts.js";
import type { PluginModule, PluginContext } from "./agent/tools/types.js";
import { PluginWatcher } from "./agent/tools/plugin-watcher.js";
import {
  loadMcpServers,
  registerMcpTools,
  closeMcpServers,
  type McpConnection,
} from "./agent/tools/mcp-loader.js";
import { getErrorMessage } from "./utils/errors.js";
import { UserHookEvaluator } from "./agent/hooks/user-hook-evaluator.js";
import { createLogger, initLoggerFromConfig } from "./utils/logger.js";
import { AgentLifecycle } from "./agent/lifecycle.js";
import { InlineRouter } from "./bot/inline-router.js";
import { PluginRateLimiter } from "./bot/rate-limiter.js";
import { setBotPreMiddleware, getDealBot } from "./deals/module.js";
import type { TaskDependencyResolver } from "./telegram/task-dependency-resolver.js";
import type { WebUIServer } from "./webui/server.js";
import { checkStaleListings, expireOldListings } from "./agent/tools/fragment/stale-checker.js";
import {
  createMatchmakerClient,
  type MatchmakerAPIClient,
} from "./agent/tools/fragment/matchmaker-api.js";

const log = createLogger("App");

export class TeleclawApp {
  private config;
  private agent: AgentRuntime;
  private bridge: TelegramTransport;
  private messageHandler: MessageHandler;
  private adminHandler: AdminHandler;
  private debouncer: MessageDebouncer | null = null;
  private toolCount: number = 0;
  private toolRegistry: ToolRegistry;
  private dependencyResolver: TaskDependencyResolver | null = null;
  private modules: PluginModule[] = [];
  private memory: MemorySystem;
  private sdkDeps: SDKDependencies;
  private webuiServer: WebUIServer | null = null;
  private pluginWatcher: PluginWatcher | null = null;
  private mcpConnections: McpConnection[] = [];
  private callbackHandlerRegistered = false;
  private messageHandlersRegistered = false;
  private lifecycle = new AgentLifecycle();
  private hookRunner?: ReturnType<typeof createHookRunner>;
  private userHookEvaluator: UserHookEvaluator | null = null;
  private startTime: number = 0;
  private messagesProcessed: number = 0;
  private staleCheckerInterval: ReturnType<typeof setInterval> | null = null;
  private matchmakerApi: MatchmakerAPIClient | null = null;

  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? getDefaultConfigPath();
    this.config = loadConfig(this.configPath);

    // Auto-load ~/.teleclaw/.env (creates if missing, cross-platform)
    ensureAndLoadEnv();

    // Wire YAML logging config to pino (H2 fix)
    initLoggerFromConfig(this.config.logging);

    if (this.config.tonapi_key) {
      setTonapiKey(this.config.tonapi_key);
    }
    if (this.config.toncenter_api_key) {
      setToncenterApiKey(this.config.toncenter_api_key);
    }

    const soul = loadSoul();

    this.toolRegistry = new ToolRegistry();
    registerAllTools(this.toolRegistry);

    this.agent = new AgentRuntime(this.config, soul, this.toolRegistry);

    // Create transport based on mode: 'bot' (Bot API) or 'userbot' (GramJS MTProto)
    const telegramMode = this.config.telegram.mode || "bot";

    // Filter out userbot-only tools when in bot mode
    if (telegramMode === "bot") {
      this.toolRegistry.setBotMode(true);
    }
    const botToken = this.config.telegram.bot_token;

    if (telegramMode === "bot") {
      if (!botToken) {
        throw new Error("telegram.bot_token is required when telegram.mode = 'bot'");
      }
      this.bridge = new BotBridge({ token: botToken });
      log.info("🤖 Mode: Bot API (grammY)");
    } else {
      this.bridge = new TelegramBridge({
        apiId: this.config.telegram.api_id,
        apiHash: this.config.telegram.api_hash,
        phone: this.config.telegram.phone,
        sessionPath: join(TELECLAW_ROOT, "telegram_session.txt"),
        connectionRetries: TELEGRAM_CONNECTION_RETRIES,
        autoReconnect: true,
        floodSleepThreshold: TELEGRAM_FLOOD_SLEEP_THRESHOLD,
      });
      log.info("👤 Mode: Userbot (GramJS MTProto)");
    }

    const embeddingProvider = this.config.embedding.provider;
    this.memory = initializeMemory({
      database: {
        path: join(TELECLAW_ROOT, "memory.db"),
        enableVectorSearch: embeddingProvider !== "none",
        vectorDimensions: 384,
      },
      embeddings: {
        provider: embeddingProvider,
        model: this.config.embedding.model,
        apiKey: embeddingProvider === "anthropic" ? this.config.agent.api_key : undefined,
      },
      workspaceDir: join(TELECLAW_ROOT),
    });

    const db = getDatabase().getDb();

    this.userHookEvaluator = new UserHookEvaluator(db);
    this.agent.setUserHookEvaluator(this.userHookEvaluator);

    this.sdkDeps = { bridge: this.bridge };

    this.modules = loadModules(this.toolRegistry, this.config, db);

    const modulePermissions = new ModulePermissions(db);
    this.toolRegistry.setPermissions(modulePermissions);

    this.toolCount = this.toolRegistry.count;
    this.messageHandler = new MessageHandler(
      this.bridge,
      this.config.telegram,
      this.agent,
      db,
      this.memory.embedder,
      getDatabase().isVectorSearchReady(),
      this.config
    );

    this.adminHandler = new AdminHandler(
      this.bridge,
      this.config.telegram,
      this.agent,
      modulePermissions,
      this.toolRegistry,
      this.config,
      this.configPath
    );
  }

  /**
   * Get the lifecycle state machine for WebUI integration
   */
  getLifecycle(): AgentLifecycle {
    return this.lifecycle;
  }

  /** Check if the terminal supports Unicode (for emoji fallback on Windows) */
  private isUnicodeTerminal(): boolean {
    if (process.platform !== "win32") return true;
    if (process.env.WT_SESSION) return true; // Windows Terminal
    if (process.env.TERM_PROGRAM === "vscode") return true;
    const lang = (
      process.env.LANG ||
      process.env.LC_ALL ||
      process.env.LC_CTYPE ||
      ""
    ).toLowerCase();
    if (lang.includes("utf")) return true;
    return false;
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    // Startup banner (ASCII-safe for PowerShell compatibility)
    log.info(`
  === TELECLAW AGENT v1.0.0-beta.1 ===

   _____    _           _                     _                    _
  |_   _|__| | ___  ___| | __ ___      __    / \\   __ _  ___ _ __ | |_
    | |/ _ \\ |/ _ \\/ __| |/ _\` \\ \\ /\\ / /   / _ \\ / _\` |/ _ \\ '_ \\| __|
    | |  __/ |  __/ (__| | (_| |\\ V  V /   / ___ \\ (_| |  __/ | | | |_
    |_|\\___|_|\\___|\\___|_|\\__,_| \\_/\\_/   /_/   \\_\\__, |\\___|_| |_|\\__|
                                                  |___/
`);

    // Register lifecycle callbacks so WebUI routes can call start()/stop() without args
    this.lifecycle.registerCallbacks(
      () => this.startAgent(),
      () => this.stopAgent()
    );

    // Start WebUI server if enabled (before agent — survives agent stop/restart)
    if (this.config.webui.enabled) {
      try {
        const { WebUIServer } = await import("./webui/server.js");
        // Build MCP server info getter for WebUI (live status, not a snapshot)
        const mcpServers = () =>
          Object.entries(this.config.mcp.servers).map(([name, serverConfig]) => {
            const type = serverConfig.command
              ? ("stdio" as const)
              : serverConfig.url
                ? ("streamable-http" as const)
                : ("sse" as const);
            const target = serverConfig.command ?? serverConfig.url ?? "";
            const connected = this.mcpConnections.some((c) => c.serverName === name);
            const moduleName = `mcp_${name}`;
            const moduleTools = this.toolRegistry.getModuleTools(moduleName);
            return {
              name,
              type,
              target,
              scope: serverConfig.scope ?? "always",
              enabled: serverConfig.enabled ?? true,
              connected,
              toolCount: moduleTools.length,
              tools: moduleTools.map((t) => t.name),
              envKeys: Object.keys(serverConfig.env ?? {}),
            };
          });

        const builtinNames = this.modules.map((m) => m.name);
        const pluginContext: PluginContext = {
          bridge: this.bridge,
          db: getDatabase().getDb(),
          config: this.config,
        };

        this.webuiServer = new WebUIServer({
          agent: this.agent,
          bridge: this.bridge,
          memory: this.memory,
          toolRegistry: this.toolRegistry,
          plugins: this.modules
            .filter((m) => this.toolRegistry.isPluginModule(m.name))
            .map((m) => ({ name: m.name, version: m.version ?? "0.0.0" })),
          mcpServers,
          config: this.config.webui,
          configPath: this.configPath,
          lifecycle: this.lifecycle,
          marketplace: {
            modules: this.modules,
            config: this.config,
            sdkDeps: this.sdkDeps,
            pluginContext,
            loadedModuleNames: builtinNames,
            rewireHooks: () => this.wirePluginEventHooks(),
          },
          userHookEvaluator: this.userHookEvaluator,
        });
        await this.webuiServer.start();
      } catch (error) {
        log.error({ err: error }, "❌ Failed to start WebUI server");
        log.warn("⚠️ Continuing without WebUI...");
      }
    }

    // Start agent subsystems via lifecycle
    await this.lifecycle.start(() => this.startAgent());

    // Keep process alive
    await new Promise(() => {});
  }

  /**
   * Start agent subsystems (Telegram, plugins, MCP, modules, debouncer, handler).
   * Called by lifecycle.start() — do NOT call directly.
   */
  private async startAgent(): Promise<void> {
    // Load modules
    const moduleNames = this.modules
      .filter((m) => m.tools(this.config).length > 0)
      .map((m) => m.name);

    // Load enhanced plugins from ~/.teleclaw/plugins/
    const builtinNames = this.modules.map((m) => m.name);
    const { modules: externalModules, hookRegistry } = await loadEnhancedPlugins(
      this.config,
      builtinNames,
      this.sdkDeps,
      getDatabase().getDb()
    );
    let pluginToolCount = 0;
    const pluginNames: string[] = [];
    for (const mod of externalModules) {
      try {
        mod.configure?.(this.config);
        mod.migrate?.(getDatabase().getDb());
        const tools = mod.tools(this.config);
        if (tools.length > 0) {
          pluginToolCount += this.toolRegistry.registerPluginTools(mod.name, tools);
          pluginNames.push(mod.name);
        }
        this.modules.push(mod);
      } catch (error) {
        log.error(
          `❌ Plugin "${mod.name}" failed to load: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    if (pluginToolCount > 0) {
      this.toolCount = this.toolRegistry.count;
    }

    // Load MCP servers
    const mcpServerNames: string[] = [];
    if (Object.keys(this.config.mcp.servers).length > 0) {
      this.mcpConnections = await loadMcpServers(this.config.mcp);
      if (this.mcpConnections.length > 0) {
        const mcp = await registerMcpTools(this.mcpConnections, this.toolRegistry);
        if (mcp.count > 0) {
          this.toolCount = this.toolRegistry.count;
          mcpServerNames.push(...mcp.names);
          log.info(
            `🔌 MCP: ${mcp.count} tools from ${mcp.names.length} server(s) (${mcp.names.join(", ")})`
          );
        }
      }
    }

    // Initialize tool config from database
    this.toolRegistry.loadConfigFromDB(getDatabase().getDb());

    // Initialize Tool RAG index
    if (this.config.tool_rag.enabled) {
      const { ToolIndex } = await import("./agent/tools/tool-index.js");
      const toolIndex = new ToolIndex(
        getDatabase().getDb(),
        this.memory.embedder,
        getDatabase().isVectorSearchReady(),
        {
          topK: this.config.tool_rag.top_k,
          alwaysInclude: this.config.tool_rag.always_include,
          skipUnlimitedProviders: this.config.tool_rag.skip_unlimited_providers,
        }
      );
      toolIndex.ensureSchema();
      this.toolRegistry.setToolIndex(toolIndex);

      // Re-index callback for hot-reload plugins
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- callback is fire-and-forget
      this.toolRegistry.onToolsChanged(async (removed, added) => {
        await toolIndex.reindexTools(removed, added);
      });
    }

    // Provider info and tool limit check
    const provider = (this.config.agent.provider || "anthropic") as SupportedProvider;
    const providerMeta = getProviderMetadata(provider);
    const allNames = [...moduleNames, ...pluginNames, ...mcpServerNames];
    log.info(
      `🔌 ${this.toolCount} tools loaded (${allNames.join(", ")})${pluginToolCount > 0 ? ` — ${pluginToolCount} from plugins` : ""}`
    );
    if (providerMeta.toolLimit !== null && this.toolCount > providerMeta.toolLimit) {
      log.warn(
        `⚠️ Tool count (${this.toolCount}) exceeds ${providerMeta.displayName} limit (${providerMeta.toolLimit})`
      );
    }

    // Migrate sessions from JSON to SQLite (one-time)
    const { migrateSessionsToDb } = await import("./session/migrate.js");
    migrateSessionsToDb();

    // Cleanup old transcript files (>30 days)
    const { cleanupOldTranscripts } = await import("./session/transcript.js");
    cleanupOldTranscripts(30);

    // Prune old sessions (>30 days)
    const { pruneOldSessions } = await import("./session/store.js");
    pruneOldSessions(30);

    // Warmup embedding model (pre-download at startup, not on first message)
    if (this.memory.embedder.warmup) {
      await this.memory.embedder.warmup();
    }

    // Index knowledge base (MEMORY.md, memory/*.md)
    // Force re-index if embedding dimensions changed (model switch)
    const db = getDatabase();
    const forceReindex = db.didDimensionsChange();
    const indexResult = await this.memory.knowledge.indexAll({ force: forceReindex });
    let ftsResult = { knowledge: 0, messages: 0 };
    if (indexResult.indexed > 0) {
      ftsResult = db.rebuildFtsIndexes();
    }

    // Consolidate old session memory files (non-blocking — runs after startup)
    import("./session/memory-hook.js")
      .then(({ consolidateOldMemoryFiles }) =>
        consolidateOldMemoryFiles({
          apiKey: this.config.agent.api_key,
          provider: this.config.agent.provider as SupportedProvider,
          utilityModel: this.config.agent.utility_model,
        })
      )
      .then((r) => {
        if (r.consolidated > 0)
          log.info(`🧹 Consolidated ${r.consolidated} old session memory files`);
      })
      .catch((error) => log.warn({ err: error }, "Memory consolidation skipped"));

    // Index tools for Tool RAG
    const toolIndex = this.toolRegistry.getToolIndex();
    if (toolIndex) {
      const t0 = Date.now();
      const indexedCount = await toolIndex.indexAll(this.toolRegistry.getAll());
      log.info(`🔍 Tool RAG: ${indexedCount} tools indexed (${Date.now() - t0}ms)`);
    }

    // Initialize context builder for RAG search in agent
    this.agent.initializeContextBuilder(this.memory.embedder, db.isVectorSearchReady());

    // Cocoon Network — register models from external cocoon-cli proxy
    if (this.config.agent.provider === "cocoon") {
      try {
        const { registerCocoonModels } = await import("./agent/client.js");
        const port = this.config.cocoon?.port ?? 10000;
        const models = await registerCocoonModels(port);
        if (models.length === 0) {
          throw new Error(`No models found on port ${port}`);
        }
        log.info(`Cocoon Network ready — ${models.length} model(s) on port ${port}`);
      } catch (err) {
        log.error(
          `Cocoon Network unavailable on port ${this.config.cocoon?.port ?? 10000}: ${getErrorMessage(err)}`
        );
        log.error("Start the Cocoon client first: cocoon start");
        throw new Error(`Cocoon Network unavailable: ${getErrorMessage(err)}`);
      }
    }

    // Local LLM — register models from OpenAI-compatible server
    if (this.config.agent.provider === "local" && !this.config.agent.base_url) {
      throw new Error(
        "Local provider requires base_url in config (e.g. http://localhost:11434/v1)"
      );
    }
    if (this.config.agent.provider === "local" && this.config.agent.base_url) {
      try {
        const { registerLocalModels } = await import("./agent/client.js");
        const models = await registerLocalModels(this.config.agent.base_url);
        if (models.length > 0) {
          log.info(`Discovered ${models.length} local model(s): ${models.join(", ")}`);
          if (!this.config.agent.model || this.config.agent.model === "auto") {
            this.config.agent.model = models[0];
            log.info(`Using local model: ${models[0]}`);
          }
        } else {
          log.warn("No models found on local LLM server — is it running?");
        }
      } catch (err) {
        log.error(
          `Local LLM server unavailable at ${this.config.agent.base_url}: ${getErrorMessage(err)}`
        );
        log.error("Start the LLM server first (e.g. ollama serve)");
        throw new Error(`Local LLM server unavailable: ${getErrorMessage(err)}`);
      }
    }

    // Connect to Telegram
    await this.bridge.connect();

    if (!this.bridge.isAvailable()) {
      throw new Error("Failed to connect to Telegram");
    }

    // Resolve owner name/username from Telegram if not already set
    await this.resolveOwnerInfo();

    // Set own user ID in handler after connection
    const ownUserId = this.bridge.getOwnUserId();
    if (ownUserId) {
      this.messageHandler.setOwnUserId(ownUserId.toString());
    }

    const username = await this.bridge.getUsername();
    const walletAddress = getWalletAddress();

    // Initialize shared OTC matchmaker API
    const mmConfig = this.config.matchmaker;
    if (mmConfig?.enabled !== false) {
      const botId = ownUserId?.toString() ?? username ?? "unknown";
      this.matchmakerApi = createMatchmakerClient({
        matchmakerApiUrl: mmConfig?.api_url,
        botId,
        apiKey: mmConfig?.api_key,
      });
      this.messageHandler.setMatchmakerApi(this.matchmakerApi);
    }

    // Set up inline router for plugin bot SDK (before modules start)
    const inlineRouter = new InlineRouter();
    const rateLimiter = new PluginRateLimiter();

    // Install router middleware on the DealBot's Grammy instance
    // setBotPreMiddleware must be called BEFORE deals module start()
    setBotPreMiddleware(inlineRouter.middleware());

    // Start module background jobs (after bridge connect — deals needs bridge)
    const moduleDb = getDatabase().getDb();
    const pluginContext: PluginContext = {
      bridge: this.bridge,
      db: moduleDb,
      config: this.config,
    };
    const startedModules: PluginModule[] = [];
    try {
      for (const mod of this.modules) {
        await mod.start?.(pluginContext);
        startedModules.push(mod);
      }
    } catch (error) {
      log.error({ err: error }, "❌ Module start failed, cleaning up started modules");
      for (const mod of startedModules.reverse()) {
        try {
          await mod.stop?.();
        } catch (e) {
          log.error({ err: e }, `⚠️ Module "${mod.name}" cleanup failed`);
        }
      }
      throw error;
    }

    // Wire bot references into SDK deps (after DealBot has started)
    const activeDealBot = getDealBot();
    if (activeDealBot) {
      this.sdkDeps.inlineRouter = inlineRouter;
      this.sdkDeps.gramjsBot = activeDealBot.getGramJSBot();
      this.sdkDeps.grammyBot = activeDealBot.getBot();
      this.sdkDeps.rateLimiter = rateLimiter;
      inlineRouter.setGramJSBot(activeDealBot.getGramJSBot());
      log.info("🔌 Bot SDK: inline router installed");
    }

    // Create hook runner if any plugins registered hooks
    if (hookRegistry.hasAnyHooks()) {
      const hookRunner = createHookRunner(hookRegistry, { logger: log });
      this.agent.setHookRunner(hookRunner);
      this.hookRunner = hookRunner;

      const activeHooks: HookName[] = [
        "tool:before",
        "tool:after",
        "tool:error",
        "prompt:before",
        "prompt:after",
        "session:start",
        "session:end",
        "message:receive",
        "response:before",
        "response:after",
        "response:error",
        "agent:start",
        "agent:stop",
      ];
      const active = activeHooks.filter((n) => hookRegistry.hasHooks(n));
      log.info(`🪝 Hook runner created (${active.join(", ")})`);
    }

    // Collect plugin event hooks and wire them up
    this.wirePluginEventHooks();

    // Start plugin hot-reload watcher (dev mode)
    if (this.config.dev.hot_reload) {
      this.pluginWatcher = new PluginWatcher({
        config: this.config,
        registry: this.toolRegistry,
        sdkDeps: this.sdkDeps,
        modules: this.modules,
        pluginContext,
        loadedModuleNames: builtinNames,
      });
      this.pluginWatcher.start();
    }

    // Display startup summary (ASCII-safe for Windows PowerShell)
    const ok = this.isUnicodeTerminal() ? "✅" : "[OK]";
    const key = this.isUnicodeTerminal() ? "🔑" : "[KEY]";
    log.info(`${ok} SOUL.md loaded`);
    log.info(
      `${ok} Knowledge: ${indexResult.indexed} files, ${ftsResult.knowledge} chunks indexed`
    );
    log.info(`${ok} Telegram: @${username} connected`);
    log.info(`${ok} TON Blockchain: connected`);
    if (this.config.tonapi_key) {
      log.info(`${key} TonAPI key configured`);
    }
    log.info(`${ok} DEXs: STON.fi, DeDust connected`);
    log.info(`${ok} Wallet: ${walletAddress || "not configured"}`);
    log.info(`${ok} Model: ${provider}/${this.config.agent.model}`);
    log.info(`${ok} Admins: ${this.config.telegram.admin_ids.join(", ")}`);
    log.info(
      `${ok} Policy: DM ${this.config.telegram.dm_policy}, Groups ${this.config.telegram.group_policy}, Debounce ${this.config.telegram.debounce_ms}ms\n`
    );

    log.info("Teleclaw Agent is running! Press Ctrl+C to stop.");

    // Hook: agent:start
    this.startTime = Date.now();
    this.messagesProcessed = 0;
    if (this.hookRunner) {
      let version = "0.0.0";
      try {
        const { createRequire } = await import("module");
        const req = createRequire(import.meta.url);
        version = (req("../package.json") as { version: string }).version;
      } catch {
        /* ignore */
      }
      const agentStartEvent: AgentStartEvent = {
        version,
        provider: provider,
        model: this.config.agent.model,
        pluginCount: pluginNames.length,
        toolCount: this.toolCount,
        timestamp: Date.now(),
      };
      await this.hookRunner.runObservingHook("agent:start", agentStartEvent);
    }

    // Initialize message debouncer with bypass logic
    this.debouncer = new MessageDebouncer(
      {
        debounceMs: this.config.telegram.debounce_ms,
      },
      (msg) => {
        // Bypass debounce for DMs (only debounce groups)
        if (!msg.isGroup) return false;

        // Bypass debounce for admin commands (priority processing)
        if (msg.text.startsWith("/")) {
          const adminCmd = this.adminHandler.parseCommand(msg.text);
          if (adminCmd && this.adminHandler.isAdmin(msg.senderId)) {
            return false;
          }
        }

        return true;
      },
      async (messages) => {
        // Process each message one by one (preserves full context for each)
        for (const message of messages) {
          await this.handleSingleMessage(message);
        }
      },
      (error, messages) => {
        log.error({ err: error }, `Error processing batch of ${messages.length} messages`);
      }
    );

    // Register GramJS event handlers ONCE (survive agent restart via WebUI)
    if (!this.messageHandlersRegistered) {
      this.bridge.onNewMessage(async (message) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer always initialized before handlers register
          await this.debouncer!.enqueue(message);
        } catch (error) {
          log.error({ err: error }, "Error enqueueing message");
        }
      });

      this.bridge.onServiceMessage(async (message) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer always initialized before handlers register
          await this.debouncer!.enqueue(message);
        } catch (error) {
          log.error({ err: error }, "Error enqueueing service message");
        }
      });

      this.messageHandlersRegistered = true;
    }

    // In bot mode, start polling AFTER all handlers are registered
    if ("startPolling" in this.bridge && typeof this.bridge.startPolling === "function") {
      (this.bridge as { startPolling(): void }).startPolling();
    }

    // Periodic OTC matchmaker maintenance (every 6 hours)
    // - Remind sellers about stale listings (active 48h+ with matches)
    // - Expire listings past their expiration date
    this.staleCheckerInterval = setInterval(
      () => {
        const mainDb = getDatabase().getDb();
        const ctx = {
          bridge: this.bridge,
          db: mainDb,
          chatId: "",
          isGroup: false,
          senderId: 0,
          config: this.config,
        };
        checkStaleListings(ctx, this.bridge).catch((err) =>
          log.warn({ err }, "Stale listing check failed")
        );
        expireOldListings(ctx);
      },
      6 * 60 * 60 * 1000
    );
  }

  /**
   * Resolve owner name and username from Telegram API if not already configured.
   * Persists resolved values to the config file so this only happens once.
   */
  private async resolveOwnerInfo(): Promise<void> {
    try {
      // Skip if both are already set
      if (this.config.telegram.owner_name && this.config.telegram.owner_username) {
        return;
      }

      // Can't resolve without an owner ID
      if (!this.config.telegram.owner_id) {
        return;
      }

      // getEntity is optional (only userbot mode)
      if (!this.bridge.getEntity) {
        log.info(
          "Skipping owner resolution (Bot API mode — set owner_name/owner_username in config)"
        );
        return;
      }

      const entity = await this.bridge.getEntity(String(this.config.telegram.owner_id));

      // Check that the entity is a User (has firstName)
      if (!entity || typeof entity !== "object" || !("firstName" in entity)) {
        return;
      }

      const user = entity as Api.User;
      const firstName = user.firstName || "";
      const lastName = user.lastName || "";
      const fullName = lastName ? `${firstName} ${lastName}` : firstName;
      const username = user.username || "";

      let updated = false;

      if (!this.config.telegram.owner_name && fullName) {
        this.config.telegram.owner_name = fullName;
        updated = true;
      }

      if (!this.config.telegram.owner_username && username) {
        this.config.telegram.owner_username = username;
        updated = true;
      }

      if (updated) {
        // Persist to disk
        const raw = readRawConfig(this.configPath);
        if (this.config.telegram.owner_name) {
          setNestedValue(raw, "telegram.owner_name", this.config.telegram.owner_name);
        }
        if (this.config.telegram.owner_username) {
          setNestedValue(raw, "telegram.owner_username", this.config.telegram.owner_username);
        }
        writeRawConfig(raw, this.configPath);

        const displayName = this.config.telegram.owner_name || "Unknown";
        const displayUsername = this.config.telegram.owner_username
          ? ` (@${this.config.telegram.owner_username})`
          : "";
        log.info(`👤 Owner resolved: ${displayName}${displayUsername}`);
      }
    } catch (error) {
      log.warn(
        `⚠️ Could not resolve owner info: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Handle a single message (extracted for debouncer callback)
   */
  private async handleSingleMessage(message: TelegramMessage): Promise<void> {
    this.messagesProcessed++;
    try {
      // Check if this is a scheduled task (from self)
      const ownUserId = this.bridge.getOwnUserId();
      if (
        ownUserId &&
        message.senderId === Number(ownUserId) &&
        message.text.startsWith("[TASK:")
      ) {
        await this.handleScheduledTask(message);
        return;
      }

      // Handle /start — claim code or onboarding (before admin check)
      const startCmd = this.adminHandler.parseCommand(message.text);
      if (startCmd && startCmd.command === "start") {
        // Try claim first
        const claimResult = await this.adminHandler.handleClaimAttempt(
          { ...startCmd, chatId: message.chatId, senderId: message.senderId },
          message.senderId
        );
        if (claimResult) {
          await this.bridge.sendMessage({
            chatId: message.chatId,
            text: claimResult,
            replyToId: message.id,
          });
          return;
        }

        // Not a claim — show welcome message (pass to agent with bootstrap)
        if (!message.isGroup) {
          const bootstrapContent = this.adminHandler.getBootstrapContent();
          if (bootstrapContent) {
            message.text = bootstrapContent;
            // Fall through to handleMessage below
          } else {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text:
                "👋 Welcome to Teleclaw!\n\n" +
                "I'm your AI agent for Telegram & TON blockchain.\n\n" +
                "Just ask me anything — trade tokens, check prices, manage gifts, flip usernames, and more.\n\n" +
                "Type /help to see admin commands.",
            });
            return;
          }
        }
      }

      // Handle user-level commands — available to ALL users (not admin-gated)
      const userCmd = this.adminHandler.parseCommand(message.text);
      if (userCmd) {
        // /help — show user-facing help (different from admin help)
        if (userCmd.command === "help") {
          const isAdmin = this.adminHandler.isAdmin(message.senderId);
          const helpText = isAdmin
            ? this.adminHandler.handleCommand(
                userCmd,
                message.chatId,
                message.senderId,
                message.isGroup
              )
            : Promise.resolve(
                `🦞 **TeleClaw Commands**\n\n` +
                  `💬 **General**\n` +
                  `/help — Show this help message\n` +
                  `/ping — Check if agent is alive\n\n` +
                  `🔐 **Wallet & OTC**\n` +
                  `/verify — Verify your TON wallet (0.01 TON)\n` +
                  `/otc — OTC Matchmaker info\n\n` +
                  `⚙️ **Settings**\n` +
                  `/apikey — Set your own LLM API key\n` +
                  `/mymodel — Set your preferred model\n` +
                  `/mysettings — View your settings\n\n` +
                  `💡 You can also just chat naturally — ask about gifts, prices, usernames, or anything TON & Telegram related.`
              );
          const response = await helpText;
          if (response) {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: response,
              replyToId: message.id,
            });
          }
          return;
        }

        // /ping — available to everyone
        if (userCmd.command === "ping") {
          await this.bridge.sendMessage({
            chatId: message.chatId,
            text: "🏓 Pong!",
            replyToId: message.id,
          });
          return;
        }

        // /verify — wallet verification (available to all users)
        if (userCmd.command === "verify") {
          const action = userCmd.args[0] === "check" ? "check" : "start";
          try {
            const { verifyWalletExecutor } =
              await import("./agent/tools/agentic-wallet/verify-wallet.js");
            const { migrateVerifiedWallets } =
              await import("./agent/tools/agentic-wallet/verify-wallet.js");
            const db = getDatabase().getDb();
            migrateVerifiedWallets(db);
            const result = await verifyWalletExecutor(
              { action },
              {
                bridge: this.bridge,
                db,
                chatId: message.chatId,
                senderId: message.senderId,
                isGroup: message.isGroup,
                config: this.config,
              }
            );
            const text = result.success
              ? ((result.data as Record<string, unknown>)?.message as string) || "✅ Done"
              : result.error || "❌ Error";
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text,
              replyToId: message.id,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: `❌ Verification error: ${errMsg}`,
              replyToId: message.id,
            });
          }
          return;
        }

        // /apikey, /mymodel, /mysettings — user settings
        if (
          userCmd.command === "apikey" ||
          userCmd.command === "mymodel" ||
          userCmd.command === "mysettings"
        ) {
          const response = await this.handleUserSettingsCommand(
            userCmd.command,
            userCmd.args,
            message.chatId,
            message.senderId
          );
          if (response) {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: response,
              replyToId: message.id,
            });
          }
          return;
        }
      }

      // Check if this is an admin command
      const adminCmd = this.adminHandler.parseCommand(message.text);
      if (adminCmd && this.adminHandler.isAdmin(message.senderId)) {
        // /boot passes through to the agent with bootstrap instructions
        if (adminCmd.command === "boot") {
          const bootstrapContent = this.adminHandler.getBootstrapContent();
          if (bootstrapContent) {
            message.text = bootstrapContent;
            // Fall through to handleMessage below
          } else {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: "❌ Bootstrap template not found.",
              replyToId: message.id,
            });
            return;
          }
        } else if (adminCmd.command === "task") {
          // /task passes through to the agent with task creation context
          const taskDescription = adminCmd.args.join(" ");
          if (!taskDescription) {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: "❌ Usage: /task <description>",
              replyToId: message.id,
            });
            return;
          }
          message.text =
            `[ADMIN TASK]\n` +
            `Create a scheduled task using the telegram_create_scheduled_task tool.\n\n` +
            `Guidelines:\n` +
            `- If the description mentions a specific time or delay, use it as scheduleDate\n` +
            `- Otherwise, schedule 1 minute from now for immediate execution\n` +
            `- For simple operations (check a price, send a message), use a tool_call payload\n` +
            `- For complex multi-step tasks, use an agent_task payload with detailed instructions\n` +
            `- Always include a reason explaining why this task is being created\n\n` +
            `Task: "${taskDescription}"`;
          // Fall through to handleMessage below
        } else {
          const response = await this.adminHandler.handleCommand(
            adminCmd,
            message.chatId,
            message.senderId,
            message.isGroup
          );

          await this.bridge.sendMessage({
            chatId: message.chatId,
            text: response,
            replyToId: message.id,
          });

          return;
        }
      }

      // Skip if paused (admin commands still work above)
      if (this.adminHandler.isPaused()) return;

      // Handle as regular message
      await this.messageHandler.handleMessage(message);
    } catch (error) {
      log.error({ err: error }, "Error handling message");
    }
  }

  /**
   * Handle user settings commands (/apikey, /mymodel, /mysettings)
   */
  private async handleUserSettingsCommand(
    command: string,
    args: string[],
    chatId: string,
    senderId: number
  ): Promise<string> {
    const {
      getUserSettings: getSettings,
      setUserProvider: setProvider,
      setUserModel: setModel,
      clearUserSettings: clearSettings,
    } = await import("./session/user-settings.js");
    const db = getDatabase().getDb();

    if (command === "mysettings") {
      const settings = getSettings(db, senderId);
      if (!settings) {
        return (
          "⚙️ **Your Settings**\n\n" +
          "No custom settings — using bot defaults.\n\n" +
          "Commands:\n" +
          "/apikey <provider> <key> — Set your LLM API key\n" +
          "/mymodel <model> — Set preferred model\n" +
          "/apikey clear — Remove custom settings"
        );
      }
      return (
        "⚙️ **Your Settings**\n\n" +
        `Provider: **${settings.provider || "default"}**\n` +
        `Model: **${settings.model || "default"}**\n` +
        `API Key: **${"•".repeat(8)}${settings.apiKey?.slice(-4) || "none"}**\n\n` +
        "Commands:\n" +
        "/apikey <provider> <key> — Change provider\n" +
        "/mymodel <model> — Change model\n" +
        "/apikey clear — Remove custom settings"
      );
    }

    if (command === "apikey") {
      if (args[0] === "clear") {
        clearSettings(db, senderId);
        return "✅ Custom settings cleared. Using bot defaults now.";
      }

      if (args.length < 2) {
        return (
          "Usage: `/apikey <provider> <key>`\n\n" +
          "Providers: anthropic, openai, google, xai, groq, openrouter, mistral\n\n" +
          "Example: `/apikey anthropic sk-ant-...`\n" +
          "Clear: `/apikey clear`"
        );
      }

      const provider = args[0].toLowerCase();
      const apiKey = args[1];
      const validProviders = [
        "anthropic",
        "openai",
        "google",
        "xai",
        "groq",
        "openrouter",
        "mistral",
        "cerebras",
        "minimax",
        "moonshot",
      ];
      if (!validProviders.includes(provider)) {
        return `❌ Unknown provider "${provider}". Valid: ${validProviders.join(", ")}`;
      }

      setProvider(db, senderId, provider, apiKey);

      // Delete the message containing the API key for security
      try {
        await this.bridge.sendMessage({
          chatId,
          text: `✅ API key set for **${provider}**!\n\n⚠️ Delete your message containing the key for security.`,
        });
      } catch {
        /* ignore */
      }

      return "";
    }

    if (command === "mymodel") {
      if (args.length === 0) {
        return "Usage: `/mymodel <model-name>`\n\nExample: `/mymodel claude-sonnet-4-20250514`";
      }
      setModel(db, senderId, args[0]);
      return `✅ Model set to **${args[0]}**`;
    }

    return "❓ Unknown command.";
  }

  /**
   * Handle scheduled task message
   */
  private async handleScheduledTask(message: TelegramMessage): Promise<void> {
    // Hoist all dynamic imports to top of function
    const { getTaskStore } = await import("./memory/agent/tasks.js");
    const { executeScheduledTask } = await import("./telegram/task-executor.js");
    const { TaskDependencyResolver } = await import("./telegram/task-dependency-resolver.js");
    const { getDatabase } = await import("./memory/index.js");

    const db = getDatabase().getDb();
    const taskStore = getTaskStore(db);

    // Extract task ID from format: [TASK:uuid] description
    const match = message.text.match(/^\[TASK:([^\]]+)\]/);
    if (!match) {
      log.warn(`Invalid task format: ${message.text}`);
      return;
    }

    const taskId = match[1];

    try {
      const task = taskStore.getTask(taskId);

      if (!task) {
        log.warn(`Task ${taskId} not found in database`);
        await this.bridge.sendMessage({
          chatId: message.chatId,
          text: `⚠️ Task ${taskId} not found. It may have been deleted.`,
          replyToId: message.id,
        });
        return;
      }

      // Skip cancelled tasks (e.g. cancelled via WebUI or admin)
      if (task.status === "cancelled" || task.status === "done" || task.status === "failed") {
        log.info(`⏭️ Task ${taskId} already ${task.status}, skipping`);
        return;
      }

      // Check if all dependencies are satisfied
      if (!taskStore.canExecute(taskId)) {
        log.warn(`Task ${taskId} cannot execute yet - dependencies not satisfied`);
        await this.bridge.sendMessage({
          chatId: message.chatId,
          text: `⏳ Task "${task.description}" is waiting for parent tasks to complete.`,
          replyToId: message.id,
        });
        return;
      }

      // Mark task as in_progress
      taskStore.startTask(taskId);

      // Get parent task results for context
      const parentResults = taskStore.getParentResults(taskId);

      // Build tool context
      const toolContext = {
        bridge: this.bridge,
        db,
        chatId: message.chatId,
        isGroup: message.isGroup,
        senderId: message.senderId,
        config: this.config,
      };

      // Get tool registry from agent runtime
      const toolRegistry = this.agent.getToolRegistry();

      // Execute task and get prompt for agent (with parent context)
      const agentPrompt = await executeScheduledTask(
        task,
        this.agent,
        toolContext,
        toolRegistry,
        parentResults
      );

      // Feed prompt to agent (agent loop with full context)
      const response = await this.agent.processMessage({
        chatId: message.chatId,
        userMessage: agentPrompt,
        userName: "self-scheduled-task",
        timestamp: message.timestamp.getTime(),
        isGroup: false,
        toolContext,
        messageId: message.id,
      });

      // Send agent response
      if (response.content && response.content.trim().length > 0) {
        await this.bridge.sendMessage({
          chatId: message.chatId,
          text: response.content,
          replyToId: message.id,
        });
      }

      // Mark task as done if agent responded successfully
      taskStore.completeTask(taskId, response.content);

      log.info(`✅ Executed scheduled task ${taskId}: ${task.description}`);

      // Initialize dependency resolver if needed
      if (!this.dependencyResolver) {
        this.dependencyResolver = new TaskDependencyResolver(taskStore, this.bridge);
      }

      // Trigger any dependent tasks
      await this.dependencyResolver.onTaskComplete(taskId);
    } catch (error) {
      log.error({ err: error }, "Error handling scheduled task");

      // Try to mark task as failed and cascade to dependents
      try {
        taskStore.failTask(taskId, getErrorMessage(error));

        // Initialize resolver if needed
        if (!this.dependencyResolver) {
          this.dependencyResolver = new TaskDependencyResolver(taskStore, this.bridge);
        }

        // Cascade failure to dependents
        await this.dependencyResolver.onTaskFail(taskId);
      } catch {
        // Ignore if we can't update task
      }
    }
  }

  /**
   * Collect plugin onMessage/onCallbackQuery hooks and register them.
   * Uses dynamic dispatch over this.modules so newly installed/uninstalled
   * plugins are picked up without re-registering handlers.
   */
  private wirePluginEventHooks(): void {
    // Message hooks: single dynamic dispatcher that iterates this.modules
    this.messageHandler.setPluginMessageHooks([
      async (event: PluginMessageEvent) => {
        for (const mod of this.modules) {
          const withHooks = mod as PluginModuleWithHooks;
          if (withHooks.onMessage) {
            try {
              await withHooks.onMessage(event);
            } catch (err) {
              log.error(
                `❌ [${mod.name}] onMessage error: ${err instanceof Error ? err.message : err}`
              );
            }
          }
        }
      },
    ]);

    const hookCount = this.modules.filter((m) => (m as PluginModuleWithHooks).onMessage).length;
    if (hookCount > 0) {
      log.info(`🔗 ${hookCount} plugin onMessage hook(s) registered`);
    }

    // Callback query handler: register ONCE, dispatch dynamically
    if (!this.callbackHandlerRegistered) {
      this.bridge.addCallbackQueryHandler(async (cbEvent: CallbackQueryEvent) => {
        const { queryId, data, chatId, messageId, userId } = cbEvent;
        const parts = data.split(":");
        const action = parts[0];
        const params = parts.slice(1);

        const answer = async (text?: string, alert = false): Promise<void> => {
          try {
            await this.bridge.answerCallbackQuery(queryId, { message: text, alert });
          } catch (err) {
            log.error(
              `❌ Failed to answer callback query: ${err instanceof Error ? err.message : err}`
            );
          }
        };

        const event: PluginCallbackEvent = {
          data,
          action,
          params,
          chatId,
          messageId,
          userId,
          answer,
        };

        for (const mod of this.modules) {
          const withHooks = mod as PluginModuleWithHooks;
          if (withHooks.onCallbackQuery) {
            try {
              await withHooks.onCallbackQuery(event);
            } catch (err) {
              log.error(
                `❌ [${mod.name}] onCallbackQuery error: ${err instanceof Error ? err.message : err}`
              );
            }
          }
        }
      });
      this.callbackHandlerRegistered = true;

      const cbCount = this.modules.filter(
        (m) => (m as PluginModuleWithHooks).onCallbackQuery
      ).length;
      if (cbCount > 0) {
        log.info(`🔗 ${cbCount} plugin onCallbackQuery hook(s) registered`);
      }
    }
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    log.info("👋 Stopping Teleclaw AI...");

    // Stop agent subsystems via lifecycle
    await this.lifecycle.stop(() => this.stopAgent());

    // Stop WebUI server (if running)
    if (this.webuiServer) {
      try {
        await this.webuiServer.stop();
      } catch (e) {
        log.error({ err: e }, "⚠️ WebUI stop failed");
      }
    }

    // Close database last (shared with WebUI)
    try {
      closeDatabase();
    } catch (e) {
      log.error({ err: e }, "⚠️ Database close failed");
    }
  }

  /**
   * Stop agent subsystems (watcher, MCP, debouncer, handler, modules, bridge).
   * Called by lifecycle.stop() — do NOT call directly.
   */
  private async stopAgent(): Promise<void> {
    // Hook: agent:stop — fire BEFORE disconnecting anything
    if (this.hookRunner) {
      try {
        const agentStopEvent: AgentStopEvent = {
          reason: "manual",
          uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
          messagesProcessed: this.messagesProcessed,
          timestamp: Date.now(),
        };
        await this.hookRunner.runObservingHook("agent:stop", agentStopEvent);
      } catch (e) {
        log.error({ err: e }, "⚠️ agent:stop hook failed");
      }
    }

    // Stop stale listing checker
    if (this.staleCheckerInterval) {
      clearInterval(this.staleCheckerInterval);
      this.staleCheckerInterval = null;
    }

    // Stop plugin watcher first
    if (this.pluginWatcher) {
      try {
        await this.pluginWatcher.stop();
      } catch (e) {
        log.error({ err: e }, "⚠️ Plugin watcher stop failed");
      }
    }

    // Close MCP connections
    if (this.mcpConnections.length > 0) {
      try {
        await closeMcpServers(this.mcpConnections);
      } catch (e) {
        log.error({ err: e }, "⚠️ MCP close failed");
      }
    }

    // Each step is isolated so a failure in one doesn't skip the rest
    if (this.debouncer) {
      try {
        await this.debouncer.flushAll();
      } catch (e) {
        log.error({ err: e }, "⚠️ Debouncer flush failed");
      }
    }

    // Drain in-flight message processing before disconnecting
    try {
      await this.messageHandler.drain();
    } catch (e) {
      log.error({ err: e }, "⚠️ Message queue drain failed");
    }

    for (const mod of this.modules) {
      try {
        await mod.stop?.();
      } catch (e) {
        log.error({ err: e }, `⚠️ Module "${mod.name}" stop failed`);
      }
    }

    try {
      await this.bridge.disconnect();
    } catch (e) {
      log.error({ err: e }, "⚠️ Bridge disconnect failed");
    }
  }
}

/**
 * Start the application
 */
export async function main(configPath?: string): Promise<void> {
  let app: TeleclawApp;
  try {
    app = new TeleclawApp(configPath);
  } catch (error) {
    log.error(`Failed to initialize: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Handle uncaught errors - log and keep running
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "⚠️ Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    log.error({ err: error }, "💥 Uncaught exception");
    // Exit on uncaught exceptions - state may be corrupted
    process.exit(1);
  });

  // Handle graceful shutdown with timeout safety net
  let shutdownInProgress = false;
  const gracefulShutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    const forceExit = setTimeout(() => {
      log.error("⚠️ Shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    await app.stop();
    clearTimeout(forceExit);
    process.exit(0);
  };

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- signal handler is fire-and-forget
  process.on("SIGINT", gracefulShutdown);
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- signal handler is fire-and-forget
  process.on("SIGTERM", gracefulShutdown);

  await app.start();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log.fatal({ err: error }, "Fatal error");
    process.exit(1);
  });
}
