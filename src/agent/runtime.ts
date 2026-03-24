import type { Config } from "../config/schema.js";
import {
  MAX_TOOL_RESULT_SIZE,
  COMPACTION_MAX_MESSAGES,
  COMPACTION_KEEP_RECENT,
  COMPACTION_MAX_TOKENS_RATIO,
  COMPACTION_SOFT_THRESHOLD_RATIO,
  CONTEXT_MAX_RECENT_MESSAGES,
  CONTEXT_MAX_RELEVANT_CHUNKS,
  CONTEXT_OVERFLOW_SUMMARY_MESSAGES,
  RATE_LIMIT_MAX_RETRIES,
  SERVER_ERROR_MAX_RETRIES,
  TOOL_CONCURRENCY_LIMIT,
  EMBEDDING_QUERY_MAX_CHARS,
} from "../constants/limits.js";
import { TELEGRAM_SEND_TOOLS } from "../constants/tools.js";
import {
  chatWithContext,
  loadContextFromTranscript,
  getProviderModel,
  getEffectiveApiKey,
  type ChatResponse,
} from "./client.js";
import { getProviderMetadata, type SupportedProvider } from "../config/providers.js";
import { buildSystemPrompt } from "../soul/loader.js";
import { getDatabase } from "../memory/index.js";
import { sanitizeForContext } from "../utils/sanitize.js";
import { formatMessageEnvelope } from "../memory/envelope.js";
import {
  getOrCreateSession,
  updateSession,
  getSession,
  resetSession,
  shouldResetSession,
  resetSessionWithPolicy,
} from "../session/store.js";
import { transcriptExists, archiveTranscript, appendToTranscript } from "../session/transcript.js";
import type {
  Context,
  Tool as PiAiTool,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { CompactionManager, DEFAULT_COMPACTION_CONFIG } from "../memory/compaction.js";
import { maskOldToolResults } from "../memory/observation-masking.js";
import { ContextBuilder } from "../memory/search/context.js";
import type { EmbeddingProvider } from "../memory/embeddings/provider.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";
import { appendToDailyLog } from "../memory/daily-logs.js";
import { saveSessionMemory } from "../session/memory-hook.js";
import { createLogger } from "../utils/logger.js";
import { getUserSettings, getEffectiveAgentConfig } from "../session/user-settings.js";
import type { createHookRunner } from "../sdk/hooks/runner.js";
import type { UserHookEvaluator } from "./hooks/user-hook-evaluator.js";
import type {
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforePromptBuildEvent,
  MessageReceiveEvent,
  ResponseBeforeEvent,
  ResponseAfterEvent,
  ResponseErrorEvent,
  ToolErrorEvent,
  PromptAfterEvent,
} from "../sdk/hooks/types.js";

const log = createLogger("Agent");

// ── Global token usage accumulator (in-memory, resets on restart) ───
const globalTokenUsage = { totalTokens: 0, totalCost: 0 };

export function getTokenUsage() {
  return { ...globalTokenUsage };
}

function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("prompt is too long") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("too many tokens") ||
    lower.includes("request_too_large") ||
    (lower.includes("exceeds") && lower.includes("maximum")) ||
    (lower.includes("context") && lower.includes("limit"))
  );
}

function isTrivialMessage(text: string): boolean {
  const stripped = text.trim();
  if (!stripped) return true;
  if (stripped.length <= 1 && !/[a-zA-Z0-9а-яА-ЯёЁ]/.test(stripped)) return false; // single chars like "?" are follow-ups, not trivial
  if (!/[a-zA-Z0-9а-яА-ЯёЁ]/.test(stripped)) return true;
  const trivial =
    /^(ok|okay|k|oui|non|yes|no|yep|nope|sure|thanks|merci|thx|ty|lol|haha|cool|nice|wow|bravo|top|parfait|d'accord|alright|fine|got it|np|gg)\.?!?$/i;
  return trivial.test(stripped);
}

function extractContextSummary(context: Context, maxMessages: number = 10): string {
  const recentMessages = context.messages.slice(-maxMessages);
  const summaryParts: string[] = [];

  summaryParts.push("### Session Summary (Auto-saved before overflow reset)\n");

  for (const msg of recentMessages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "[complex]";
      const bodyMatch = content.match(/\] (.+)/s);
      const body = bodyMatch ? bodyMatch[1] : content;
      summaryParts.push(`- **User**: ${body.substring(0, 150)}${body.length > 150 ? "..." : ""}`);
    } else if (msg.role === "assistant") {
      const textBlocks = msg.content.filter((b): b is TextContent => b.type === "text");
      const toolBlocks = msg.content.filter((b): b is ToolCall => b.type === "toolCall");

      if (textBlocks.length > 0) {
        const text = textBlocks[0].text || "";
        summaryParts.push(
          `- **Agent**: ${text.substring(0, 150)}${text.length > 150 ? "..." : ""}`
        );
      }

      if (toolBlocks.length > 0) {
        const toolNames = toolBlocks.map((b) => b.name).join(", ");
        summaryParts.push(`  - *Tools used: ${toolNames}*`);
      }
    } else if (msg.role === "toolResult") {
      const status = msg.isError ? "ERROR" : "OK";
      summaryParts.push(`  - *Tool result: ${msg.toolName} → ${status}*`);
    }
  }

  return summaryParts.join("\n");
}

export interface ProcessMessageOptions {
  chatId: string;
  userMessage: string;
  userName?: string;
  timestamp?: number;
  isGroup?: boolean;
  pendingContext?: string | null;
  toolContext?: Omit<ToolContext, "chatId" | "isGroup">;
  senderUsername?: string;
  senderRank?: string;
  hasMedia?: boolean;
  mediaType?: string;
  /** Base64-encoded image data for vision */
  imageBase64?: string;
  imageMimeType?: string;
  messageId?: number;
  replyContext?: { senderName?: string; text: string; isAgent?: boolean };
}

