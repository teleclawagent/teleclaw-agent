/**
 * Cron/Reminder tools — schedule messages and recurring tasks.
 * In-process scheduler using setTimeout/setInterval. No external deps.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry, ToolContext } from "../types.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Cron");

// ── Scheduler State ────────────────────────────────────────────────────

interface ScheduledJob {
  id: string;
  chatId: string;
  message: string;
  triggerAt: number;
  recurring?: boolean;
  intervalMs?: number;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  createdAt: number;
}

const jobs = new Map<string, ScheduledJob>();
let jobCounter = 0;

function generateJobId(): string {
  jobCounter++;
  return `job_${Date.now()}_${jobCounter}`;
}

// ── reminder_set ───────────────────────────────────────────────────────

interface ReminderSetParams {
  message: string;
  delay_minutes?: number;
  at?: string;
}

const reminderSetTool: Tool = {
  name: "reminder_set",
  description:
    "Set a one-time reminder. Sends a message to the chat after a delay or at a specific time. " +
    "Use delay_minutes for relative timing (e.g. 30 = remind in 30 minutes) " +
    "or 'at' for absolute time (ISO-8601 format).",
  parameters: Type.Object({
    message: Type.String({ description: "Reminder message to send" }),
    delay_minutes: Type.Optional(
      Type.Number({ description: "Minutes from now (e.g. 30, 60, 1440 for 1 day)" })
    ),
    at: Type.Optional(
      Type.String({ description: "Absolute time in ISO-8601 (e.g. '2026-03-25T10:00:00+03:00')" })
    ),
  }),
};

const reminderSetExecutor: ToolExecutor<ReminderSetParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    let delayMs: number;

    if (params.at) {
      const targetTime = new Date(params.at).getTime();
      if (isNaN(targetTime)) {
        return { success: false, error: "Invalid date format. Use ISO-8601." };
      }
      delayMs = targetTime - Date.now();
      if (delayMs < 0) {
        return { success: false, error: "Time is in the past." };
      }
    } else if (params.delay_minutes) {
      if (params.delay_minutes <= 0) {
        return { success: false, error: "delay_minutes must be positive." };
      }
      delayMs = params.delay_minutes * 60 * 1000;
    } else {
      return { success: false, error: "Provide either delay_minutes or at." };
    }

    // Cap at 30 days
    if (delayMs > 30 * 24 * 60 * 60 * 1000) {
      return { success: false, error: "Maximum reminder delay is 30 days." };
    }

    const jobId = generateJobId();
    const triggerAt = Date.now() + delayMs;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          await context.bridge.sendMessage({
            chatId: context.chatId,
            text: `⏰ **Reminder**\n\n${params.message}`,
          });
        } catch (err) {
          log.error({ err }, `Failed to send reminder ${jobId}`);
        }
        jobs.delete(jobId);
      })();
    }, delayMs);

    jobs.set(jobId, {
      id: jobId,
      chatId: context.chatId,
      message: params.message,
      triggerAt,
      timer,
      createdAt: Date.now(),
    });

    const triggerDate = new Date(triggerAt);
    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const timeStr = triggerDate.toLocaleString("en-GB", {
      timeZone: userTz,
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });

    return {
      success: true,
      data: {
        id: jobId,
        message: params.message,
        triggerAt: triggerDate.toISOString(),
        triggerAtLocal: timeStr,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── cron_schedule ──────────────────────────────────────────────────────

interface CronScheduleParams {
  message: string;
  interval_minutes: number;
}

const cronScheduleTool: Tool = {
  name: "cron_schedule",
  description:
    "Schedule a recurring message at a fixed interval. " +
    "The message will be sent repeatedly every N minutes until cancelled.",
  parameters: Type.Object({
    message: Type.String({ description: "Message to send on each trigger" }),
    interval_minutes: Type.Number({
      description: "Interval in minutes (min: 1, max: 10080 = 1 week)",
    }),
  }),
};

const cronScheduleExecutor: ToolExecutor<CronScheduleParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    if (params.interval_minutes < 1 || params.interval_minutes > 10080) {
      return { success: false, error: "interval_minutes must be between 1 and 10080." };
    }

    const intervalMs = params.interval_minutes * 60 * 1000;
    const jobId = generateJobId();

    const timer = setInterval(() => {
      void (async () => {
        try {
          await context.bridge.sendMessage({
            chatId: context.chatId,
            text: `🔄 **Scheduled**\n\n${params.message}`,
          });
        } catch (err) {
          log.error({ err }, `Failed to send cron ${jobId}`);
        }
      })();
    }, intervalMs);

    jobs.set(jobId, {
      id: jobId,
      chatId: context.chatId,
      message: params.message,
      triggerAt: Date.now() + intervalMs,
      recurring: true,
      intervalMs,
      timer,
      createdAt: Date.now(),
    });

    return {
      success: true,
      data: {
        id: jobId,
        message: params.message,
        intervalMinutes: params.interval_minutes,
        recurring: true,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── cron_list ──────────────────────────────────────────────────────────

const cronListTool: Tool = {
  name: "cron_list",
  description: "List all active reminders and scheduled jobs.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

const cronListExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context: ToolContext
): Promise<ToolResult> => {
  const chatJobs = Array.from(jobs.values()).filter((j) => j.chatId === context.chatId);

  if (chatJobs.length === 0) {
    return { success: true, data: { jobs: [], message: "No active jobs." } };
  }

  const list = chatJobs.map((j) => ({
    id: j.id,
    message: j.message,
    recurring: j.recurring ?? false,
    triggerAt: new Date(j.triggerAt).toISOString(),
    intervalMinutes: j.intervalMs ? j.intervalMs / 60000 : undefined,
  }));

  return { success: true, data: { jobs: list } };
};

// ── cron_cancel ────────────────────────────────────────────────────────

interface CronCancelParams {
  id: string;
}

const cronCancelTool: Tool = {
  name: "cron_cancel",
  description: "Cancel a reminder or scheduled job by ID.",
  parameters: Type.Object({
    id: Type.String({ description: "Job ID to cancel (from cron_list or reminder_set)" }),
  }),
};

const cronCancelExecutor: ToolExecutor<CronCancelParams> = async (params): Promise<ToolResult> => {
  const job = jobs.get(params.id);
  if (!job) {
    return { success: false, error: `Job not found: ${params.id}` };
  }

  if (job.recurring) {
    clearInterval(job.timer as ReturnType<typeof setInterval>);
  } else {
    clearTimeout(job.timer as ReturnType<typeof setTimeout>);
  }
  jobs.delete(params.id);

  return {
    success: true,
    data: { id: params.id, cancelled: true },
  };
};

// ── Export ──────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: reminderSetTool, executor: reminderSetExecutor },
  { tool: cronScheduleTool, executor: cronScheduleExecutor },
  { tool: cronListTool, executor: cronListExecutor },
  { tool: cronCancelTool, executor: cronCancelExecutor },
];
