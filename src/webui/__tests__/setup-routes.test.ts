import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── vi.mock() calls (before imports) ────────────────────────────────────────

vi.mock("../../ton/wallet-service.js", () => ({
  walletExists: vi.fn(() => false),
  getWalletAddress: vi.fn(() => null),
  generateWallet: vi.fn(),
  importWallet: vi.fn(),
  saveWallet: vi.fn(),
  loadWallet: vi.fn(() => null),
}));

vi.mock("../../workspace/manager.js", () => ({
  ensureWorkspace: vi.fn(() =>
    Promise.resolve({
      root: "/tmp/teleclaw-test",
      workspace: "/tmp/teleclaw-test/workspace",
      identityPath: "/tmp/teleclaw-test/workspace/IDENTITY.md",
      configPath: "/tmp/teleclaw-test/config.yaml",
      sessionPath: "/tmp/teleclaw-test/telegram_session.txt",
    })
  ),
  isNewWorkspace: vi.fn(() => true),
}));

const mockAuthManager = {
  sendCode: vi.fn(),
  verifyCode: vi.fn(),
  verifyPassword: vi.fn(),
  resendCode: vi.fn(),
  cancelSession: vi.fn(),
};

vi.mock("../setup-auth.js", () => ({
  TelegramAuthManager: class {
    sendCode = mockAuthManager.sendCode;
    verifyCode = mockAuthManager.verifyCode;
    verifyPassword = mockAuthManager.verifyPassword;
    resendCode = mockAuthManager.resendCode;
    cancelSession = mockAuthManager.cancelSession;
  },
}));

