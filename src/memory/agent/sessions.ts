import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { hashText, serializeEmbedding } from "../embeddings/index.js";
import { randomUUID } from "crypto";
import type { SessionRow } from "../types/db-rows.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Memory");

export interface Session {
  id: string;
  chatId?: string;
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
  messageCount: number;
  tokensUsed: number;
}

export interface SessionEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export class SessionStore {
  constructor(
    private db: Database.Database,
    private embedder: EmbeddingProvider,
    private vectorEnabled: boolean
  ) {}

  createSession(chatId?: string): Session {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `
      INSERT INTO sessions (id, chat_id, started_at, message_count, tokens_used)
      VALUES (?, ?, ?, 0, 0)
    `
      )
      .run(id, chatId ?? null, now);

    return {
      id,
      chatId,
      startedAt: new Date(now * 1000),
      messageCount: 0,
      tokensUsed: 0,
    };
  }

  endSession(sessionId: string, summary: string, tokensUsed: number = 0): void {
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `
      UPDATE sessions
      SET ended_at = ?, summary = ?, tokens_used = ?
      WHERE id = ?
    `
      )
      .run(now, summary, tokensUsed, sessionId);
  }

  incrementMessageCount(sessionId: string, count: number = 1): void {
    this.db
      .prepare(
        `
      UPDATE sessions
      SET message_count = message_count + ?
      WHERE id = ?
    `
      )
      .run(count, sessionId);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      chatId: row.chat_id,
      startedAt: new Date(row.started_at * 1000),
      endedAt: row.ended_at ? new Date(row.ended_at * 1000) : undefined,
      summary: row.summary ?? undefined,
      messageCount: row.message_count,
      tokensUsed: row.tokens_used,
    };
  }

  getActiveSessions(): Session[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
    `
      )
      .all() as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      startedAt: new Date(row.started_at * 1000),
      endedAt: undefined,
      summary: row.summary ?? undefined,
      messageCount: row.message_count,
      tokensUsed: row.tokens_used,
    }));
  }

  getSessionsByChat(chatId: string, limit: number = 50): Session[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM sessions
      WHERE chat_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `
      )
      .all(chatId, limit) as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      startedAt: new Date(row.started_at * 1000),
      endedAt: row.ended_at ? new Date(row.ended_at * 1000) : undefined,
      summary: row.summary ?? undefined,
      messageCount: row.message_count,
      tokensUsed: row.tokens_used,
    }));
  }

  /**
   * Index a session for search after ending.
   * Creates a knowledge entry from the session summary for future retrieval.
   */
  async indexSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session || !session.summary) return;

    try {
      const knowledgeId = `session:${sessionId}`;
      const text = `Session from ${session.startedAt.toISOString()}:\n${session.summary}`;
      const hash = hashText(text);

      let embedding: number[] | null = null;
      if (this.vectorEnabled) {
        embedding = await this.embedder.embedQuery(text);
      }

      this.db
        .prepare(
          `
        INSERT INTO knowledge (id, source, path, text, hash, created_at, updated_at)
        VALUES (?, 'session', ?, ?, ?, unixepoch(), unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text,
          hash = excluded.hash,
          updated_at = excluded.updated_at
      `
        )
        .run(knowledgeId, sessionId, text, hash);

      if (embedding && this.vectorEnabled) {
        const embeddingBuffer = serializeEmbedding(embedding);

        this.db.prepare(`DELETE FROM knowledge_vec WHERE id = ?`).run(knowledgeId);
        this.db
          .prepare(`INSERT INTO knowledge_vec (id, embedding) VALUES (?, ?)`)
          .run(knowledgeId, embeddingBuffer);
      }

      log.info(`Indexed session ${sessionId} to knowledge base`);
    } catch (error) {
      log.error({ err: error }, "Error indexing session");
    }
  }

  deleteSession(sessionId: string): void {
    const knowledgeId = `session:${sessionId}`;
    if (this.vectorEnabled) {
      this.db.prepare(`DELETE FROM knowledge_vec WHERE id = ?`).run(knowledgeId);
    }
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(knowledgeId);
  }
}
