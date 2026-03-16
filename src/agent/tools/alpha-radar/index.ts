import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import { randomUUID } from "crypto";
import { getRecentMentions, getUniqueChannelCount } from "./mention-detector.js";
import { refreshMonitoredChannels } from "./monitor.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("AlphaRadar");

const MAX_CHANNELS_PER_USER = 20;
const MAX_TOKENS_PER_USER = 50;

// ─── Tool: Add Channel ───────────────────────────────────────────────

const addChannelTool: Tool = {
  name: "alpha_radar_add_channel",
  description:
    "Add a Telegram channel or group to monitor for token mentions. Alpha Radar silently reads messages in monitored channels and alerts you when tracked tokens are mentioned. Teleclaw NEVER sends messages to monitored channels.",
  parameters: Type.Object({
    chat_id: Type.String({
      description: "Channel/group chat ID (numeric) or @username",
    }),
    title: Type.Optional(
      Type.String({ description: "Friendly name for this channel" })
    ),
  }),
};

const addChannelExecutor: ToolExecutor<{ chat_id: string; title?: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    // Check channel limit
    const channelCount = context.db
      .prepare("SELECT COUNT(*) as count FROM radar_channels WHERE user_id = ? AND active = 1")
      .get(context.senderId) as { count: number };
    if (channelCount.count >= MAX_CHANNELS_PER_USER) {
      return {
        success: false,
        error: `Maximum ${MAX_CHANNELS_PER_USER} channels allowed. Remove some first.`,
      };
    }

    const id = randomUUID();

    // Verify Teleclaw is actually in this channel/group
    try {
      const messages = await context.bridge.getMessages(params.chat_id, 1);
      if (!messages || messages.length === 0) {
        return {
          success: false,
          error: `Cannot access channel ${params.chat_id}. Make sure Teleclaw has joined this channel/group first.`,
        };
      }
    } catch {
      return {
        success: false,
        error: `Cannot access channel ${params.chat_id}. Teleclaw must be a member of this channel/group to monitor it.`,
      };
    }

    try {
      context.db
        .prepare(
          `INSERT INTO radar_channels (id, user_id, chat_id, chat_title)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, context.senderId, params.chat_id, params.title || null);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        return {
          success: false,
          error: "You're already monitoring this channel.",
        };
      }
      throw error;
    }

    refreshMonitoredChannels(context.db);

    return {
      success: true,
      data: {
        channelId: params.chat_id,
        message: `👁️ Now monitoring ${params.title || params.chat_id}. Messages will be read silently — zero messages sent to that channel.`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Remove Channel ────────────────────────────────────────────

const removeChannelTool: Tool = {
  name: "alpha_radar_remove_channel",
  description: "Stop monitoring a channel.",
  parameters: Type.Object({
    chat_id: Type.String({ description: "Channel chat ID or @username to remove" }),
  }),
};

const removeChannelExecutor: ToolExecutor<{ chat_id: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  const result = context.db
    .prepare("UPDATE radar_channels SET active = 0 WHERE user_id = ? AND chat_id = ?")
    .run(context.senderId, params.chat_id);

  if (result.changes === 0) {
    return { success: false, error: "Channel not found in your monitor list." };
  }

  refreshMonitoredChannels(context.db);
  return {
    success: true,
    data: { message: `Stopped monitoring ${params.chat_id}.` },
  };
};

// ─── Tool: List Channels ─────────────────────────────────────────────

const listChannelsTool: Tool = {
  name: "alpha_radar_list_channels",
  description: "List all channels currently being monitored by Alpha Radar.",
  parameters: Type.Object({}),
};

const listChannelsExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const channels = context.db
    .prepare(
      "SELECT chat_id, chat_title, added_at FROM radar_channels WHERE user_id = ? AND active = 1 ORDER BY added_at DESC"
    )
    .all(context.senderId) as Array<{
    chat_id: string;
    chat_title: string | null;
    added_at: number;
  }>;

  if (channels.length === 0) {
    return {
      success: true,
      data: {
        channels: [],
        message: "No channels being monitored. Use alpha_radar_add_channel to add one.",
      },
    };
  }

  return {
    success: true,
    data: { channels, count: channels.length },
  };
};

// ─── Tool: Track Token ───────────────────────────────────────────────

const trackTokenTool: Tool = {
  name: "alpha_radar_track_token",
  description:
    "Start tracking a token. Alpha Radar will alert you when this token is mentioned in your monitored channels. Use the token symbol (e.g. SCALE, STON, DOGS) or provide the contract address for exact matching.",
  parameters: Type.Object({
    symbol: Type.String({
      description: "Token symbol to track (e.g. SCALE, STON, DOGS, TON)",
    }),
    contract_address: Type.Optional(
      Type.String({
        description: "Jetton contract address for exact matching (EQ... format)",
      })
    ),
  }),
};

const trackTokenExecutor: ToolExecutor<{
  symbol: string;
  contract_address?: string;
}> = async (params, context): Promise<ToolResult> => {
  try {
    // Check token limit
    const tokenCount = context.db
      .prepare("SELECT COUNT(*) as count FROM radar_tokens WHERE user_id = ? AND active = 1")
      .get(context.senderId) as { count: number };
    if (tokenCount.count >= MAX_TOKENS_PER_USER) {
      return {
        success: false,
        error: `Maximum ${MAX_TOKENS_PER_USER} tokens allowed. Remove some first.`,
      };
    }

    const id = randomUUID();
    const symbol = params.symbol.toUpperCase().replace(/^\$/, "");

    // Reject single-character symbols (too many false positives)
    if (symbol.length < 2) {
      return {
        success: false,
        error: "Token symbol must be at least 2 characters.",
      };
    }

    try {
      context.db
        .prepare(
          `INSERT INTO radar_tokens (id, user_id, symbol, contract_address)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, context.senderId, symbol, params.contract_address || null);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        return { success: false, error: `You're already tracking $${symbol}.` };
      }
      throw error;
    }

    return {
      success: true,
      data: {
        symbol,
        message: `📡 Now tracking $${symbol}. You'll get alerts when it's mentioned in your monitored channels.`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Untrack Token ─────────────────────────────────────────────

const untrackTokenTool: Tool = {
  name: "alpha_radar_untrack_token",
  description: "Stop tracking a token.",
  parameters: Type.Object({
    symbol: Type.String({ description: "Token symbol to stop tracking" }),
  }),
};

const untrackTokenExecutor: ToolExecutor<{ symbol: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  const symbol = params.symbol.toUpperCase().replace(/^\$/, "");
  const result = context.db
    .prepare(
      "UPDATE radar_tokens SET active = 0 WHERE user_id = ? AND UPPER(symbol) = ?"
    )
    .run(context.senderId, symbol);

  if (result.changes === 0) {
    return { success: false, error: `$${symbol} not found in your tracking list.` };
  }

  return {
    success: true,
    data: { message: `Stopped tracking $${symbol}.` },
  };
};

// ─── Tool: List Tracked Tokens ───────────────────────────────────────

const listTokensTool: Tool = {
  name: "alpha_radar_list_tokens",
  description: "List all tokens currently being tracked by Alpha Radar.",
  parameters: Type.Object({}),
};

const listTokensExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const tokens = context.db
    .prepare(
      "SELECT symbol, contract_address, added_at FROM radar_tokens WHERE user_id = ? AND active = 1 ORDER BY added_at DESC"
    )
    .all(context.senderId) as Array<{
    symbol: string;
    contract_address: string | null;
    added_at: number;
  }>;

  if (tokens.length === 0) {
    return {
      success: true,
      data: {
        tokens: [],
        message: "No tokens being tracked. Use alpha_radar_track_token to add one.",
      },
    };
  }

  return {
    success: true,
    data: { tokens, count: tokens.length },
  };
};

// ─── Tool: Get Mentions ──────────────────────────────────────────────

const getMentionsTool: Tool = {
  name: "alpha_radar_mentions",
  description:
    "Get recent mentions of a tracked token across all monitored channels. Shows which channels are talking about it, message snippets, and sentiment analysis.",
  category: "data-bearing",
  parameters: Type.Object({
    symbol: Type.String({ description: "Token symbol to check mentions for" }),
    hours: Type.Optional(
      Type.Number({
        description: "How many hours back to look (default 24, max 168)",
        minimum: 1,
        maximum: 168,
      })
    ),
  }),
};

const getMentionsExecutor: ToolExecutor<{ symbol: string; hours?: number }> = async (
  params,
  context
): Promise<ToolResult> => {
  const symbol = params.symbol.toUpperCase().replace(/^\$/, "");
  const hours = params.hours || 24;
  const windowSeconds = hours * 3600;

  const mentions = getRecentMentions(context.db, context.senderId, symbol, windowSeconds);
  const channelCount = getUniqueChannelCount(
    context.db,
    context.senderId,
    symbol,
    windowSeconds
  );

  if (mentions.length === 0) {
    return {
      success: true,
      data: {
        mentions: [],
        message: `No mentions of $${symbol} in the last ${hours} hours.`,
      },
    };
  }

  // Count sentiments
  const sentiments = { bullish: 0, bearish: 0, neutral: 0, news: 0 };
  for (const m of mentions) {
    sentiments[m.sentiment as keyof typeof sentiments]++;
  }

  return {
    success: true,
    data: {
      symbol,
      totalMentions: mentions.length,
      uniqueChannels: channelCount,
      sentiments,
      mentions: mentions.slice(0, 10), // Top 10
      timeWindow: `${hours}h`,
    },
  };
};

// ─── Tool: Set Preferences ───────────────────────────────────────────

const setPreferencesTool: Tool = {
  name: "alpha_radar_preferences",
  description:
    "Configure Alpha Radar alert preferences. Alert modes: 'every' (alert on every mention), 'smart' (alert when token appears in multiple channels — recommended), 'hourly' (summary every hour), 'daily' (summary once a day).",
  parameters: Type.Object({
    alert_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("every"),
          Type.Literal("smart"),
          Type.Literal("hourly"),
          Type.Literal("daily"),
        ],
        { description: "When to send alerts" }
      )
    ),
    min_mentions: Type.Optional(
      Type.Number({
        description:
          "Minimum number of unique channels mentioning a token before alerting (for smart mode). Default: 2",
        minimum: 1,
        maximum: 10,
      })
    ),
    quiet_start: Type.Optional(
      Type.Number({
        description: "Hour to start quiet mode (0-23, default 23). No alerts during quiet hours.",
        minimum: 0,
        maximum: 23,
      })
    ),
    quiet_end: Type.Optional(
      Type.Number({
        description: "Hour to end quiet mode (0-23, default 9).",
        minimum: 0,
        maximum: 23,
      })
    ),
  }),
};