vi.mock("../../utils/fetch.js", () => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../../config/providers.js", () => ({
  getSupportedProviders: vi.fn(() => [
    {
      id: "anthropic",
      displayName: "Anthropic (Claude)",
      defaultModel: "claude-opus-4-6",
      utilityModel: "claude-haiku-4-5-20251001",
      toolLimit: null,
      keyPrefix: "sk-ant-",
      consoleUrl: "https://console.anthropic.com/",
    },
    {
      id: "cocoon",
      displayName: "Cocoon Network",
      defaultModel: "auto",
      utilityModel: "auto",
      toolLimit: null,
      keyPrefix: null,
      consoleUrl: "",
    },
  ]),
  getProviderMetadata: vi.fn(() => ({
    id: "anthropic",
    displayName: "Anthropic (Claude)",
    defaultModel: "claude-opus-4-6",
  })),
  validateApiKeyFormat: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("../../workspace/paths.js", () => ({
  TELECLAW_ROOT: "/tmp/teleclaw-test",
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../config/schema.js", () => ({
  ConfigSchema: { parse: vi.fn((v: unknown) => v) },
  DealsConfigSchema: { parse: vi.fn((v: unknown) => v) },
}));

vi.mock("../../constants/limits.js", () => ({
  TELEGRAM_MAX_MESSAGE_LENGTH: 4096,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { createSetupRoutes } from "../routes/setup.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  walletExists,
  getWalletAddress,
  generateWallet,
  importWallet,
  saveWallet,
} from "../../ton/wallet-service.js";
import { ensureWorkspace, isNewWorkspace } from "../../workspace/manager.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import {
  getSupportedProviders,
  getProviderMetadata,
  validateApiKeyFormat,
} from "../../config/providers.js";
import { ConfigSchema, DealsConfigSchema } from "../../config/schema.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function post(app: ReturnType<typeof createSetupRoutes>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function del(app: ReturnType<typeof createSetupRoutes>, path: string, body?: unknown) {
  return app.request(path, {
    method: "DELETE",
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

// ── Test Suite ──────────────────────────────────────────────────────────────

describe("Setup API Routes", () => {
  let app: ReturnType<typeof createSetupRoutes>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish default mock implementations after restoreAllMocks
    (walletExists as Mock).mockReturnValue(false);
    (getWalletAddress as Mock).mockReturnValue(null);
    (generateWallet as Mock).mockResolvedValue({ address: "UQB...default", mnemonic: [] });
    (importWallet as Mock).mockResolvedValue({ address: "UQB...imported" });
    (saveWallet as Mock).mockReturnValue(undefined);
    (ensureWorkspace as Mock).mockResolvedValue({
      root: "/tmp/teleclaw-test",
      workspace: "/tmp/teleclaw-test/workspace",
      identityPath: "/tmp/teleclaw-test/workspace/IDENTITY.md",
      configPath: "/tmp/teleclaw-test/config.yaml",
      sessionPath: "/tmp/teleclaw-test/telegram_session.txt",
    });
    (isNewWorkspace as Mock).mockReturnValue(true);
    (existsSync as Mock).mockReturnValue(false);
    (readFileSync as Mock).mockReturnValue("");
    (writeFileSync as Mock).mockReturnValue(undefined);
    (getSupportedProviders as Mock).mockReturnValue([
      {
        id: "anthropic",
        displayName: "Anthropic (Claude)",
        defaultModel: "claude-opus-4-6",
        utilityModel: "claude-haiku-4-5-20251001",
        toolLimit: null,
        keyPrefix: "sk-ant-",
        consoleUrl: "https://console.anthropic.com/",
      },
      {
        id: "cocoon",
        displayName: "Cocoon Network",
        defaultModel: "auto",
        utilityModel: "auto",
        toolLimit: null,
        keyPrefix: null,
        consoleUrl: "",
      },
    ]);
    (getProviderMetadata as Mock).mockReturnValue({
      id: "anthropic",
      displayName: "Anthropic (Claude)",
      defaultModel: "claude-opus-4-6",
    });
    (validateApiKeyFormat as Mock).mockReturnValue(undefined);
    (ConfigSchema.parse as Mock).mockImplementation((v: unknown) => v);
    (DealsConfigSchema.parse as Mock).mockImplementation((v: unknown) => v);
    mockAuthManager.sendCode.mockReset();
    mockAuthManager.verifyCode.mockReset();
    mockAuthManager.verifyPassword.mockReset();
    mockAuthManager.resendCode.mockReset();
    mockAuthManager.cancelSession.mockReset();
    // Reset env vars
    delete process.env.TELECLAW_API_KEY;
    delete process.env.TELECLAW_TG_API_ID;
    delete process.env.TELECLAW_TG_API_HASH;
    delete process.env.TELECLAW_TG_PHONE;
    app = createSetupRoutes();
  });

  // ── GET /status ─────────────────────────────────────────────────────────

  describe("GET /status", () => {
    it("returns status with no workspace/wallet/session", async () => {
      (existsSync as Mock).mockReturnValue(false);
      (walletExists as Mock).mockReturnValue(false);
      (getWalletAddress as Mock).mockReturnValue(null);

      const res = await app.request("/status");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.workspaceExists).toBe(false);
      expect(data.data.walletExists).toBe(false);
      expect(data.data.walletAddress).toBeNull();
      expect(data.data.sessionExists).toBe(false);
    });

    it("returns status with existing workspace and wallet", async () => {
      (existsSync as Mock).mockReturnValue(true);
      (walletExists as Mock).mockReturnValue(true);
      (getWalletAddress as Mock).mockReturnValue("UQB...abc");

      const res = await app.request("/status");
      const data = await res.json();
      expect(data.data.workspaceExists).toBe(true);
      expect(data.data.walletExists).toBe(true);
      expect(data.data.walletAddress).toBe("UQB...abc");
      expect(data.data.sessionExists).toBe(true);
    });

    it("masks API key from env vars", async () => {
      process.env.TELECLAW_API_KEY = "sk-ant-api03-verylongkey1234567890";
      (existsSync as Mock).mockReturnValue(false);

      const res = await app.request("/status");
      const data = await res.json();
      expect(data.data.envVars.apiKey).toBe("sk-ant...7890");
      expect(data.data.envVars.apiKeyRaw).toBe(true);
    });

    it("returns null for missing env vars", async () => {
      (existsSync as Mock).mockReturnValue(false);

      const res = await app.request("/status");
      const data = await res.json();
      expect(data.data.envVars.apiKey).toBeNull();
      expect(data.data.envVars.apiKeyRaw).toBe(false);
      expect(data.data.envVars.telegramApiId).toBeNull();
      expect(data.data.envVars.telegramApiHash).toBeNull();
      expect(data.data.envVars.telegramPhone).toBeNull();
    });

    it("returns 500 on unexpected error", async () => {
      (walletExists as Mock).mockImplementation(() => {
        throw new Error("DB connection failed");
      });

      const res = await app.request("/status");
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("DB connection failed");
    });
  });

  // ── GET /providers ──────────────────────────────────────────────────────

  describe("GET /providers", () => {
    it("returns provider list with requiresApiKey flag", async () => {
      const res = await app.request("/providers");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.data[0].id).toBe("anthropic");
      expect(data.data[0].requiresApiKey).toBe(true);
      expect(data.data[1].id).toBe("cocoon");
      expect(data.data[1].requiresApiKey).toBe(false);
    });
  });

  // ── GET /models/:provider ───────────────────────────────────────────────

  describe("GET /models/:provider", () => {
    it("returns model catalog for known provider", async () => {
      const res = await app.request("/models/anthropic");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      // Should include known models + Custom entry
      const custom = data.data.find((m: { value: string }) => m.value === "__custom__");
      expect(custom).toBeDefined();
      expect(custom.isCustom).toBe(true);
    });

    it("returns only Custom entry for unknown provider", async () => {
      const res = await app.request("/models/unknown_provider");
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].value).toBe("__custom__");
    });
  });

  // ── POST /validate/api-key ──────────────────────────────────────────────

  describe("POST /validate/api-key", () => {
    it("returns valid when format passes", async () => {
      (validateApiKeyFormat as Mock).mockReturnValue(undefined);

      const res = await post(app, "/validate/api-key", {
        provider: "anthropic",
        apiKey: "sk-ant-api03-test",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.valid).toBe(true);
      expect(data.data.error).toBeUndefined();
    });

    it("returns invalid when format fails", async () => {
      (validateApiKeyFormat as Mock).mockReturnValue("Invalid key prefix");

      const res = await post(app, "/validate/api-key", {
        provider: "anthropic",
        apiKey: "bad-key",
      });
      const data = await res.json();
      expect(data.data.valid).toBe(false);
      expect(data.data.error).toBe("Invalid key prefix");
    });

    it("returns 400 on malformed body", async () => {
      const res = await app.request("/validate/api-key", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
    });
  });

  // ── POST /validate/bot-token ────────────────────────────────────────────

  describe("POST /validate/bot-token", () => {
    it("validates a correct bot token", async () => {
      (fetchWithTimeout as Mock).mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            result: { username: "test_bot", first_name: "Test Bot" },
          }),
      });

      const res = await post(app, "/validate/bot-token", {
        token: "12345678:ABCDEFghijklmnopqrstuvwxyz012345",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.valid).toBe(true);
      expect(data.data.bot.username).toBe("test_bot");
    });

    it("returns invalid for token without colon", async () => {
      const res = await post(app, "/validate/bot-token", { token: "no-colon-here" });
      const data = await res.json();
      expect(data.data.valid).toBe(false);
      expect(data.data.error).toContain("Invalid format");
    });

    it("returns invalid for empty token", async () => {
      const res = await post(app, "/validate/bot-token", { token: "" });
      const data = await res.json();
      expect(data.data.valid).toBe(false);
    });

    it("returns invalid when Telegram API rejects token", async () => {
      (fetchWithTimeout as Mock).mockResolvedValue({
        json: () => Promise.resolve({ ok: false }),
      });

      const res = await post(app, "/validate/bot-token", {
        token: "12345678:ABCDEFghijklmnopqrstuvwxyz012345",
      });
      const data = await res.json();
      expect(data.data.valid).toBe(false);
      expect(data.data.error).toContain("invalid");
    });

    it("handles network error gracefully", async () => {
      (fetchWithTimeout as Mock).mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await post(app, "/validate/bot-token", {
        token: "12345678:ABCDEFghijklmnopqrstuvwxyz012345",
      });
      const data = await res.json();
      expect(data.data.valid).toBe(false);
      expect(data.data.networkError).toBe(true);
      expect(data.data.error).toContain("Could not reach");
    });
  });

  // ── POST /workspace/init ────────────────────────────────────────────────

  describe("POST /workspace/init", () => {
    it("creates workspace successfully", async () => {
      (existsSync as Mock).mockReturnValue(false);

      const res = await post(app, "/workspace/init", {});
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe("/tmp/teleclaw-test");
      expect(ensureWorkspace).toHaveBeenCalledWith({
        workspaceDir: undefined,
        ensureTemplates: true,
      });
    });

    it("substitutes agent name in IDENTITY.md", async () => {
      (existsSync as Mock).mockReturnValue(true);
      (readFileSync as Mock).mockReturnValue("I am [Your name - pick one or ask your human]");

      const res = await post(app, "/workspace/init", { agentName: "Tonny" });
      expect(res.status).toBe(200);
      expect(writeFileSync).toHaveBeenCalledWith(
        "/tmp/teleclaw-test/workspace/IDENTITY.md",
        "I am Tonny",
        "utf-8"
      );
    });

    it("skips agent name substitution when no name provided", async () => {
      (existsSync as Mock).mockReturnValue(true);

      const res = await post(app, "/workspace/init", {});
      expect(res.status).toBe(200);
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it("returns 500 on workspace creation failure", async () => {
      (ensureWorkspace as Mock).mockRejectedValue(new Error("Permission denied"));

      const res = await post(app, "/workspace/init", {});
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Permission denied");
    });
  });

  // ── GET /wallet/status ──────────────────────────────────────────────────

  describe("GET /wallet/status", () => {
    it("returns exists: false when no wallet", async () => {
      (walletExists as Mock).mockReturnValue(false);

      const res = await app.request("/wallet/status");
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.exists).toBe(false);
      expect(data.data.address).toBeUndefined();
    });

    it("returns exists: true with address when wallet exists", async () => {
      (walletExists as Mock).mockReturnValue(true);
      (getWalletAddress as Mock).mockReturnValue("UQB...wallet");

      const res = await app.request("/wallet/status");
      const data = await res.json();
      expect(data.data.exists).toBe(true);
      expect(data.data.address).toBe("UQB...wallet");
    });
  });

  // ── POST /wallet/generate ───────────────────────────────────────────────

  describe("POST /wallet/generate", () => {
    it("generates and saves a new wallet", async () => {
      const mockWallet = {
        address: "UQB...new",
        mnemonic: Array(24).fill("word"),
      };
      (generateWallet as Mock).mockResolvedValue(mockWallet);

      const res = await post(app, "/wallet/generate", {});
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.address).toBe("UQB...new");
      expect(data.data.mnemonic).toHaveLength(24);
      expect(saveWallet).toHaveBeenCalledWith(mockWallet);
    });

    it("returns 500 on generation failure", async () => {
      (generateWallet as Mock).mockRejectedValue(new Error("Crypto error"));

      const res = await post(app, "/wallet/generate", {});
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Crypto error");
    });
  });

  // ── POST /wallet/import ─────────────────────────────────────────────────

  describe("POST /wallet/import", () => {
    it("imports a valid 24-word mnemonic", async () => {
      const words = Array(24).fill("abandon");
      const mockWallet = { address: "UQB...imported" };
      (importWallet as Mock).mockResolvedValue(mockWallet);

      const res = await post(app, "/wallet/import", { mnemonic: words.join(" ") });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.address).toBe("UQB...imported");
      expect(saveWallet).toHaveBeenCalledWith(mockWallet);
    });

    it("rejects mnemonic with wrong word count", async () => {
      const res = await post(app, "/wallet/import", { mnemonic: "one two three" });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Expected 24 words");
      expect(data.error).toContain("got 3");
    });

    it("returns 400 when importWallet throws (invalid mnemonic)", async () => {
      const words = Array(24).fill("invalid");
      (importWallet as Mock).mockRejectedValue(
        new Error("Invalid mnemonic: words do not form a valid TON seed phrase")
      );

      const res = await post(app, "/wallet/import", { mnemonic: words.join(" ") });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid mnemonic");
    });
  });

  // ── POST /config/save ──────────────────────────────────────────────────

  describe("POST /config/save", () => {
    const validInput = {
      agent: {
        provider: "anthropic",
        api_key: "sk-ant-api03-test",
        model: "claude-opus-4-6",
        max_agentic_iterations: 5,
      },
      telegram: {
        api_id: 12345,
        api_hash: "abcdef",
        phone: "+1234567890",
        owner_id: 999,
        dm_policy: "open",
        group_policy: "open",
        require_mention: true,
        bot_token: "123:ABC",
        bot_username: "testbot",
      },
    };

    it("saves valid config successfully", async () => {
      const res = await post(app, "/config/save", validInput);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.path).toBe("/tmp/teleclaw-test/config.yaml");
      expect(writeFileSync).toHaveBeenCalled();
      expect(ConfigSchema.parse).toHaveBeenCalled();
    });

    it("includes cocoon config when provided", async () => {
      const input = {
        ...validInput,
        cocoon: { endpoint: "https://cocoon.network" },
      };

      const res = await post(app, "/config/save", input);
      expect(res.status).toBe(200);

      // Check that writeFileSync was called with YAML containing cocoon
      const writeCall = (writeFileSync as Mock).mock.calls[0];
      expect(writeCall[1]).toContain("cocoon");
    });

    it("returns 400 on Zod validation failure", async () => {
      (ConfigSchema.parse as Mock).mockImplementation(() => {
        throw new Error("Validation failed: agent.provider is required");
      });

      const res = await post(app, "/config/save", validInput);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Validation failed");
    });

    it("returns 400 on malformed JSON body", async () => {
      const res = await app.request("/config/save", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("uses provider default model when none specified", async () => {
      const input = {
        ...validInput,
        agent: { ...validInput.agent, model: "" },
      };

      await post(app, "/config/save", input);

      const writeCall = (writeFileSync as Mock).mock.calls[0];
      // The model should fall back to providerMeta.defaultModel
      expect(writeCall[1]).toContain("claude-opus-4-6");
    });

    it("writes config with restricted permissions (0o600)", async () => {
      await post(app, "/config/save", validInput);

      const writeCall = (writeFileSync as Mock).mock.calls[0];
      expect(writeCall[2]).toEqual({ encoding: "utf-8", mode: 0o600 });
    });
  });
});
