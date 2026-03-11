/**
 * SQLite row types for database queries.
 * These represent the raw column types as returned by better-sqlite3.
 */

export interface TaskRow {
  id: string;
  description: string;
  status: string;
  priority: number;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
  scheduled_for: number | null;
  payload: string | null;
  reason: string | null;
  scheduled_message_id: number | null;
}

export interface SessionRow {
  id: string;
  chat_id: string;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  summary: string | null;
  message_count: number;
  tokens_used: number;
  last_message_id: number | null;
  last_channel: string | null;
  last_to: string | null;
  context_tokens: number | null;
  model: string | null;
  provider: string | null;
  last_reset_date: string | null;
}

export interface TgUserRow {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_bot: number;
  is_admin: number;
  is_allowed: number;
  first_seen_at: number;
  last_seen_at: number;
  message_count: number;
}

export interface TgChatRow {
  id: string;
  type: string;
  title: string | null;
  username: string | null;
  member_count: number | null;
  is_monitored: number;
  is_archived: number;
  last_message_id: string | null;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
}