const setPreferencesExecutor: ToolExecutor<{
  alert_mode?: string;
  min_mentions?: number;
  quiet_start?: number;
  quiet_end?: number;
}> = async (params, context): Promise<ToolResult> => {
  try {
    const existing = context.db
      .prepare("SELECT * FROM radar_preferences WHERE user_id = ?")
      .get(context.senderId);

    if (existing) {
      const updates: string[] = [];
      const values: unknown[] = [];

      if (params.alert_mode !== undefined) {
        updates.push("alert_mode = ?");
        values.push(params.alert_mode);
      }
      if (params.min_mentions !== undefined) {
        updates.push("min_mentions = ?");
        values.push(params.min_mentions);
      }
      if (params.quiet_start !== undefined) {
        updates.push("quiet_start = ?");
        values.push(params.quiet_start);
      }
      if (params.quiet_end !== undefined) {
        updates.push("quiet_end = ?");
        values.push(params.quiet_end);
      }

      if (updates.length > 0) {
        updates.push("updated_at = unixepoch()");
        context.db
          .prepare(
            `UPDATE radar_preferences SET ${updates.join(", ")} WHERE user_id = ?`
          )
          .run(...values, context.senderId);
      }
    } else {
      context.db
        .prepare(
          `INSERT INTO radar_preferences (user_id, alert_mode, min_mentions, quiet_start, quiet_end)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          context.senderId,
          params.alert_mode || "smart",
          params.min_mentions || 2,
          params.quiet_start ?? 23,
          params.quiet_end ?? 9
        );
    }

    return {
      success: true,
      data: {
        message: `✅ Alpha Radar preferences updated.${params.alert_mode ? ` Mode: ${params.alert_mode}` : ""}${params.min_mentions ? ` Min mentions: ${params.min_mentions}` : ""}${params.quiet_start !== undefined ? ` Quiet: ${params.quiet_start}:00-${params.quiet_end ?? 9}:00` : ""}`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Radar Status ──────────────────────────────────────────────

const radarStatusTool: Tool = {
  name: "alpha_radar_status",
  description: "Show Alpha Radar status — monitored channels, tracked tokens, recent alert stats.",
  parameters: Type.Object({}),
};

const radarStatusExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const channels = context.db
    .prepare(
      "SELECT COUNT(*) as count FROM radar_channels WHERE user_id = ? AND active = 1"
    )
    .get(context.senderId) as { count: number };

  const tokens = context.db
    .prepare(
      "SELECT COUNT(*) as count FROM radar_tokens WHERE user_id = ? AND active = 1"
    )
    .get(context.senderId) as { count: number };

  const last24h = Math.floor(Date.now() / 1000) - 86400;
  const mentionsToday = context.db
    .prepare(
      "SELECT COUNT(*) as count FROM radar_mentions WHERE user_id = ? AND detected_at >= ?"
    )
    .get(context.senderId, last24h) as { count: number };

  const alertsToday = context.db
    .prepare(
      "SELECT COUNT(*) as count FROM radar_alerts WHERE user_id = ? AND sent_at >= ?"
    )
    .get(context.senderId, last24h) as { count: number };

  const prefs = context.db
    .prepare("SELECT * FROM radar_preferences WHERE user_id = ?")
    .get(context.senderId) as {
    alert_mode: string;
    min_mentions: number;
    quiet_start: number;
    quiet_end: number;
  } | undefined;

  return {
    success: true,
    data: {
      channels: channels.count,
      tokens: tokens.count,
      mentionsLast24h: mentionsToday.count,
      alertsLast24h: alertsToday.count,
      preferences: prefs || { alert_mode: "smart", min_mentions: 2, quiet_start: 23, quiet_end: 9 },
      message:
        `📡 **Alpha Radar Status**\n\n` +
        `Channels monitored: ${channels.count}\n` +
        `Tokens tracked: ${tokens.count}\n` +
        `Mentions (24h): ${mentionsToday.count}\n` +
        `Alerts sent (24h): ${alertsToday.count}\n` +
        `Mode: ${prefs?.alert_mode || "smart"}\n` +
        `Quiet hours: ${prefs?.quiet_start ?? 23}:00 - ${prefs?.quiet_end ?? 9}:00`,
    },
  };
};

// ─── Export All Tools ────────────────────────────────────────────────

export { migrateAlphaRadar } from "./schema.js";
export { startAlphaRadar, stopAlphaRadar } from "./monitor.js";

export const tools: ToolEntry[] = [
  // Channel management
  { tool: addChannelTool, executor: addChannelExecutor, scope: "dm-only" },
  { tool: removeChannelTool, executor: removeChannelExecutor, scope: "dm-only" },
  { tool: listChannelsTool, executor: listChannelsExecutor, scope: "dm-only" },
  // Token tracking
  { tool: trackTokenTool, executor: trackTokenExecutor, scope: "dm-only" },
  { tool: untrackTokenTool, executor: untrackTokenExecutor, scope: "dm-only" },
  { tool: listTokensTool, executor: listTokensExecutor, scope: "dm-only" },
  // Intelligence
  { tool: getMentionsTool, executor: getMentionsExecutor, scope: "dm-only" },
  // Preferences
  { tool: setPreferencesTool, executor: setPreferencesExecutor, scope: "dm-only" },
  // Status
  { tool: radarStatusTool, executor: radarStatusExecutor, scope: "dm-only" },
];