export interface AgentResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
  }>;
}

export class AgentRuntime {
  private config: Config;
  private soul: string;
  private compactionManager: CompactionManager;
  private contextBuilder: ContextBuilder | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private embedder: EmbeddingProvider | null = null;
  private hookRunner?: ReturnType<typeof createHookRunner>;
  private userHookEvaluator?: UserHookEvaluator;

  constructor(config: Config, soul?: string, toolRegistry?: ToolRegistry) {
    this.config = config;
    this.soul = soul ?? "";
    this.toolRegistry = toolRegistry ?? null;

    const provider = (config.agent.provider || "anthropic") as SupportedProvider;
    const resolvedModelId = config.agent.model || getProviderMetadata(provider).defaultModel;
    try {
      const model = getProviderModel(provider, resolvedModelId);
      const ctx = model.contextWindow;
      this.compactionManager = new CompactionManager({
        enabled: true,
        maxMessages: COMPACTION_MAX_MESSAGES,
        maxTokens: Math.floor(ctx * COMPACTION_MAX_TOKENS_RATIO),
        keepRecentMessages: COMPACTION_KEEP_RECENT,
        memoryFlushEnabled: true,
        softThresholdTokens: Math.floor(ctx * COMPACTION_SOFT_THRESHOLD_RATIO),
      });
    } catch {
      this.compactionManager = new CompactionManager(DEFAULT_COMPACTION_CONFIG);
    }
  }

  setHookRunner(runner: ReturnType<typeof createHookRunner>): void {
    this.hookRunner = runner;
  }

  setUserHookEvaluator(evaluator: UserHookEvaluator): void {
    this.userHookEvaluator = evaluator;
  }

