/**
 * Teleclaw Onboarding Wizard
 *
 * Interactive setup wizard with @inquirer/prompts UI.
 * Fused ASCII banner + progress box frame.
 */

import {
  createPrompter,
  CancelledError,
  input,
  select,
  confirm,
  password,
  inquirerTheme as theme,
  wizardFrame,
  noteBox,
  finalSummaryBox,
  FRAME_WIDTH,
  TON,
  GREEN,
  CYAN,
  DIM,
  RED,
  WHITE,
  padRight,
  padRightAnsi,
  stripAnsi,
  type StepDef,
} from "../prompts.js";

import { ensureWorkspace, isNewWorkspace } from "../../workspace/manager.js";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { TELECLAW_ROOT } from "../../workspace/paths.js";
// TelegramUserClient import removed — bot-only mode
import YAML from "yaml";
import { type Config, DealsConfigSchema } from "../../config/schema.js";
import { getModelsForProvider } from "../../config/model-catalog.js";
import {
  generateWallet,
  importWallet,
  saveWallet,
  walletExists,
  loadWallet,
} from "../../ton/wallet-service.js";
import {
  getSupportedProviders,
  getProviderMetadata,
  validateApiKeyFormat,
  type SupportedProvider,
} from "../../config/providers.js";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../../constants/limits.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import ora from "ora";
import {
  getClaudeCodeApiKey,
  isClaudeCodeTokenValid,
} from "../../providers/claude-code-credentials.js";

export interface OnboardOptions {
  workspace?: string;
  nonInteractive?: boolean;
  ui?: boolean;
  uiPort?: string;
  apiKey?: string;
  baseUrl?: string;
  userId?: number;
  provider?: SupportedProvider;
  searchApiKey?: string;
  searchProvider?: string;
  botToken?: string;
}

// ── Progress steps ────────────────────────────────────────────────────

const STEPS: StepDef[] = [
  { label: "Agent", desc: "Name" },
  { label: "Provider", desc: "LLM, key & model" },
  { label: "Config", desc: "Policies" },
  { label: "Modules", desc: "Optional API keys" },
  { label: "Wallet", desc: "TON blockchain" },
  { label: "Bot Token", desc: "BotFather token" },
];

// ── Helpers ────────────────────────────────────────────────────────────

function _generateClaimCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let code = "TC-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function redraw(currentStep: number): void {
  console.clear();
  console.log();
  console.log(wizardFrame(currentStep, STEPS));
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Model catalog imported from shared source (see src/config/model-catalog.ts)

/**
 * Main onboard command
 */
export async function onboardCommand(options: OnboardOptions = {}): Promise<void> {
  // Web UI mode
  if (options.ui) {
    const { SetupServer } = await import("../../webui/setup-server.js");
    const port = parseInt(options.uiPort || "7777") || 7777;
    const url = `http://localhost:${port}/setup`;

    const blue = "\x1b[34m";
    const reset = "\x1b[0m";
    const dim = "\x1b[2m";
    console.log(`
${blue}  ┌───────────────────────────────────────────────────────────────────────────────────────┐
  │                                                                                       │
  │    ______     __          __                ___                    __              │
  │   /_  __/__  / /__  _____/ /___ __      __ /   | ____ ____  ____  / /_             │
  │    / / / _ \\/ / _ \\/ ___/ / __ \`/ | /| / // /| |/ __ \`/ _ \\/ __ \\/ __/             │
  │   / / /  __/ /  __/ /__/ / /_/ /| |/ |/ // ___ / /_/ /  __/ / / / /_              │
  │  /_/  \\___/_/\\___/\\___/_/\\__,_/ |__/|__//_/  |_\\__, /\\___/_/ /_/\\__/              │
  │                                               /____/                              │
  │                                                                                       │
  └────────────────────────────────────────────────────────────────── TELECLAW AGENT 🦞 ──┘${reset}

  ${dim}Setup wizard running at${reset} ${url}
  ${dim}Opening in your default browser...${reset}
  ${dim}Press Ctrl+C to cancel.${reset}
`);

    const server = new SetupServer(port);
    await server.start();

    process.on("SIGINT", () => {
      void server.stop().then(() => process.exit(0));
    });

    // Wait for user to click "Start Agent" in the browser
    await server.waitForLaunch();
    console.log("\n  Launch signal received — stopping setup server");
    await server.stop();

    // Boot TonnetApp on the same port
    console.log("  Starting TonnetApp...\n");
    const { TeleclawApp } = await import("../../index.js");
    const configPath = join(TELECLAW_ROOT, "config.yaml");
    const app = new TeleclawApp(configPath);
    await app.start();

    // Keep process alive (TonnetApp manages its own lifecycle)
    return;
  }

  const prompter = createPrompter();

  try {
    if (options.nonInteractive) {
      await runNonInteractiveOnboarding(options, prompter);
    } else {
      await runInteractiveOnboarding(options, prompter);
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log(`\n  ${DIM("Setup cancelled. No changes were made.")}\n`);
      process.exit(0);
    }
    throw err;
  }
}

/**
 * Interactive onboarding wizard
 */
