/**
 * TON Proxy agent tools — status check exposed to the LLM.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor } from "../agent/tools/types.js";
import type { TonProxyManager } from "./manager.js";

let proxyManager: TonProxyManager | null = null;

export function setProxyManager(mgr: TonProxyManager | null): void {
  proxyManager = mgr;
}

export const tonProxyStatusTool: Tool = {
  name: "ton_proxy_status",
  description:
    "Check the status of the TON Proxy (Tonutils-Proxy). " +
    "Returns whether the proxy is running, installed, the port, and PID.",
  parameters: Type.Object({}),
};

export const tonProxyStatusExecutor: ToolExecutor = async () => {
  if (!proxyManager) {
    return { success: true, data: { enabled: false, message: "TON Proxy is not configured" } };
  }

  return { success: true, data: proxyManager.getStatus() };
};