  initializeContextBuilder(embedder: EmbeddingProvider, vectorEnabled: boolean): void {
    this.embedder = embedder;
    const db = getDatabase().getDb();
    this.contextBuilder = new ContextBuilder(db, embedder, vectorEnabled);
  }

  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  async processMessage(opts: ProcessMessageOptions): Promise<AgentResponse> {
    const {
      chatId,
      userMessage,
      userName,
      timestamp,
      isGroup,
      pendingContext,
      toolContext,
      senderUsername,
      senderRank,
      hasMedia,
      mediaType,
      imageBase64,
      imageMimeType,
      messageId,
      replyContext,
    } = opts;

    const effectiveIsGroup = isGroup ?? false;
    const processStartTime = Date.now();

    try {
      // User hooks: keyword blocklist + context injection (hot-reloadable, no restart)
      let userHookContext = "";
      if (this.userHookEvaluator) {
        const hookResult = this.userHookEvaluator.evaluate(userMessage);
        if (hookResult.blocked) {
          log.info("Message blocked by keyword filter");
          return { content: hookResult.blockMessage ?? "", toolCalls: [] };
        }
        if (hookResult.additionalContext) {
          userHookContext = sanitizeForContext(hookResult.additionalContext);
        }
      }

      // Hook: message:receive — plugins can block, mutate text, inject context
      let effectiveMessage = userMessage;
      let hookMessageContext = "";
      if (this.hookRunner) {
        const msgEvent: MessageReceiveEvent = {
          chatId,
          senderId: toolContext?.senderId ? String(toolContext.senderId) : chatId,
          senderName: userName ?? "",
          isGroup: effectiveIsGroup,
          isReply: !!replyContext,
          replyToMessageId: replyContext ? messageId : undefined,
          messageId: messageId ?? 0,
          timestamp: timestamp ?? Date.now(),
          text: userMessage,
          block: false,
          blockReason: "",
          additionalContext: "",
        };
        await this.hookRunner.runModifyingHook("message:receive", msgEvent);
        if (msgEvent.block) {
          log.info(`🚫 Message blocked by hook: ${msgEvent.blockReason || "no reason"}`);
          return { content: "", toolCalls: [] };
        }
        effectiveMessage = sanitizeForContext(msgEvent.text);
        if (msgEvent.additionalContext) {
          hookMessageContext = sanitizeForContext(msgEvent.additionalContext);
        }
      }

      let session = getOrCreateSession(chatId);
      const now = timestamp ?? Date.now();

      const resetPolicy = this.config.agent.session_reset_policy;
      if (shouldResetSession(session, resetPolicy)) {
        log.info(`🔄 Auto-resetting session based on policy`);

        // Hook: session:end (before reset)
        if (this.hookRunner) {
          await this.hookRunner.runObservingHook("session:end", {
            sessionId: session.sessionId,
            chatId,
            messageCount: session.messageCount,
          });
        }

        if (transcriptExists(session.sessionId)) {
          try {
            log.info(`💾 Saving memory before daily reset...`);
            const oldContext = loadContextFromTranscript(session.sessionId);

            await saveSessionMemory({
              oldSessionId: session.sessionId,
              newSessionId: "pending",
              context: oldContext,
              chatId,
              apiKey: getEffectiveApiKey(this.config.agent.provider, this.config.agent.api_key),
              provider: this.config.agent.provider as SupportedProvider,
              utilityModel: this.config.agent.utility_model,
            });

            log.info(`✅ Memory saved before reset`);
          } catch (error) {
            log.warn({ err: error }, `⚠️ Failed to save memory before reset`);
          }
        }

        session = resetSessionWithPolicy(chatId, resetPolicy);
      }

      let context: Context = loadContextFromTranscript(session.sessionId);
      const isNewSession = context.messages.length === 0;
      if (!isNewSession) {
        log.info(`📖 Loading existing session: ${session.sessionId}`);
      } else {
        log.info(`🆕 Starting new session: ${session.sessionId}`);
      }

      // Hook: session:start
      if (this.hookRunner) {
        await this.hookRunner.runObservingHook("session:start", {
          sessionId: session.sessionId,
          chatId,
          isResume: !isNewSession,
        });
      }

      const previousTimestamp = session.updatedAt;

      let formattedMessage = formatMessageEnvelope({
        channel: "Telegram",
        senderId: toolContext?.senderId ? String(toolContext.senderId) : chatId,
        senderName: userName,
        senderUsername: senderUsername,
        senderRank,
        timestamp: now,
        previousTimestamp,
        body: effectiveMessage,
        isGroup: effectiveIsGroup,
        hasMedia,
        mediaType,
        messageId,
        replyContext,
      });

      if (pendingContext) {
        formattedMessage = `${pendingContext}\n\n${formattedMessage}`;
        log.debug(`📋 Including ${pendingContext.split("\n").length - 1} pending messages`);
      }

      log.debug(`📨 Formatted message: ${formattedMessage.substring(0, 100)}...`);

      const preview = formattedMessage.slice(0, 50).replace(/\n/g, " ");
      const who = senderUsername ? `@${senderUsername}` : userName;
      const msgType = isGroup ? `Group ${chatId} ${who}` : `DM ${who}`;
      log.info(`📨 ${msgType}: "${preview}${formattedMessage.length > 50 ? "..." : ""}"`);

      let relevantContext = "";
      let queryEmbedding: number[] | undefined;
      const isNonTrivial = !isTrivialMessage(effectiveMessage);

      if (this.embedder && isNonTrivial) {
        try {
          // Enrich query with recent conversation context for better RAG retrieval
          let searchQuery = effectiveMessage;
          const recentUserMsgs = context.messages
            .filter((m) => m.role === "user" && typeof m.content === "string")
            .slice(-3)
            .map((m) => {
              const text = m.content as string;
              const bodyMatch = text.match(/\] (.+)/s);
              return (bodyMatch ? bodyMatch[1] : text).trim();
            })
            .filter((t) => t.length > 0);
          if (recentUserMsgs.length > 0) {
            searchQuery = recentUserMsgs.join(" ") + " " + effectiveMessage;
          }
          queryEmbedding = await this.embedder.embedQuery(
            searchQuery.slice(0, EMBEDDING_QUERY_MAX_CHARS)
          );
        } catch (error) {
          log.warn({ err: error }, "Embedding computation failed");
        }
      }

      if (this.contextBuilder && isNonTrivial) {
        try {
          const dbContext = await this.contextBuilder.buildContext({
            query: effectiveMessage,
            chatId,
            includeAgentMemory: true,
            includeFeedHistory: true,
            searchAllChats: !isGroup,
            maxRecentMessages: CONTEXT_MAX_RECENT_MESSAGES,
            maxRelevantChunks: CONTEXT_MAX_RELEVANT_CHUNKS,
            queryEmbedding,
          });

          const contextParts: string[] = [];

          if (dbContext.relevantKnowledge.length > 0) {
            const sanitizedKnowledge = dbContext.relevantKnowledge.map((chunk) =>
              sanitizeForContext(chunk)
            );
            contextParts.push(
              `[Relevant knowledge from memory]\n${sanitizedKnowledge.join("\n---\n")}`
            );
          }

          if (dbContext.relevantFeed.length > 0) {
            const sanitizedFeed = dbContext.relevantFeed.map((msg) => sanitizeForContext(msg));
            contextParts.push(
              `[Relevant messages from Telegram feed]\n${sanitizedFeed.join("\n")}`
            );
          }

          if (contextParts.length > 0) {
            relevantContext = contextParts.join("\n\n");
            log.debug(
              `🔍 Found ${dbContext.relevantKnowledge.length} knowledge chunks, ${dbContext.relevantFeed.length} feed messages`
            );
          }
        } catch (error) {
          log.warn({ err: error }, "Context building failed");
        }
      }

      const memoryStats = this.getMemoryStats();
      const statsContext = `[Memory Status: ${memoryStats.totalMessages} messages across ${memoryStats.totalChats} chats, ${memoryStats.knowledgeChunks} knowledge chunks]`;

      const additionalContext = relevantContext
        ? `You are in a Telegram conversation with chat ID: ${chatId}. Maintain conversation continuity.\n\n${statsContext}\n\n${relevantContext}`
        : `You are in a Telegram conversation with chat ID: ${chatId}. Maintain conversation continuity.\n\n${statsContext}`;

      // Hook: prompt:before
      let hookAdditionalContext = "";
      if (this.hookRunner) {
        const promptEvent: BeforePromptBuildEvent = {
          chatId,
          sessionId: session.sessionId,
          isGroup: effectiveIsGroup,
          additionalContext: "",
        };
        await this.hookRunner.runModifyingHook("prompt:before", promptEvent);
        // Sanitize hook context to prevent prompt injection (H1 remediation)
        hookAdditionalContext = sanitizeForContext(promptEvent.additionalContext);
      }

      const compactionConfig = this.compactionManager.getConfig();
      const needsMemoryFlush =
        compactionConfig.enabled &&
        compactionConfig.memoryFlushEnabled &&
        context.messages.length > Math.floor((compactionConfig.maxMessages ?? 200) * 0.75);

      const allHookContext = [userHookContext, hookAdditionalContext, hookMessageContext]
        .filter(Boolean)
        .join("\n\n");
      const finalContext = additionalContext + (allHookContext ? `\n\n${allHookContext}` : "");

      // Build capabilities summary from tool registry
      let toolCapabilities: string | undefined;
      if (this.toolRegistry) {
        const modules = this.toolRegistry.getAvailableModules();
        const MODULE_LABELS: Record<string, string> = {
          agentic:
            "💰 Agentic Wallet — Create wallets, trade tokens, set rules, withdraw, portfolio management",
          stonfi: "🔄 STON.fi — Token search, quotes, swaps, pools, trending tokens on STON.fi DEX",
          dedust: "🔄 DeDust — Token swaps, pool info, and quotes on DeDust DEX",
          ton: "⛓️ TON Blockchain — Wallet balance, transactions, jetton info, NFTs, staking, smart contracts",
          telegram:
            "📱 Telegram — Send messages, photos, documents, manage chats, groups, stickers, polls, reactions",
          fragment:
            "🏪 Fragment — Gift collections, rarity data, floor prices, marketplace search, OTC matchmaking",
          gift: "🎁 Gift Market — Gift trading, floor prices, portfolio tracking",
          dns: "🌐 TON DNS — Domain lookup, resolve, availability check, pricing",
          journal: "📝 Journal — Log events, query history, track activities",
          workspace: "📁 Workspace — Read, write, list, manage files in your workspace",
          web: "🌍 Web — Search the internet, fetch web pages",
          bot: "🤖 Bot Management — Bot settings and configuration",
          marketplace: "🛒 Marketplace — Search and compare prices across Fragment, Getgems, etc.",
          alpha: "📡 Alpha Radar — Monitor mentions, detect alpha signals",
          whale: "🐋 Whale Watcher — Track large transactions and whale movements",
          portfolio: "📊 Portfolio — Track token holdings and portfolio value",
          soul: "🧠 Soul — Read and update personality and behavior",
          skill: "🔧 Skills — Install, list, remove custom plugins",
          memory: "🧠 Memory — Save and recall persistent information",
        };

        const lines: string[] = [];
        let totalTools = 0;
        for (const mod of modules) {
          const count = this.toolRegistry.getModuleToolCount(mod);
          totalTools += count;
          const label = MODULE_LABELS[mod] || `${mod} (${count} tools)`;
          lines.push(`- ${label} (${count} tools)`);
        }
        lines.unshift(`**${totalTools} tools across ${modules.length} modules:**\n`);
        toolCapabilities = lines.join("\n");
      }

      // Use per-user effective config for model info in system prompt
      const effectiveForPrompt = this.getEffectiveAgentConfig(toolContext?.senderId);
      const systemPrompt = buildSystemPrompt({
        soul: this.soul,
        userName,
        senderUsername,
        senderId: toolContext?.senderId,
        ownerName: this.config.telegram.owner_name,
        ownerUsername: this.config.telegram.owner_username,
        context: finalContext,
        includeMemory: !effectiveIsGroup,
        includeStrategy: !effectiveIsGroup,
        memoryFlushWarning: needsMemoryFlush,
        modelInfo: `${effectiveForPrompt.provider || "anthropic"}/${effectiveForPrompt.model}`,
        toolCapabilities,
      });

      // Hook: prompt:after — observing, analytics on prompt size
      if (this.hookRunner) {
        const promptAfterEvent: PromptAfterEvent = {
          chatId,
          sessionId: session.sessionId,
          isGroup: effectiveIsGroup,
          promptLength: systemPrompt.length,
          sectionCount: (systemPrompt.match(/^#{1,3} /gm) || []).length,
          ragContextLength: relevantContext.length,
          hookContextLength: allHookContext.length,
        };
        await this.hookRunner.runObservingHook("prompt:after", promptAfterEvent);
      }

      // Build user message — include image content for vision if available
      const userMsg: UserMessage =
        imageBase64 && imageMimeType
          ? {
              role: "user",
              content: [
                { type: "text" as const, text: formattedMessage },
                { type: "image" as const, data: imageBase64, mimeType: imageMimeType },
              ],
              timestamp: now,
            }
          : {
              role: "user",
              content: formattedMessage,
              timestamp: now,
            };

      context.messages.push(userMsg);

      const preemptiveCompaction = await this.compactionManager.checkAndCompact(
        session.sessionId,
        context,
        getEffectiveApiKey(this.config.agent.provider, this.config.agent.api_key),
        chatId,
        this.config.agent.provider as SupportedProvider,
        this.config.agent.utility_model
      );
      if (preemptiveCompaction) {
        log.info(`🗜️  Preemptive compaction triggered, reloading session...`);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- session guaranteed to exist after compaction
        session = getSession(chatId)!;
        context = loadContextFromTranscript(session.sessionId);
        context.messages.push(userMsg);
      }

      appendToTranscript(session.sessionId, userMsg);

      const provider = (this.config.agent.provider || "anthropic") as SupportedProvider;
      const providerMeta = getProviderMetadata(provider);
      const isAdmin =
        toolContext?.config?.telegram.admin_ids.includes(toolContext.senderId) ?? false;

      let tools: PiAiTool[] | undefined;
      {
        const toolIndex = this.toolRegistry?.getToolIndex();
        const useRAG =
          toolIndex?.isIndexed &&
          this.config.tool_rag?.enabled !== false &&
          !isTrivialMessage(effectiveMessage) &&
          !(
            providerMeta.toolLimit === null &&
            this.config.tool_rag?.skip_unlimited_providers !== false
          );

        if (useRAG && this.toolRegistry && queryEmbedding) {
          tools = await this.toolRegistry.getForContextWithRAG(
            effectiveMessage,
            queryEmbedding,
            effectiveIsGroup,
            providerMeta.toolLimit,
            chatId,
            isAdmin
          );
          log.info(`🔍 Tool RAG: ${tools.length}/${this.toolRegistry.count} tools selected`);
        } else {
          tools = this.toolRegistry?.getForContext(
            effectiveIsGroup,
            providerMeta.toolLimit,
            chatId,
            isAdmin
          );
          log.info(
            `📦 Tools bypass RAG: ${tools?.length ?? 0}/${this.toolRegistry?.count ?? 0} tools sent to LLM (toolLimit=${providerMeta.toolLimit}, isGroup=${effectiveIsGroup}, isAdmin=${isAdmin})`
          );
        }
      }

      const maxIterations = this.config.agent.max_agentic_iterations || 5;
      let iteration = 0;
      let overflowResets = 0;
      let rateLimitRetries = 0;
      let serverErrorRetries = 0;
      let finalResponse: ChatResponse | null = null;
      const totalToolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
      const accumulatedTexts: string[] = [];
      const accumulatedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 };
      const seenToolSignatures = new Set<string>();

      interface ToolPlan {
        block: ToolCall;
        blocked: boolean;
        blockReason: string;
        params: Record<string, unknown>;
      }
      interface ToolExecResult {
        result: { success: boolean; data?: unknown; error?: string };
        durationMs: number;
        execError?: { message: string; stack?: string };
      }

      while (iteration < maxIterations) {
        iteration++;
        log.debug(`🔄 Agentic iteration ${iteration}/${maxIterations}`);

        // Track where current iteration starts so masking won't truncate its results
        const iterationStartIndex = context.messages.length;

        const maskedMessages = maskOldToolResults(context.messages, {
          toolRegistry: this.toolRegistry ?? undefined,
          currentIterationStartIndex: iterationStartIndex,
        });
        const maskedContext: Context = { ...context, messages: maskedMessages };

        // Per-user API key override
        const effectiveAgentConfig = this.getEffectiveAgentConfig(toolContext?.senderId);

        const response: ChatResponse = await chatWithContext(effectiveAgentConfig, {
          systemPrompt,
          context: maskedContext,
          sessionId: session.sessionId,
          persistTranscript: true,
          tools,
        });

        const assistantMsg = response.message;
        if (assistantMsg.stopReason === "error") {
          const errorMsg = assistantMsg.errorMessage || "";

          // Hook: response:error — fire on all LLM errors
          if (this.hookRunner) {
            const errorCode =
              errorMsg.includes("429") || errorMsg.toLowerCase().includes("rate")
                ? "RATE_LIMIT"
                : isContextOverflowError(errorMsg)
                  ? "CONTEXT_OVERFLOW"
                  : errorMsg.includes("500") || errorMsg.includes("502") || errorMsg.includes("503")
                    ? "PROVIDER_ERROR"
                    : "UNKNOWN";
            const responseErrorEvent: ResponseErrorEvent = {
              chatId,
              sessionId: session.sessionId,
              isGroup: effectiveIsGroup,
              error: errorMsg,
              errorCode,
              provider: provider,
              model: this.config.agent.model,
              retryCount: rateLimitRetries + serverErrorRetries,
              durationMs: Date.now() - processStartTime,
            };
            await this.hookRunner.runObservingHook("response:error", responseErrorEvent);
          }

          if (isContextOverflowError(errorMsg)) {
            overflowResets++;
            if (overflowResets > 1) {
              throw new Error(
                "Our conversation got too long — send /reset to start fresh, then try again 🦞"
              );
            }
            log.error(`🚨 Context overflow detected: ${errorMsg}`);

            log.info(`💾 Saving session memory before reset...`);
            const summary = extractContextSummary(context, CONTEXT_OVERFLOW_SUMMARY_MESSAGES);
            appendToDailyLog(summary);
            log.info(`✅ Memory saved to daily log`);

            const archived = archiveTranscript(session.sessionId);
            if (!archived) {
              log.error(
                `⚠️  Failed to archive transcript ${session.sessionId}, proceeding with reset anyway`
              );
            }

            log.info(`🔄 Resetting session due to context overflow...`);
            session = resetSession(chatId);

            context = { messages: [userMsg] };

            appendToTranscript(session.sessionId, userMsg);

            log.info(`🔄 Retrying with fresh context...`);
            continue;
          } else if (errorMsg.toLowerCase().includes("rate") || errorMsg.includes("429")) {
            rateLimitRetries++;
            if (rateLimitRetries <= RATE_LIMIT_MAX_RETRIES) {
              const delay = 1000 * Math.pow(2, rateLimitRetries - 1);
              log.warn(
                `🚫 Rate limited, retrying in ${delay}ms (attempt ${rateLimitRetries}/${RATE_LIMIT_MAX_RETRIES})...`
              );
              await new Promise((r) => setTimeout(r, delay));
              iteration--;
              continue;
            }
            log.error(`🚫 Rate limited after ${RATE_LIMIT_MAX_RETRIES} retries: ${errorMsg}`);
            throw new Error(
              `Rate limited 🚫 Try switching to another model with /models or wait a moment and try again.`
            );
          } else if (
            errorMsg.includes("500") ||
            errorMsg.includes("502") ||
            errorMsg.includes("503") ||
            errorMsg.includes("529")
          ) {
            serverErrorRetries++;
            if (serverErrorRetries <= SERVER_ERROR_MAX_RETRIES) {
              const delay = 2000 * Math.pow(2, serverErrorRetries - 1);
              log.warn(
                `🔄 Server error, retrying in ${delay}ms (attempt ${serverErrorRetries}/${SERVER_ERROR_MAX_RETRIES})...`
              );
              await new Promise((r) => setTimeout(r, delay));
              iteration--;
              continue;
            }
            log.error(`🚨 Server error after ${SERVER_ERROR_MAX_RETRIES} retries: ${errorMsg}`);
            throw new Error(`Something's off on my end right now — try again in a minute 🦞`);
          } else {
            log.error(`🚨 API error: ${errorMsg}`);
            // User-friendly error with model switch hint
            const switchHint =
              errorMsg.includes("scope") ||
              errorMsg.includes("unauthorized") ||
              errorMsg.includes("401") ||
              errorMsg.includes("403")
                ? `\n\nYour current provider may not support this. Use /models to switch or /addprovider to set up a different one.`
                : "";
            throw new Error(`API error: ${errorMsg || "Unknown error"}${switchHint}`);
          }
        }

        // Accumulate usage across all iterations
        const iterUsage = response.message.usage;
        if (iterUsage) {
          accumulatedUsage.input += iterUsage.input;
          accumulatedUsage.output += iterUsage.output;
          accumulatedUsage.cacheRead += iterUsage.cacheRead ?? 0;
          accumulatedUsage.cacheWrite += iterUsage.cacheWrite ?? 0;
          accumulatedUsage.totalCost += iterUsage.cost?.total ?? 0;
        }

        if (response.text) {
          accumulatedTexts.push(response.text);
        }

        const toolCalls = response.message.content.filter((block) => block.type === "toolCall");

        if (toolCalls.length === 0) {
          log.info(`🔄 ${iteration}/${maxIterations} → done`);
          finalResponse = response;
          break;
        }

        if (!this.toolRegistry || !toolContext) {
          log.error("⚠️ Cannot execute tools: registry or context missing");
          break;
        }

        log.debug(`🔧 Executing ${toolCalls.length} tool call(s)`);

        context.messages.push(response.message);

        const iterationToolNames: string[] = [];

        const fullContext: ToolContext = {
          ...toolContext,
          chatId,
          isGroup: effectiveIsGroup,
        };

        // Phase 1: Run tool:before hooks sequentially (hooks may cross-reference)
        const toolPlans: ToolPlan[] = [];

        for (const block of toolCalls) {
          if (block.type !== "toolCall") continue;

          let toolParams = (block.arguments ?? {}) as Record<string, unknown>;
          let blocked = false;
          let blockReason = "";

          if (this.hookRunner) {
            const beforeEvent: BeforeToolCallEvent = {
              toolName: block.name,
              params: structuredClone(toolParams),
              chatId,
              isGroup: effectiveIsGroup,
              block: false,
              blockReason: "",
            };
            await this.hookRunner.runModifyingHook("tool:before", beforeEvent);
            if (beforeEvent.block) {
              blocked = true;
              blockReason = beforeEvent.blockReason || "Blocked by plugin hook";
            } else {
              toolParams = structuredClone(beforeEvent.params) as Record<string, unknown>;
            }
          }

          toolPlans.push({ block, blocked, blockReason, params: toolParams });
        }

        // Phase 2: Execute tools with concurrency limit (blocked tools resolve instantly)
        const execResults: ToolExecResult[] = new Array(toolPlans.length);
        {
          let cursor = 0;
          const runWorker = async (): Promise<void> => {
            while (cursor < toolPlans.length) {
              const idx = cursor++;
              const plan = toolPlans[idx];

              if (plan.blocked) {
                execResults[idx] = {
                  result: { success: false, error: plan.blockReason },
                  durationMs: 0,
                };
                continue;
              }

              const startTime = Date.now();
              try {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- registry checked at line 687
                const result = await this.toolRegistry!.execute(
                  { ...plan.block, arguments: plan.params },
                  fullContext
                );
                execResults[idx] = { result, durationMs: Date.now() - startTime };
              } catch (execErr) {
                const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
                const errStack = execErr instanceof Error ? execErr.stack : undefined;
                execResults[idx] = {
                  result: { success: false, error: errMsg },
                  durationMs: Date.now() - startTime,
                  execError: { message: errMsg, stack: errStack },
                };
              }
            }
          };
          const workers = Math.min(TOOL_CONCURRENCY_LIMIT, toolPlans.length);
          await Promise.all(Array.from({ length: workers }, () => runWorker()));
        }

        // Phase 3: Process results in original order (hooks, context, transcript)
        for (let i = 0; i < toolPlans.length; i++) {
          const plan = toolPlans[i];
          const { block } = plan;
          const exec = execResults[i];

          // Hook: tool:error (if execution threw)
          if (exec.execError && this.hookRunner) {
            const errorEvent: ToolErrorEvent = {
              toolName: block.name,
              params: structuredClone(plan.params),
              error: exec.execError.message,
              stack: exec.execError.stack,
              chatId,
              isGroup: effectiveIsGroup,
              durationMs: exec.durationMs,
            };
            await this.hookRunner.runObservingHook("tool:error", errorEvent);
          }

          // Hook: tool:after (fires for all cases including blocks)
          if (this.hookRunner) {
            const afterEvent: AfterToolCallEvent = {
              toolName: block.name,
              params: structuredClone(plan.params),
              result: {
                success: exec.result.success,
                data: exec.result.data,
                error: exec.result.error,
              },
              durationMs: exec.durationMs,
              chatId,
              isGroup: effectiveIsGroup,
              ...(plan.blocked ? { blocked: true, blockReason: plan.blockReason } : {}),
            };
            await this.hookRunner.runObservingHook("tool:after", afterEvent);
          }

          log.debug(`${block.name}: ${exec.result.success ? "✓" : "✗"} ${exec.result.error || ""}`);
          iterationToolNames.push(`${block.name} ${exec.result.success ? "✓" : "✗"}`);

          // ── Matchmaker DM Notifications ──
          if (exec.result.success && exec.result.data && toolContext) {
            const data = exec.result.data as Record<string, unknown>;
            const bridge = toolContext.bridge;

            // Notify matching buyers (from mm_list_username)
            if (Array.isArray(data._notifyBuyers)) {
              for (const n of data._notifyBuyers as Array<{ userId: number; message: string }>) {
                bridge
                  .sendMessage({ chatId: String(n.userId), text: n.message })
                  .catch((err) => log.warn({ err, userId: n.userId }, "Failed to notify buyer"));
              }
              delete data._notifyBuyers; // Strip from result before sending to model
            }

            // Notify seller (from mm_express_interest)
            if (data._notifySeller && typeof data._notifySeller === "object") {
              const ns = data._notifySeller as { userId: number; message: string };
              bridge
                .sendMessage({ chatId: String(ns.userId), text: ns.message })
                .catch((err) => log.warn({ err, userId: ns.userId }, "Failed to notify seller"));
              delete data._notifySeller; // Strip from result
            }
          }

          totalToolCalls.push({
            name: block.name,
            input: block.arguments,
          });

          let resultText = JSON.stringify(exec.result);
          if (resultText.length > MAX_TOOL_RESULT_SIZE) {
            log.warn(`⚠️ Tool result too large (${resultText.length} chars), truncating...`);
            const data = exec.result.data as Record<string, unknown> | undefined;
            if (data?.summary || data?.message) {
              resultText = JSON.stringify({
                success: exec.result.success,
                data: {
                  summary: data.summary || data.message,
                  _truncated: true,
                  _originalSize: resultText.length,
                  _message: "Full data truncated. Use limit parameter for smaller results.",
                },
              });
            } else {
              // Build a valid JSON summary instead of raw-slicing (which breaks JSON)
              const summarized: Record<string, unknown> = {
                _truncated: true,
                _originalSize: resultText.length,
                _message: "Full data truncated. Use limit parameter for smaller results.",
              };
              if (data && typeof data === "object") {
                for (const [key, value] of Object.entries(data)) {
                  if (Array.isArray(value)) {
                    summarized[key] = `[${value.length} items]`;
                  } else if (typeof value === "string" && value.length > 500) {
                    summarized[key] = value.slice(0, 500) + "...[truncated]";
                  } else {
                    summarized[key] = value;
                  }
                }
              }
              resultText = JSON.stringify({ success: exec.result.success, data: summarized });
            }
          }

          if (provider === "cocoon") {
            const { wrapToolResult } = await import("../cocoon/tool-adapter.js");
            const cocoonResultMsg: UserMessage = {
              role: "user",
              content: [
                {
                  type: "text",
                  text: wrapToolResult(resultText),
                },
              ],
              timestamp: Date.now(),
            };
            context.messages.push(cocoonResultMsg);
            appendToTranscript(session.sessionId, cocoonResultMsg);
          } else {
            const toolResultMsg: ToolResultMessage = {
              role: "toolResult",
              toolCallId: block.id,
              toolName: block.name,
              content: [
                {
                  type: "text",
                  text: resultText,
                },
              ],
              isError: !exec.result.success,
              timestamp: Date.now(),
            };
            context.messages.push(toolResultMsg);
            appendToTranscript(session.sessionId, toolResultMsg);
          }
        }

        log.info(`🔄 ${iteration}/${maxIterations} → ${iterationToolNames.join(", ")}`);

        // Stall detection: break early if all tool calls are duplicates from prior iterations
        const iterSignatures = toolPlans.map(
          (p) => `${p.block.name}:${JSON.stringify(p.params, Object.keys(p.params).sort())}`
        );
        const allDuplicates =
          iterSignatures.length > 0 && iterSignatures.every((sig) => seenToolSignatures.has(sig));
        for (const sig of iterSignatures) seenToolSignatures.add(sig);

        if (allDuplicates) {
          log.warn(
            `🔁 Loop stall detected: all ${iterSignatures.length} tool call(s) are repeats — breaking early`
          );
          finalResponse = response;
          break;
        }

        if (iteration === maxIterations) {
          log.info(`⚠️ Max iterations reached (${maxIterations})`);
          finalResponse = response;
        }
      }

      if (!finalResponse) {
        log.error("⚠️ Agentic loop exited early without final response");
        return {
          content: "Something went wrong on my end — try again in a moment 🦞",
          toolCalls: [],
        };
      }

      const response = finalResponse;

      const lastMsg = context.messages[context.messages.length - 1];
      if (lastMsg?.role !== "assistant") {
        context.messages.push(response.message);
      }

      // Post-loop compaction deferred: the pre-loop check at the start of the next
      // processMessage() will handle it, avoiding AI summarization latency on response delivery.

      const sessionUpdate: Parameters<typeof updateSession>[1] = {
        updatedAt: Date.now(),
        messageCount: session.messageCount + 1,
        model: this.config.agent.model,
        provider: this.config.agent.provider,
        inputTokens:
          (session.inputTokens ?? 0) +
          accumulatedUsage.input +
          accumulatedUsage.cacheRead +
          accumulatedUsage.cacheWrite,
        outputTokens: (session.outputTokens ?? 0) + accumulatedUsage.output,
      };
      updateSession(chatId, sessionUpdate);

      if (accumulatedUsage.input > 0 || accumulatedUsage.output > 0) {
        const u = accumulatedUsage;
        const totalInput = u.input + u.cacheRead + u.cacheWrite;
        const inK = (totalInput / 1000).toFixed(1);
        const cacheParts: string[] = [];
        if (u.cacheRead) cacheParts.push(`${(u.cacheRead / 1000).toFixed(1)}K cached`);
        if (u.cacheWrite) cacheParts.push(`${(u.cacheWrite / 1000).toFixed(1)}K new`);
        const cacheInfo = cacheParts.length > 0 ? ` (${cacheParts.join(", ")})` : "";
        log.info(`💰 ${inK}K in${cacheInfo}, ${u.output} out | $${u.totalCost.toFixed(3)}`);

        globalTokenUsage.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
        globalTokenUsage.totalCost += u.totalCost;
      }

      let content = accumulatedTexts.join("\n").trim() || response.text;

      const usedTelegramSendTool = totalToolCalls.some((tc) => TELEGRAM_SEND_TOOLS.has(tc.name));

      if (!content && totalToolCalls.length > 0 && !usedTelegramSendTool) {
        log.warn("⚠️ Empty response after tool calls - generating fallback");
        content =
          "I executed the requested action but couldn't generate a response. Please try again.";
      } else if (!content && usedTelegramSendTool) {
        log.info("✅ Response sent via Telegram tool - no additional text needed");
        content = "";
      } else if (!content && accumulatedUsage.input === 0 && accumulatedUsage.output === 0) {
        log.warn("⚠️ Empty response with zero tokens - possible API issue");
        content = "I couldn't process your request. Please try again.";
      } else if (!content && totalToolCalls.length === 0) {
        log.warn("⚠️ Empty response with no tool calls - model returned nothing");
        content = "Hmm, I didn't catch that. Could you try rephrasing?";
      }

      // Hook: response:before — plugins can mutate or block the response text
      let responseMetadata: Record<string, unknown> = {};
      if (this.hookRunner) {
        const responseBeforeEvent: ResponseBeforeEvent = {
          chatId,
          sessionId: session.sessionId,
          isGroup: effectiveIsGroup,
          originalText: content,
          text: content,
          block: false,
          blockReason: "",
          metadata: {},
        };
        await this.hookRunner.runModifyingHook("response:before", responseBeforeEvent);
        if (responseBeforeEvent.block) {
          log.info(
            `🚫 Response blocked by hook: ${responseBeforeEvent.blockReason || "no reason"}`
          );
          content = "";
        } else {
          content = responseBeforeEvent.text;
        }
        responseMetadata = responseBeforeEvent.metadata;
      }

      // Hook: response:after — analytics, billing, feedback
      if (this.hookRunner) {
        const responseAfterEvent: ResponseAfterEvent = {
          chatId,
          sessionId: session.sessionId,
          isGroup: effectiveIsGroup,
          text: content,
          durationMs: Date.now() - processStartTime,
          toolsUsed: totalToolCalls.map((tc) => tc.name),
          tokenUsage:
            accumulatedUsage.input > 0 || accumulatedUsage.output > 0
              ? { input: accumulatedUsage.input, output: accumulatedUsage.output }
              : undefined,
          metadata: responseMetadata,
        };
        await this.hookRunner.runObservingHook("response:after", responseAfterEvent);
      }

      return {
        content,
        toolCalls: totalToolCalls,
      };
    } catch (error) {
      log.error({ err: error }, "Agent error");
      throw error;
    }
  }