async function runInteractiveOnboarding(
  options: OnboardOptions,
  prompter: ReturnType<typeof createPrompter>
): Promise<void> {
  // ── PowerShell detection ──
  const isPowerShell =
    !!process.env.PSModulePath || (process.env.ComSpec || "").toLowerCase().includes("powershell");
  if (isPowerShell) {
    console.log();
    console.log(
      `  ${DIM("Tip: If prompts look broken, try")} ${CYAN("teleclaw setup --ui")} ${DIM("for browser-based setup.")}`
    );
    console.log();
  }

  // ── Shared state ──
  let selectedProvider: SupportedProvider = "anthropic";
  let selectedModel = "";
  let apiKey = "";
  let _userId = 0;
  let tonapiKey: string | undefined;
  let toncenterApiKey: string | undefined;
  let searchApiKey: string | undefined;
  let searchProvider: "brave" | "gemini" | "grok" | "kimi" | "perplexity" | undefined;
  let botToken: string | undefined;
  let botUsername: string | undefined;
  let dmPolicy: "open" | "allowlist" | "admin-only" | "disabled" = "admin-only";
  let groupPolicy: "open" | "allowlist" | "admin-only" | "disabled" = "admin-only";
  let requireMention = true;
  let maxAgenticIterations = "5";
  let execMode: "off" | "yolo" = "off";
  let cocoonInstance = 10000;

  // Intro
  console.clear();
  console.log();
  noteBox(
    "Set up your Teleclaw bot agent.\n" +
      "You'll need a BotFather token, an LLM API key, and a few minutes.",
    "Teleclaw Agent Setup 🦞",
    CYAN
  );
  console.log();
  console.log(wizardFrame(0, STEPS));
  console.log();
  await sleep(800);

  // ════════════════════════════════════════════════════════════════════
  // Step 0/1: Agent — security warning, workspace, name
  // ════════════════════════════════════════════════════════════════════
  redraw(0);

  noteBox(
    "Your Teleclaw bot will have access to:\n" +
      "\n" +
      "  • BOT CONVERSATIONS: Read and respond to messages\n" +
      "  • TON WALLET: A new wallet will be generated that the agent\n" +
      "    can use to send transactions autonomously\n" +
      "\n" +
      "Only fund the generated wallet with amounts you're comfortable\n" +
      "letting the agent manage.",
    "Security Warning",
    RED
  );

  const acceptRisk = await confirm({
    message: "I understand the risks and want to continue",
    default: false,
    theme,
  });

  if (!acceptRisk) {
    console.log(`\n  ${DIM("Setup cancelled — you must accept the risks to continue.")}\n`);
    process.exit(1);
  }

  // Workspace
  const spinner = ora({ color: "cyan" });
  spinner.start(DIM("Creating workspace..."));
  const workspace = await ensureWorkspace({
    workspaceDir: options.workspace,
    ensureTemplates: true,
    silent: true,
  });
  const isNew = isNewWorkspace(workspace);
  spinner.succeed(DIM(`Workspace: ${workspace.root}`));

  if (!isNew) {
    prompter.warn("Existing configuration detected");
    const shouldOverwrite = await confirm({
      message: "Overwrite existing configuration?",
      default: false,
      theme,
    });
    if (!shouldOverwrite) {
      console.log(`\n  ${DIM("Setup cancelled — existing configuration preserved.")}\n`);
      return;
    }
  }

  // Agent name
  const agentName = await input({
    message: "Give your agent a name (optional)",
    default: "Nova",
    theme,
  });

  if (agentName && agentName.trim() && existsSync(workspace.identityPath)) {
    const identity = readFileSync(workspace.identityPath, "utf-8");
    const updated = identity.replace("[Your name - pick one or ask your human]", agentName.trim());
    writeFileSync(workspace.identityPath, updated, "utf-8");
  }

  STEPS[0].value = agentName;

  // ════════════════════════════════════════════════════════════════════
  // Step 1: Provider — select + tool limit warning + API key
  // ════════════════════════════════════════════════════════════════════
  redraw(1);

  const providers = getSupportedProviders();
  selectedProvider = await select({
    message: "AI Provider",
    default: "anthropic",
    theme,
    choices: providers.map((p) => ({
      value: p.id,
      name: p.displayName,
      description:
        p.toolLimit !== null ? `${p.defaultModel} (max ${p.toolLimit} tools)` : `${p.defaultModel}`,
    })),
  });

  const providerMeta = getProviderMetadata(selectedProvider);

  // Tool limit warning
  if (providerMeta.toolLimit !== null) {
    noteBox(
      `${providerMeta.displayName} supports max ${providerMeta.toolLimit} tools.\n` +
        "Teleclaw currently has ~116 tools. If more tools are added,\n" +
        "some may be truncated.",
      "Tool Limit"
    );
  }

  // API key (or Cocoon / Local setup)
  let localBaseUrl = "";
  if (selectedProvider === "cocoon") {
    // Cocoon Network — no API key, managed externally via cocoon-cli
    apiKey = "";

    const cocoonPort = await input({
      message: "Cocoon proxy HTTP port",
      default: "10000",
      theme,
      validate: (value = "") => {
        const n = parseInt(value.trim(), 10);
        return n >= 1 && n <= 65535 ? true : "Must be a port number (1-65535)";
      },
    });
    cocoonInstance = parseInt(cocoonPort.trim(), 10);

    noteBox(
      "Cocoon Network — Decentralized LLM on TON\n" +
        "No API key needed. Requires cocoon-cli running externally.\n" +
        `Teleclaw will connect to http://localhost:${cocoonInstance}/v1/`,
      "Cocoon Network",
      TON
    );

    STEPS[1].value = `${providerMeta.displayName}  ${DIM(`port ${cocoonInstance}`)}`;
  } else if (selectedProvider === "local") {
    // Local LLM — no API key, needs base URL
    apiKey = "";

    localBaseUrl = await input({
      message: "Local LLM server URL",
      default: "http://localhost:11434/v1",
      theme,
      validate: (value = "") => {
        try {
          new URL(value.trim());
          return true;
        } catch {
          return "Must be a valid URL (e.g. http://localhost:11434/v1)";
        }
      },
    });
    localBaseUrl = localBaseUrl.trim();

    noteBox(
      "Local LLM — OpenAI-compatible server\n" +
        "No API key needed. Models auto-discovered at startup.\n" +
        `Teleclaw will connect to ${localBaseUrl}`,
      "Local LLM",
      TON
    );

    STEPS[1].value = `${providerMeta.displayName}  ${DIM(localBaseUrl)}`;
  } else if (selectedProvider === "claude-code") {
    // Claude Code — auto-detect credentials, fallback to manual key
    let detected = false;
    try {
      const key = getClaudeCodeApiKey();
      const valid = isClaudeCodeTokenValid();
      apiKey = ""; // Don't store in config — auto-detected at runtime
      detected = true;
      const masked = key.length > 16 ? key.slice(0, 12) + "..." + key.slice(-4) : "***";
      noteBox(
        `Credentials auto-detected from Claude Code\n` +
          `Key: ${masked}\n` +
          `Status: ${valid ? GREEN("valid ✓") : "expired (will refresh on use)"}\n` +
          `Token will auto-refresh when it expires.`,
        "Claude Code",
        TON
      );
      await confirm({
        message: "Continue with auto-detected credentials?",
        default: true,
        theme,
      });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      prompter.warn(
        "Claude Code credentials not found. Make sure Claude Code is installed and authenticated (claude login)."
      );
      const useFallback = await confirm({
        message: "Enter an API key manually instead?",
        default: true,
        theme,
      });
      if (useFallback) {
        apiKey = await password({
          message: `Anthropic API Key (fallback)`,
          theme,
          validate: (value = "") => {
            if (!value || value.trim().length === 0) return "API key is required";
            return true;
          },
        });
      } else {
        throw new CancelledError();
      }
    }

    if (detected) {
      STEPS[1].value = `${providerMeta.displayName}  ${DIM("auto-detected ✓")}`;
    } else {
      const maskedKey = apiKey.length > 10 ? apiKey.slice(0, 6) + "..." + apiKey.slice(-4) : "***";
      STEPS[1].value = `${providerMeta.displayName}  ${DIM(maskedKey)}`;
    }
  } else if (selectedProvider === "openai-codex") {
    // OpenAI Codex — auto-detect from Codex CLI
    const { isCodexOAuthConfigured, isCodexTokenValid } =
      await import("../../providers/openai-codex-oauth.js");
    let detected = false;
    try {
      if (isCodexOAuthConfigured()) {
        const valid = isCodexTokenValid();
        apiKey = ""; // Auto-detected at runtime
        detected = true;
        noteBox(
          `Credentials auto-detected from Codex CLI\n` +
            `Status: ${valid ? GREEN("valid ✓") : "expired (may need re-login)"}\n` +
            `If you have ChatGPT Plus/Pro, this uses your subscription.`,
          "OpenAI Codex",
          TON
        );
      } else {
        throw new Error("Not configured");
      }
    } catch {
      prompter.warn(
        "Codex CLI credentials not found. Install Codex CLI (npm i -g @openai/codex) and run 'codex login'."
      );
      const useFallback = await confirm({
        message: "Enter an OpenAI API key manually instead?",
        default: true,
        theme,
      });
      if (useFallback) {
        apiKey = await password({
          message: `OpenAI API Key (fallback)`,
          theme,
          validate: (value = "") => {
            if (!value || value.trim().length === 0) return "API key is required";
            return true;
          },
        });
      } else {
        throw new CancelledError();
      }
    }

    STEPS[1].value = detected
      ? `${providerMeta.displayName}  ${DIM("auto-detected ✓")}`
      : `${providerMeta.displayName}  ${DIM(apiKey.slice(0, 6) + "...")}`;
  } else if (selectedProvider === "copilot") {
    // GitHub Copilot — device login flow
    const { requestDeviceCode, pollForAccessToken, saveCopilotCredentials, isCopilotConfigured } =
      await import("../../providers/github-copilot-auth.js");

    if (isCopilotConfigured()) {
      noteBox(
        `GitHub Copilot already configured ✓\n` + `Using existing credentials.`,
        "GitHub Copilot",
        TON
      );
      apiKey = "";
      STEPS[1].value = `${providerMeta.displayName}  ${DIM("configured ✓")}`;
    } else {
      noteBox(
        `GitHub Copilot requires a one-time device login.\n` +
          `You'll be given a code to enter at github.com/login/device`,
        "GitHub Copilot",
        TON
      );

      const device = await requestDeviceCode();
      noteBox(
        `Visit: ${CYAN(device.verification_uri)}\n` + `Enter code: ${WHITE(device.user_code)}`,
        "Authorize",
        TON
      );

      prompter.log("Waiting for GitHub authorization...");
      const expiresAt = Date.now() + device.expires_in * 1000;
      const intervalMs = Math.max(1000, device.interval * 1000);
      const token = await pollForAccessToken({
        deviceCode: device.device_code,
        expiresAt,
        intervalMs,
      });

      saveCopilotCredentials(token);
      apiKey = "";
      STEPS[1].value = `${providerMeta.displayName}  ${DIM("authorized ✓")}`;
    }
  } else if (selectedProvider === "anthropic") {
    // Anthropic — offer subscription (setup-token) or API key
    const authMethod = await select({
      message: "Authentication method",
      default: "subscription",
      theme,
      choices: [
        {
          value: "subscription",
          name: "⭐ Claude Subscription (Recommended)",
          description: "Use your Claude Pro/Max plan — no extra charges",
        },
        {
          value: "api-key",
          name: "API Key (Pay-as-you-go)",
          description: "Usage-based billing from console.anthropic.com",
        },
      ],
    });

    if (authMethod === "subscription") {
      noteBox(
        "Connect your Claude Pro/Max subscription\n\n" +
          "Your browser will open to sign in with your Claude account.\n" +
          "After signing in, you'll be redirected back automatically.\n" +
          "No extra tools or CLI needed — just sign in and you're done!",
        "Claude Subscription",
        TON
      );

      const { hasClaudeCodeCredentials, getClaudeAccessToken } =
        await import("../../providers/claude-oauth-flow.js");

      // Check if already logged in
      if (hasClaudeCodeCredentials()) {
        const token = getClaudeAccessToken();
        if (token) {
          apiKey = token;
          prompter.log(GREEN("✓ Claude subscription detected automatically!"));
        }
      }

      if (!apiKey) {
        noteBox(
          "Connect your Claude Pro/Max subscription\n\n" +
            "Step 1: Open a SECOND terminal/PowerShell window\n\n" +
            "Step 2: Run this command:\n" +
            "   npx @anthropic-ai/claude-code auth login\n\n" +
            "   (If that doesn't work, try:)\n" +
            "   npx @anthropic-ai/claude-code login\n\n" +
            "Step 3: Browser opens → sign in with your Claude account\n" +
            "        Wait for 'Successfully logged in' message\n\n" +
            "Step 4: Come back HERE and press Enter",
          "Claude Subscription",
          TON
        );

        let retries = 0;
        while (!apiKey && retries < 3) {
          await input({
            message:
              retries === 0
                ? "Press Enter after you've logged in..."
                : "Credentials not found yet. Login in other terminal, then press Enter...",
            theme,
          });

          if (hasClaudeCodeCredentials()) {
            const token = getClaudeAccessToken();
            if (token) {
              apiKey = token;
              prompter.log(GREEN("✓ Claude subscription connected!"));
              break;
            }
          }

          retries++;
          if (retries < 3) {
            prompter.warn(
              "Claude credentials not found at ~/.claude/.credentials.json\n" +
                "Make sure you ran the login command and saw 'Successfully logged in'"
            );
          }
        }

        if (!apiKey) {
          prompter.warn("Could not detect Claude credentials after 3 attempts.");
          const useFallback = await confirm({
            message: "Use an API key instead?",
            default: true,
            theme,
          });
          if (useFallback) {
            apiKey = await password({
              message: "Anthropic API Key",
              theme,
              validate: (value = "") => validateApiKeyFormat("anthropic", value) ?? true,
            });
          } else {
            throw new CancelledError();
          }
        }
      }
      STEPS[1].value = `${providerMeta.displayName}  ${DIM("subscription ✓")}`;
    } else {
      noteBox(`Anthropic API key required.\nGet it at: ${providerMeta.consoleUrl}`, "API Key", TON);
      apiKey = await password({
        message: `Anthropic API Key (${providerMeta.keyHint})`,
        theme,
        validate: (value = "") => validateApiKeyFormat(selectedProvider, value) ?? true,
      });
      const maskedKey = apiKey.length > 10 ? apiKey.slice(0, 6) + "..." + apiKey.slice(-4) : "***";
      STEPS[1].value = `${providerMeta.displayName}  ${DIM(maskedKey)}`;
    }
  } else {
    // Standard providers — API key required
    const envApiKey = process.env.TELECLAW_API_KEY;
    if (options.apiKey) {
      apiKey = options.apiKey;
    } else if (envApiKey) {
      const validationError = validateApiKeyFormat(selectedProvider, envApiKey);
      if (validationError) {
        prompter.warn(`TELECLAW_API_KEY env var found but invalid: ${validationError}`);
        apiKey = await password({
          message: `${providerMeta.displayName} API Key (${providerMeta.keyHint})`,
          theme,
          validate: (value = "") => validateApiKeyFormat(selectedProvider, value) ?? true,
        });
      } else {
        prompter.log(`Using API key from TELECLAW_API_KEY env var`);
        apiKey = envApiKey;
      }
    } else {
      noteBox(
        `${providerMeta.displayName} API key required.\nGet it at: ${providerMeta.consoleUrl}`,
        "API Key",
        TON
      );
      apiKey = await password({
        message: `${providerMeta.displayName} API Key (${providerMeta.keyHint})`,
        theme,
        validate: (value = "") => validateApiKeyFormat(selectedProvider, value) ?? true,
      });
    }

    const maskedKey = apiKey.length > 10 ? apiKey.slice(0, 6) + "..." + apiKey.slice(-4) : "***";
    STEPS[1].value = `${providerMeta.displayName}  ${DIM(maskedKey)}`;
  }

  // Model selection (advanced mode only, after provider + API key)
  selectedModel = providerMeta.defaultModel;

  if (selectedProvider !== "cocoon" && selectedProvider !== "local") {
    const providerModels = getModelsForProvider(selectedProvider);
    const modelChoices = [
      ...providerModels,
      { value: "__custom__", name: "Custom", description: "Enter a model ID manually" },
    ];

    const modelChoice = await select({
      message: "Model",
      default: providerMeta.defaultModel,
      theme,
      choices: modelChoices,
    });

    if (modelChoice === "__custom__") {
      const customModel = await input({
        message: "Model ID",
        default: providerMeta.defaultModel,
        theme,
      });
      if (customModel?.trim()) selectedModel = customModel.trim();
    } else {
      selectedModel = modelChoice;
    }

    const modelLabel = providerModels.find((m) => m.value === selectedModel)?.name ?? selectedModel;
    STEPS[1].value = `${STEPS[1].value ?? providerMeta.displayName}, ${modelLabel}`;
  }

  // ════════════════════════════════════════════════════════════════════
  // Step 2: Config — admin + policies
  // ════════════════════════════════════════════════════════════════════
  redraw(2);

  // Admin — first /start sender becomes admin automatically
  _userId = 0;

  dmPolicy = await select({
    message: "DM policy (private messages)",
    default: "admin-only",
    theme,
    choices: [
      {
        value: "admin-only" as const,
        name: "Admin Only",
        description: "Only admins can DM the agent",
      },
      { value: "allowlist" as const, name: "Allowlist", description: "Only specific users" },
      { value: "open" as const, name: "Open", description: "Reply to everyone" },
      { value: "disabled" as const, name: "Disabled", description: "Ignore all DMs" },
    ],
  });

  groupPolicy = await select({
    message: "Group policy",
    default: "admin-only",
    theme,
    choices: [
      {
        value: "admin-only" as const,
        name: "Admin Only",
        description: "Only admins can trigger the agent",
      },
      { value: "allowlist" as const, name: "Allowlist", description: "Only specific groups" },
      { value: "open" as const, name: "Open", description: "Reply in all groups" },
      { value: "disabled" as const, name: "Disabled", description: "Ignore all group messages" },
    ],
  });

  requireMention = await confirm({
    message: "Require @mention in groups?",
    default: true,
    theme,
  });

  maxAgenticIterations = await input({
    message: "Max agentic iterations (tool call loops per message)",
    default: "5",
    theme,
    validate: (v) => {
      const n = parseInt(v, 10);
      return !isNaN(n) && n >= 1 && n <= 50 ? true : "Must be 1–50";
    },
  });

  execMode = await select({
    message: "Coding Agent (system execution)",
    choices: [
      { value: "off" as const, name: "Disabled", description: "No system execution capability" },
      {
        value: "yolo" as const,
        name: "YOLO Mode",
        description: "Full system access — STRONGLY RECOMMENDED to use a dedicated VPS",
      },
    ],
    default: "off",
    theme,
  });

  STEPS[2].value = `${dmPolicy}/${groupPolicy}`;

  // ════════════════════════════════════════════════════════════════════
  // Step 3: Modules — optional API keys
  // ════════════════════════════════════════════════════════════════════
  redraw(3);

  const extras: string[] = [];

  // TonAPI key
  const setupTonapi = await confirm({
    message: `Add a TonAPI key? ${DIM("(strongly recommended for TON features)")}`,
    default: false,
    theme,
  });

  if (setupTonapi) {
    noteBox(
      "Blockchain data — jettons, NFTs, prices, transaction history.\n" +
        "Without key: 1 req/s (you WILL hit rate limits)\n" +
        "With free key: 5 req/s\n" +
        "\n" +
        "Open @tonapibot on Telegram → mini app → generate a server key",
      "TonAPI",
      TON
    );
    const keyInput = await input({
      message: "TonAPI key",
      theme,
      validate: (v) => {
        if (!v || v.length < 10) return "Key too short";
        return true;
      },
    });
    tonapiKey = keyInput;
    extras.push("TonAPI");
  }

  // TonCenter key
  const setupToncenter = await confirm({
    message: `Add a TonCenter API key? ${DIM("(optional, dedicated RPC endpoint)")}`,
    default: false,
    theme,
  });

  if (setupToncenter) {
    noteBox(
      "Blockchain RPC — send transactions, check balances.\n" +
        "Without key: falls back to ORBS network (decentralized, slower)\n" +
        "With free key: dedicated RPC endpoint\n" +
        "\n" +
        "Go to https://toncenter.com → get a free API key (instant, no signup)",
      "TonCenter",
      TON
    );
    const keyInput = await input({
      message: "TonCenter API key",
      theme,
      validate: (v) => {
        if (!v || v.length < 10) return "Key too short";
        return true;
      },
    });
    toncenterApiKey = keyInput;
    extras.push("TonCenter");
  }

  // Web Search provider
  const setupSearch = await confirm({
    message: `Enable web search? ${DIM("(Brave, Gemini, Grok, Kimi, or Perplexity)")}`,
    default: false,
    theme,
  });

  if (setupSearch) {
    const providerChoice = await select({
      message: "Search provider",
      choices: [
        { name: "Brave Search (1,000 free queries/month)", value: "brave" },
        { name: "Gemini (Google Search grounding)", value: "gemini" },
        { name: "Grok (xAI web search)", value: "grok" },
        { name: "Kimi (Moonshot web search)", value: "kimi" },
        { name: "Perplexity Search API", value: "perplexity" },
      ],
      theme,
    });
    searchProvider = providerChoice as "brave" | "gemini" | "grok" | "kimi" | "perplexity";

    const providerInfo: Record<string, { url: string; prefix: string; hint: string }> = {
      brave: { url: "https://brave.com/search/api/", prefix: "BSA", hint: "Brave Search API key" },
      gemini: { url: "https://aistudio.google.com/apikey", prefix: "AIza", hint: "Gemini API key" },
      grok: { url: "https://console.x.ai/", prefix: "xai-", hint: "xAI API key" },
      kimi: {
        url: "https://platform.moonshot.cn/console/api-keys",
        prefix: "",
        hint: "Moonshot API key",
      },
      perplexity: {
        url: "https://www.perplexity.ai/settings/api",
        prefix: "pplx-",
        hint: "Perplexity API key",
      },
    };

    const info = providerInfo[providerChoice];
    noteBox(
      `Get your API key:\n\n  ${info.url}\n\nPaste it below.`,
      `${providerChoice.charAt(0).toUpperCase() + providerChoice.slice(1)} — Web Search`,
      TON
    );
    const keyInput = await input({
      message: info.hint,
      theme,
      validate: (v) => {
        if (!v || v.trim().length < 5) return "API key is too short";
        return true;
      },
    });
    searchApiKey = keyInput;
    extras.push(`Web Search (${providerChoice})`);
  }

  STEPS[3].value = extras.length ? extras.join(", ") : "defaults";

  // ════════════════════════════════════════════════════════════════════
  // Step 4: Wallet — generate / import / keep
  // ════════════════════════════════════════════════════════════════════
  redraw(4);

  let wallet;
  const existingWallet = walletExists() ? loadWallet() : null;

  if (existingWallet) {
    noteBox(`Existing wallet found: ${existingWallet.address}`, "TON Wallet", TON);

    const walletAction = await select({
      message: "A TON wallet already exists. What do you want to do?",
      default: "keep",
      theme,
      choices: [
        { value: "keep", name: "Keep existing", description: existingWallet.address },
        {
          value: "regenerate",
          name: "Generate new",
          description: "WARNING: old wallet will be lost",
        },
        { value: "import", name: "Import mnemonic", description: "Restore from 24-word seed" },
      ],
    });

    if (walletAction === "keep") {
      wallet = existingWallet;
    } else if (walletAction === "import") {
      const mnemonicInput = await input({
        message: "Enter your 24-word mnemonic (space-separated)",
        theme,
        validate: (value = "") => {
          const words = value.trim().split(/\s+/);
          return words.length === 24 ? true : `Expected 24 words, got ${words.length}`;
        },
      });
      spinner.start(DIM("Importing wallet..."));
      wallet = await importWallet(mnemonicInput.trim().split(/\s+/));
      saveWallet(wallet);
      spinner.succeed(DIM(`Wallet imported: ${wallet.address}`));
    } else {
      spinner.start(DIM("Generating new TON wallet..."));
      wallet = await generateWallet();
      saveWallet(wallet);
      spinner.succeed(DIM("New TON wallet generated"));
    }
  } else {
    const walletAction = await select({
      message: "TON Wallet",
      default: "generate",
      theme,
      choices: [
        {
          value: "generate",
          name: "Generate new wallet",
          description: "Create a fresh TON wallet",
        },
        { value: "import", name: "Import from mnemonic", description: "Restore from 24-word seed" },
      ],
    });

    if (walletAction === "import") {
      const mnemonicInput = await input({
        message: "Enter your 24-word mnemonic (space-separated)",
        theme,
        validate: (value = "") => {
          const words = value.trim().split(/\s+/);
          return words.length === 24 ? true : `Expected 24 words, got ${words.length}`;
        },
      });
      spinner.start(DIM("Importing wallet..."));
      wallet = await importWallet(mnemonicInput.trim().split(/\s+/));
      saveWallet(wallet);
      spinner.succeed(DIM(`Wallet imported: ${wallet.address}`));
    } else {
      spinner.start(DIM("Generating TON wallet..."));
      wallet = await generateWallet();
      saveWallet(wallet);
      spinner.succeed(DIM("TON wallet generated"));
    }
  }

  // Display mnemonic for new/regenerated wallets
  if (!existingWallet || wallet !== existingWallet) {
    const W = FRAME_WIDTH;
    const mnTitle = "  ⚠  BACKUP REQUIRED — WRITE DOWN THESE 24 WORDS";

    console.log();
    console.log(RED(`  ┌${"─".repeat(W)}┐`));
    console.log(RED("  │") + RED.bold(padRight(mnTitle, W)) + RED("│"));
    console.log(RED(`  ├${"─".repeat(W)}┤`));
    console.log(RED("  │") + " ".repeat(W) + RED("│"));

    const cols = 4;
    const wordWidth = Math.max(10, Math.floor((W - 8) / cols) - 5);
    const words = wallet.mnemonic;
    for (let r = 0; r < 6; r++) {
      const parts: string[] = [];
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const num = String(idx + 1).padStart(2, " ");
        parts.push(`${DIM(num + ".")} ${WHITE(padRight(words[idx], wordWidth))}`);
      }
      const line = `  ${parts.join("  ")}`;
      const visPad = W - stripAnsi(line).length;
      console.log(RED("  │") + line + " ".repeat(Math.max(0, visPad)) + RED("│"));
    }

    console.log(RED("  │") + " ".repeat(W) + RED("│"));
    console.log(
      RED("  │") +
        padRightAnsi(DIM("  These words allow you to recover your wallet."), W) +
        RED("│")
    );
    console.log(
      RED("  │") +
        padRightAnsi(DIM("  Without them, you will lose access to your TON."), W) +
        RED("│")
    );
    console.log(
      RED("  │") + padRightAnsi(DIM("  Write them on paper and keep them safe."), W) + RED("│")
    );
    console.log(RED("  │") + " ".repeat(W) + RED("│"));
    console.log(RED(`  └${"─".repeat(W)}┘`));
    console.log();

    await confirm({
      message: "I have written down my seed phrase",
      default: true,
      theme,
    });
  }

  STEPS[4].value = `${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)}`;

  // ════════════════════════════════════════════════════════════════════
  // Step 5: Bot Token (from @BotFather)
  // ════════════════════════════════════════════════════════════════════
  {
    redraw(STEPS.length - 1);

    noteBox(
      "Create a bot with @BotFather on Telegram:\n" +
        "\n" +
        "  1. Open @BotFather in Telegram\n" +
        "  2. Send /newbot and follow the instructions\n" +
        "  3. Copy the bot token (format: 123456:ABC-DEF)\n" +
        "\n" +
        "Your bot will be your AI agent — users chat with it directly.",
      "Bot Token",
      TON
    );

    const tokenInput = await input({
      message: "Bot token (from @BotFather)",
      theme,
      validate: (value: string) => {
        const clean = (value || "").replace(/[^\x20-\x7E]/g, "").trim();
        if (!clean) return "Bot token is required";
        if (!clean.match(/^\d{8,15}:[A-Za-z0-9_-]{30,50}$/)) {
          return "Invalid format. Expected: 1234567890:ABCdefGHIjklMNO (numeric ID, colon, alphanumeric hash)";
        }
        return true;
      },
    });

    // Validate bot token
    spinner.start(DIM("Validating bot token..."));
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${tokenInput}/getMe`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Telegram API response
      const data = (await res.json()) as any;
      if (!data.ok) {
        spinner.fail("Bot token is invalid. Please check and try again.");
        process.exit(1);
      }
      botToken = tokenInput.replace(/[^\x20-\x7E]/g, "").trim();
      botUsername = data.result.username;
      spinner.succeed(`Bot verified: @${botUsername}`);
      STEPS[STEPS.length - 1].value = `@${botUsername}`;
    } catch {
      spinner.warn(DIM("Could not validate (network error) — saving anyway"));
      botToken = tokenInput.replace(/[^\x20-\x7E]/g, "").trim();
      STEPS[STEPS.length - 1].value = "saved";
    }
  }

  // Step: Save config
  // ════════════════════════════════════════════════════════════════════
  redraw(STEPS.length);

  // Build config
  const config: Config = {
    meta: {
      version: "1.0.0",
      created_at: new Date().toISOString(),
      onboard_command: "teleclaw setup",
    },
    agent: {
      provider: selectedProvider,
      api_key: "", // Key stored in .env file, loaded at runtime
      ...(selectedProvider === "local" && localBaseUrl ? { base_url: localBaseUrl } : {}),
      model: selectedModel,
      max_tokens: 4096,
      temperature: 0.7,
      system_prompt: null,
      max_agentic_iterations: parseInt(maxAgenticIterations, 10),
      session_reset_policy: {
        daily_reset_enabled: true,
        daily_reset_hour: 4,
        idle_expiry_enabled: true,
        idle_expiry_minutes: 1440,
      },
    },
    telegram: {
      mode: "bot" as const,
      api_id: 0,
      api_hash: "",
      phone: "",
      session_name: "teleclaw_session",
      session_path: workspace.sessionPath,
      dm_policy: dmPolicy,
      allow_from: [],
      group_policy: groupPolicy,
      group_allow_from: [],
      require_mention: requireMention,
      max_message_length: TELEGRAM_MAX_MESSAGE_LENGTH,
      typing_simulation: true,
      rate_limit_messages_per_second: 1.0,
      rate_limit_groups_per_minute: 20,
      admin_ids: [],
      // First /start sender becomes admin automatically
      agent_channel: null,
      debounce_ms: 1500,
      bot_token: botToken,
      bot_username: botUsername,
    },
    storage: {
      sessions_file: `${workspace.root}/sessions.json`,
      memory_file: `${workspace.root}/memory.json`,
      history_limit: 100,
    },
    embedding: { provider: "local" },
    deals: DealsConfigSchema.parse({ enabled: !!botToken }),
    webui: {
      enabled: false,
      port: 7777,
      host: "127.0.0.1",
      cors_origins: ["http://localhost:5173", "http://localhost:7777"],
      log_requests: false,
    },
    dev: { hot_reload: false },
    tool_rag: {
      enabled: true,
      top_k: 25,
      always_include: [
        "telegram_send_message",
        "telegram_reply_message",
        "telegram_send_photo",
        "telegram_send_document",
        "journal_*",
        "workspace_*",
        "web_*",
      ],
      skip_unlimited_providers: false,
    },
    logging: { level: "info", pretty: true },
    mcp: { servers: {} },
    capabilities: {
      exec: {
        mode: execMode,
        scope: "admin-only",
        allowlist: [],
        limits: { timeout: 120, max_output: 50000 },
        audit: { log_commands: true },
      },
    },
    ton_proxy: { enabled: false, port: 8080 },
    plugins: {},
    ...(selectedProvider === "cocoon" ? { cocoon: { port: cocoonInstance } } : {}),
    tonapi_key: tonapiKey,
    toncenter_api_key: toncenterApiKey,
    search_provider: searchProvider ?? "auto",
    ...(searchProvider === "brave" && searchApiKey ? { brave_api_key: searchApiKey } : {}),
    ...(searchProvider === "gemini" && searchApiKey ? { gemini_api_key: searchApiKey } : {}),
    ...(searchProvider === "grok" && searchApiKey ? { xai_api_key: searchApiKey } : {}),
    ...(searchProvider === "kimi" && searchApiKey ? { kimi_api_key: searchApiKey } : {}),
    ...(searchProvider === "perplexity" && searchApiKey
      ? { perplexity_api_key: searchApiKey }
      : {}),
  };

  // Save config
  spinner.start(DIM("Saving configuration..."));
  const configYaml = YAML.stringify(config);
  writeFileSync(workspace.configPath, configYaml, { encoding: "utf-8", mode: 0o600 });
  spinner.succeed(DIM(`Configuration saved: ${workspace.configPath}`));

  // Generate + save encryption secret for API key storage
  const envFilePath = join(homedir(), ".teleclaw", ".env");
  if (!existsSync(envFilePath)) {
    const secret = randomBytes(32).toString("hex");
    const signingKey = randomBytes(32).toString("hex");
    const envContent =
      "# Teleclaw secrets — paylaşma, commit etme\n" +
      `# Oluşturuldu: ${new Date().toISOString()}\n` +
      `export TELECLAW_ENCRYPT_SECRET=${secret}\n` +
      `export TELECLAW_SIGNING_KEY=${signingKey}\n` +
      (apiKey ? `export TELECLAW_API_KEY=${apiKey}\n` : "") +
      (botToken ? `export TELECLAW_BOT_TOKEN=${botToken}\n` : "");

    writeFileSync(envFilePath, envContent, { encoding: "utf-8", mode: 0o600 });
    spinner.succeed(DIM(`Secrets saved: ${envFilePath}`));

    // Shell rc'ye loader ekle
    const shellRcCandidates = [
      join(homedir(), ".bashrc"),
      join(homedir(), ".zshrc"),
      join(homedir(), ".profile"),
    ];
    const loaderLine = `\n# Teleclaw\n[ -f "${envFilePath}" ] && source "${envFilePath}"\n`;
    for (const rc of shellRcCandidates) {
      if (existsSync(rc)) {
        const content = readFileSync(rc, "utf-8");
        if (!content.includes("TELECLAW_ENCRYPT_SECRET")) {
          writeFileSync(rc, content + loaderLine, "utf-8");
        }
        break;
      }
    }

    // Bu session için yükle
    process.env.TELECLAW_ENCRYPT_SECRET = secret;
  } else {
    // Ensure signing key exists in existing env file
    const existingEnv = readFileSync(envFilePath, "utf-8");
    if (!existingEnv.includes("TELECLAW_SIGNING_KEY")) {
      const signingKey = randomBytes(32).toString("hex");
      const appendContent = `export TELECLAW_SIGNING_KEY=${signingKey}\n`;
      writeFileSync(envFilePath, existingEnv + appendContent, { encoding: "utf-8", mode: 0o600 });
      spinner.succeed(DIM(`Signing key added to: ${envFilePath}`));
    }
  }

  // Bot mode — already validated token above, no further auth needed
  const telegramConnected = true;

  // ════════════════════════════════════════════════════════════════════
  // Final summary
  // ════════════════════════════════════════════════════════════════════
  console.clear();
  console.log();
  console.log(wizardFrame(STEPS.length, STEPS));
  console.log();
  console.log(finalSummaryBox(STEPS, telegramConnected));
  console.log();
  noteBox(
    "API key'lerin şifreli saklanıyor.\n" +
      "\n" +
      `Secret dosyası: ~/.teleclaw/.env\n` +
      "\n" +
      "Bot her başladığında bu dosyayı yüklemeli:\n" +
      "  source ~/.teleclaw/.env && teleclaw start\n" +
      "\n" +
      "veya shell rc dosyan zaten güncellendi (yeni terminal aç).",
    "🔑 Encryption Secret",
    TON
  );
  console.log();
  console.log(
    `  ${GREEN.bold("✔")} ${GREEN.bold("Setup complete!")} ${DIM(`Config saved to ${workspace.configPath}`)}`
  );
  console.log(`  ${TON.bold("⚡")} Starting agent...\n`);

  // Auto-start the agent after setup
  const { TeleclawApp } = await import("../../index.js");
  const app = new TeleclawApp(workspace.configPath);
  await app.start();
}

