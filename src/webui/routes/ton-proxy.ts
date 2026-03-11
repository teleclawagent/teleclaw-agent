import { Hono } from "hono";
import type { WebUIServerDeps, APIResponse } from "../types.js";
import { getTonProxyManager, setTonProxyManager } from "../../ton-proxy/module.js";
import { TonProxyManager } from "../../ton-proxy/manager.js";
import { readRawConfig, writeRawConfig, setNestedValue } from "../../config/configurable-keys.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("TonProxyRoute");

export function createTonProxyRoutes(deps: WebUIServerDeps) {
  const app = new Hono();

  // GET /api/ton-proxy — current status
  app.get("/", (c) => {
    const mgr = getTonProxyManager();
    if (!mgr) {
      return c.json({
        success: true,
        data: { running: false, installed: false, port: 8080, enabled: false },
      } as APIResponse);
    }
    return c.json({
      success: true,
      data: { ...mgr.getStatus(), enabled: true },
    } as APIResponse);
  });

  // POST /api/ton-proxy/start — enable + start (awaits download & startup)
  app.post("/start", async (c) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime config is dynamic
      const runtimeConfig = deps.agent.getConfig() as Record<string, any>;
      const port = (runtimeConfig.ton_proxy?.port as number) ?? 8080;
      const binaryPath = runtimeConfig.ton_proxy?.binary_path as string | undefined;

      // Stop existing if running
      const existing = getTonProxyManager();
      if (existing?.isRunning()) await existing.stop();

      const mgr = new TonProxyManager({ enabled: true, port, binary_path: binaryPath });
      setTonProxyManager(mgr);
      await mgr.start();

      // Persist enabled=true to YAML
      const raw = readRawConfig(deps.configPath);
      setNestedValue(raw, "ton_proxy.enabled", true);
      writeRawConfig(raw, deps.configPath);
      setNestedValue(runtimeConfig, "ton_proxy.enabled", true);

      log.info(`TON Proxy started on port ${port} (WebUI)`);

      return c.json({
        success: true,
        data: { ...mgr.getStatus(), enabled: true },
      } as APIResponse);
    } catch (err) {
      log.error({ err }, "Failed to start TON Proxy");
      return c.json(
        { success: false, error: err instanceof Error ? err.message : String(err) } as APIResponse,
        500
      );
    }
  });

  // POST /api/ton-proxy/stop — stop + disable
  app.post("/stop", async (c) => {
    try {
      const mgr = getTonProxyManager();
      if (mgr) {
        await mgr.stop();
        setTonProxyManager(null);
      }

      // Persist enabled=false to YAML
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime config is dynamic
      const runtimeConfig = deps.agent.getConfig() as Record<string, any>;
      const raw = readRawConfig(deps.configPath);
      setNestedValue(raw, "ton_proxy.enabled", false);
      writeRawConfig(raw, deps.configPath);
      setNestedValue(runtimeConfig, "ton_proxy.enabled", false);

      log.info("TON Proxy stopped (WebUI)");

      return c.json({
        success: true,
        data: { running: false, installed: true, port: 8080, enabled: false },
      } as APIResponse);
    } catch (err) {
      log.error({ err }, "Failed to stop TON Proxy");
      return c.json(
        { success: false, error: err instanceof Error ? err.message : String(err) } as APIResponse,
        500
      );
    }
  });

  // POST /api/ton-proxy/uninstall — stop + remove binary + disable
  app.post("/uninstall", async (c) => {
    try {
      const mgr = getTonProxyManager();
      if (mgr) {
        await mgr.uninstall();
        setTonProxyManager(null);
      } else {
        // No active manager — create a temporary one to locate and delete the binary
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime config is dynamic
        const runtimeConfig = deps.agent.getConfig() as Record<string, any>;
        const port = (runtimeConfig.ton_proxy?.port as number) ?? 8080;
        const binaryPath = runtimeConfig.ton_proxy?.binary_path as string | undefined;
        const tmp = new TonProxyManager({ enabled: false, port, binary_path: binaryPath });
        await tmp.uninstall();
      }

      // Persist enabled=false to YAML
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime config is dynamic
      const runtimeConfig = deps.agent.getConfig() as Record<string, any>;
      const raw = readRawConfig(deps.configPath);
      setNestedValue(raw, "ton_proxy.enabled", false);
      writeRawConfig(raw, deps.configPath);
      setNestedValue(runtimeConfig, "ton_proxy.enabled", false);

      log.info("TON Proxy uninstalled (WebUI)");

      return c.json({
        success: true,
        data: { running: false, installed: false, port: 8080, enabled: false },
      } as APIResponse);
    } catch (err) {
      log.error({ err }, "Failed to uninstall TON Proxy");
      return c.json(
        { success: false, error: err instanceof Error ? err.message : String(err) } as APIResponse,
        500
      );
    }
  });

  return app;
}