  clearHistory(chatId: string): void {
    const db = getDatabase().getDb();

    db.prepare(
      `DELETE FROM tg_messages_vec WHERE id IN (
        SELECT id FROM tg_messages WHERE chat_id = ?
      )`
    ).run(chatId);

    db.prepare(`DELETE FROM tg_messages WHERE chat_id = ?`).run(chatId);

    resetSession(chatId);

    log.info(`🗑️  Cleared history for chat ${chatId}`);
  }

  getConfig(): Config {
    return this.config;
  }

  /**
   * Get effective agent config for a user — overlays per-user settings on global config.
   */
  private getEffectiveAgentConfig(senderId?: number): Config["agent"] {
    if (!senderId) return this.config.agent;
    try {
      const db = getDatabase().getDb();
      const userSettings = getUserSettings(db, senderId);
      if (!userSettings) return this.config.agent;
      return getEffectiveAgentConfig(this.config.agent, userSettings) as Config["agent"];
    } catch {
      return this.config.agent;
    }
  }

  getActiveChatIds(): string[] {
    const db = getDatabase().getDb();

    const rows = db
      .prepare(
        `
      SELECT DISTINCT chat_id
      FROM tg_messages
      ORDER BY timestamp DESC
    `
      )
      .all() as Array<{ chat_id: string }>;

    return rows.map((r) => r.chat_id);
  }