/**
 * Non-interactive onboarding (requires all options)
 */
async function runNonInteractiveOnboarding(
  options: OnboardOptions,
  prompter: ReturnType<typeof createPrompter>
): Promise<void> {
  const selectedProvider = options.provider || "anthropic";
  const needsApiKey = selectedProvider !== "cocoon" && selectedProvider !== "local";
  if (!options.userId) {
    prompter.error("Non-interactive mode requires: --user-id");
    process.exit(1);
  }
  if (needsApiKey && !options.apiKey) {
    prompter.error(`Non-interactive mode requires --api-key for provider "${selectedProvider}"`);
    process.exit(1);
  }
  if (selectedProvider === "local" && !options.baseUrl) {
    prompter.error("Non-interactive mode requires --base-url for local provider");
    process.exit(1);
  }

  const workspace = await ensureWorkspace({
    workspaceDir: options.workspace,
    ensureTemplates: true,
  });

  const providerMeta = getProviderMetadata(selectedProvider);

  const config: Config = {
    meta: {
      version: "1.0.0",
      created_at: new Date().toISOString(),
      onboard_command: "teleclaw setup",
    },
    agent: {
      provider: selectedProvider,
      api_key: options.apiKey || "",
      ...(options.baseUrl ? { base_url: options.baseUrl } : {}),
      model: providerMeta.defaultModel,
      max_tokens: 4096,
      temperature: 0.7,
      system_prompt: null,
      max_agentic_iterations: 5,
      session_reset_policy: {
        daily_reset_enabled: true,
        daily_reset_hour: 4,
        idle_expiry_enabled: true,
        idle_expiry_minutes: 1440,
      },
    },
    telegram: {
      mode: "bot" as const,
      api_id: 0,
      api_hash: "",
      phone: "",
      session_name: "teleclaw_session",
      session_path: workspace.sessionPath,
      dm_policy: "admin-only",
      allow_from: [],
      group_policy: "admin-only",
      group_allow_from: [],
      require_mention: true,
      max_message_length: TELEGRAM_MAX_MESSAGE_LENGTH,
      typing_simulation: true,
      rate_limit_messages_per_second: 1.0,
      rate_limit_groups_per_minute: 20,
      admin_ids: [options.userId],
      owner_id: options.userId,
      agent_channel: null,
      debounce_ms: 1500,
      bot_token: options.botToken,
      bot_username: undefined,
    },
    storage: {
      sessions_file: `${workspace.root}/sessions.json`,
      memory_file: `${workspace.root}/memory.json`,
      history_limit: 100,
    },
    embedding: { provider: "local" },
    deals: DealsConfigSchema.parse({ enabled: !!options.botToken }),
    webui: {
      enabled: false,
      port: 7777,
      host: "127.0.0.1",
      cors_origins: ["http://localhost:5173", "http://localhost:7777"],
      log_requests: false,
    },
    dev: { hot_reload: false },
    tool_rag: {
      enabled: true,
      top_k: 25,
      always_include: [
        "telegram_send_message",
        "telegram_reply_message",
        "telegram_send_photo",
        "telegram_send_document",
        "journal_*",
        "workspace_*",
        "web_*",
      ],
      skip_unlimited_providers: false,
    },
    logging: { level: "info", pretty: true },
    capabilities: {
      exec: {
        mode: "off",
        scope: "admin-only",
        allowlist: [],
        limits: { timeout: 120, max_output: 50000 },
        audit: { log_commands: true },
      },
    },
    ton_proxy: { enabled: false, port: 8080 },
    mcp: { servers: {} },
    plugins: {},
    search_provider:
      (options.searchProvider as "brave" | "gemini" | "grok" | "kimi" | "perplexity") ?? "auto",
    ...(options.searchApiKey && options.searchProvider === "brave"
      ? { brave_api_key: options.searchApiKey }
      : {}),
    ...(options.searchApiKey && options.searchProvider === "gemini"
      ? { gemini_api_key: options.searchApiKey }
      : {}),
    ...(options.searchApiKey && options.searchProvider === "grok"
      ? { xai_api_key: options.searchApiKey }
      : {}),
    ...(options.searchApiKey && options.searchProvider === "kimi"
      ? { kimi_api_key: options.searchApiKey }
      : {}),
    ...(options.searchApiKey && options.searchProvider === "perplexity"
      ? { perplexity_api_key: options.searchApiKey }
      : {}),
  };

  const configYaml = YAML.stringify(config);
  writeFileSync(workspace.configPath, configYaml, { encoding: "utf-8", mode: 0o600 });

  prompter.success(`Configuration created: ${workspace.configPath}`);

  // Secrets (non-interactive mode)
  const niEnvFile = join(homedir(), ".teleclaw", ".env");
  if (!existsSync(niEnvFile)) {
    const niSecret = randomBytes(32).toString("hex");
    const niSigningKey = randomBytes(32).toString("hex");
    const niEnvContent =
      "# Teleclaw secrets\n" +
      `export TELECLAW_ENCRYPT_SECRET=${niSecret}\n` +
      `export TELECLAW_SIGNING_KEY=${niSigningKey}\n` +
      (options.apiKey ? `export TELECLAW_API_KEY=${options.apiKey}\n` : "") +
      (options.botToken ? `export TELECLAW_BOT_TOKEN=${options.botToken}\n` : "");
    writeFileSync(niEnvFile, niEnvContent, { encoding: "utf-8", mode: 0o600 });
    process.env.TELECLAW_ENCRYPT_SECRET = niSecret;
    prompter.success(`Secrets saved: ${niEnvFile}`);
  }
}
