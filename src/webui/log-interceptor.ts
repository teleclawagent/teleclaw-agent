/**
 * Log interceptor — now backed by pino's WebUI stream.
 *
 * Previously this monkey-patched console.log/warn/error.
 * Now it delegates to the centralized pino logger's listener registry,
 * keeping the same API for routes/logs.ts and the SSE stream.
 */
import type { LogEntry } from "./types.js";
import { addLogListener, clearLogListeners } from "../utils/logger.js";

type LogListener = (entry: LogEntry) => void;

class LogInterceptor {
  private cleanups = new Map<LogListener, () => void>();
  private installed = false;

  /**
   * Install the interceptor. Now a lightweight no-op since pino streams
   * are always active — kept for API compat with server.ts start/stop.
   */
  install(): void {
    this.installed = true;
  }

  uninstall(): void {
    // Remove all listeners we registered
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    this.installed = false;
  }

  addListener(listener: LogListener): () => void {
    const cleanup = addLogListener(listener);
    this.cleanups.set(listener, cleanup);

    return () => {
      cleanup();
      this.cleanups.delete(listener);
    };
  }

  removeListener(listener: LogListener): void {
    const cleanup = this.cleanups.get(listener);
    if (cleanup) {
      cleanup();
      this.cleanups.delete(listener);
    }
  }

  clear(): void {
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    clearLogListeners();
  }
}

// Singleton instance
export const logInterceptor = new LogInterceptor();