  setSoul(soul: string): void {
    this.soul = soul;
  }

  configureCompaction(config: {
    enabled?: boolean;
    maxMessages?: number;
    maxTokens?: number;
  }): void {
    this.compactionManager.updateConfig(config);
    log.info({ config: this.compactionManager.getConfig() }, `🗜️  Compaction config updated`);
  }

  getCompactionConfig() {
    return this.compactionManager.getConfig();
  }

  private _memoryStatsCache: {
    data: { totalMessages: number; totalChats: number; knowledgeChunks: number };
    expiry: number;
  } | null = null;

  getMemoryStats(): { totalMessages: number; totalChats: number; knowledgeChunks: number } {
    const now = Date.now();
    if (this._memoryStatsCache && now < this._memoryStatsCache.expiry) {
      return this._memoryStatsCache.data;
    }

    const db = getDatabase().getDb();

    const msgCount = db.prepare(`SELECT COUNT(*) as count FROM tg_messages`).get() as {
      count: number;
    };
    const chatCount = db
      .prepare(`SELECT COUNT(DISTINCT chat_id) as count FROM tg_messages`)
      .get() as {
      count: number;
    };
    const knowledgeCount = db.prepare(`SELECT COUNT(*) as count FROM knowledge`).get() as {
      count: number;
    };

    const data = {
      totalMessages: msgCount.count,
      totalChats: chatCount.count,
      knowledgeChunks: knowledgeCount.count,
    };

    this._memoryStatsCache = { data, expiry: now + 5 * 60 * 1000 };
    return data;
  }
}
