import { CallbackQueryHandler } from "./handler.js";
import type { TelegramTransport } from "../transport.js";
import type Database from "better-sqlite3";

export function initializeCallbackRouter(
  bridge: TelegramTransport,
  db: Database.Database
): CallbackQueryHandler {
  const handler = new CallbackQueryHandler(bridge, db);
  return handler;
}
