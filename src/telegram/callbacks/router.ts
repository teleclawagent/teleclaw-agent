import { CallbackQueryHandler } from "./handler.js";
import type { TelegramBridge } from "../bridge.js";
import type Database from "better-sqlite3";

export function initializeCallbackRouter(
  bridge: TelegramBridge,
  db: Database.Database
): CallbackQueryHandler {
  const handler = new CallbackQueryHandler(bridge, db);
  return handler;
}
