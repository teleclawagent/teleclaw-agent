/**
 * Sub-agent tools — spawn parallel LLM tasks for heavy work.
 * Each sub-agent runs as a separate completion call with its own context.
 * Results are collected and returned to the main agent.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry, ToolContext } from "../types.js";
import { chatWithContext } from "../../client.js";
import { getProviderMetadata, type SupportedProvider } from "../../../config/providers.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("SubAgent");

// Track active sub-agents per chat
const activeAgents = new Map<string, Set<string>>();
const MAX_CONCURRENT = 3;
let agentCounter = 0;

// ── subagent_spawn ─────────────────────────────────────────────────────

interface SubAgentSpawnParams {
  task: string;
  context?: string;
}

const subAgentSpawnTool: Tool = {
  name: "subagent_spawn",
  description:
    "Spawn a sub-agent to handle a task in parallel. The sub-agent gets its own LLM call " +
    "with the given task and optional context. Returns the sub-agent's response. " +
    "Use for: research, summarization, content generation, data analysis. " +
    "Max 3 concurrent sub-agents per chat.",
  parameters: Type.Object({
    task: Type.String({ description: "Task description for the sub-agent" }),
    context: Type.Optional(
      Type.String({ description: "Additional context or data for the sub-agent" })
    ),
  }),
};

const subAgentSpawnExecutor: ToolExecutor<SubAgentSpawnParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    // Check concurrent limit
    const chatAgents = activeAgents.get(context.chatId) ?? new Set();
    if (chatAgents.size >= MAX_CONCURRENT) {
      return {
        success: false,
        error: `Max ${MAX_CONCURRENT} concurrent sub-agents. Wait for active ones to finish.`,
      };
    }

    agentCounter++;
    const agentId = `sa_${agentCounter}`;
    chatAgents.add(agentId);
    activeAgents.set(context.chatId, chatAgents);

    const config = context.config;
    if (!config) {
      chatAgents.delete(agentId);
      return { success: false, error: "Config not available" };
    }

    // Use utility model for sub-agents (cheaper)
    const provider = config.agent.provider as SupportedProvider;
    const meta = getProviderMetadata(provider);
    const utilityModel = config.agent.utility_model ?? meta.utilityModel;

    const systemPrompt =
      "You are a focused sub-agent. Complete the given task precisely and concisely. " +
      "Return only the result, no preamble.";

    let userMessage = `Task: ${params.task}`;
    if (params.context) {
      userMessage += `\n\nContext:\n${params.context}`;
    }

    log.info({ agentId, task: params.task.slice(0, 100) }, "Spawning sub-agent");

    const startTime = Date.now();

    try {
      const response = await chatWithContext(
        {
          ...config.agent,
          model: utilityModel,
          max_tokens: 4096,
        },
        {
          systemPrompt,
          context: {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: userMessage }],
                timestamp: Date.now(),
              },
            ],
          },
        }
      );

      const elapsed = Date.now() - startTime;
      log.info({ agentId, elapsed }, "Sub-agent completed");

      return {
        success: true,
        data: {
          agentId,
          result: response.text,
          model: utilityModel,
          durationMs: elapsed,
        },
      };
    } finally {
      // Always clean up — prevents permanent "max 3" lockout on errors
      chatAgents.delete(agentId);
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── subagent_list ──────────────────────────────────────────────────────

const subAgentListTool: Tool = {
  name: "subagent_list",
  description: "List currently active sub-agents in this chat.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

const subAgentListExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context: ToolContext
): Promise<ToolResult> => {
  const chatAgents = activeAgents.get(context.chatId);
  const active = chatAgents ? Array.from(chatAgents) : [];

  return {
    success: true,
    data: {
      active,
      count: active.length,
      maxConcurrent: MAX_CONCURRENT,
    },
  };
};

// ── Export ──────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: subAgentSpawnTool, executor: subAgentSpawnExecutor },
  { tool: subAgentListTool, executor: subAgentListExecutor },
];
