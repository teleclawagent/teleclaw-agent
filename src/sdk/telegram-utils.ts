import type { TelegramTransport } from "../telegram/transport.js";
import type { Api } from "telegram";
import type { SimpleMessage } from "@teleclaw-agent/sdk";
import { PluginSDKError } from "@teleclaw-agent/sdk";

export function requireBridge(bridge: TelegramTransport): void {
  if (!bridge.isAvailable()) {
    throw new PluginSDKError(
      "Telegram bridge not connected. SDK telegram methods can only be called at runtime (inside tool executors or start()), not during plugin loading.",
      "BRIDGE_NOT_CONNECTED"
    );
  }
}

/**
 * Get the raw underlying client. In userbot mode returns GramJS TelegramClient,
 * in bot mode returns grammY Bot instance.
 * Prefer using TelegramTransport methods directly when possible.
 */
export function getRawClient(bridge: TelegramTransport): unknown {
  if (bridge.getRawClient) {
    return bridge.getRawClient();
  }
  throw new PluginSDKError(
    "Raw client not available on this transport",
    "NO_RAW_CLIENT"
  );
}

/** Convert a GramJS message to a SimpleMessage */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS message type is dynamic and untyped in SDK context
export function toSimpleMessage(msg: any): SimpleMessage {
  return {
    id: msg.id,
    text: msg.message ?? "",
    senderId: Number(msg.fromId?.userId ?? msg.fromId?.channelId ?? 0),
    timestamp: new Date(msg.date * 1000),
  };
}

/** Cached dynamic import of telegram Api (needed in files with type-only imports) */
let _Api: typeof Api;
export async function getApi(): Promise<typeof Api> {
  if (!_Api) {
    _Api = (await import("telegram")).Api;
  }
  return _Api;
}
