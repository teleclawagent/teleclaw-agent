import { Command } from "commander";
import { onboardCommand } from "./commands/onboard.js";
import { doctorCommand } from "./commands/doctor.js";
import { mcpAddCommand, mcpRemoveCommand, mcpListCommand } from "./commands/mcp.js";
import { configCommand } from "./commands/config.js";
import { skillCreate, skillList, skillRemove } from "./commands/skill.js";
import { main as startApp } from "../index.js";
import { configExists, getDefaultConfigPath } from "../config/loader.js";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getErrorMessage } from "../utils/errors.js";

function findPackageJson(): Record<string, unknown> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8"));
    }
    dir = dirname(dir);
  }
  return { version: "0.0.0" };
}
const packageJson = findPackageJson();

const program = new Command();

program
  .name("teleclaw")
  .description("Teleclaw Agent - Personal AI Agent for Telegram")
  .version(packageJson.version as string);

// Setup command
program
  .command("setup")
  .description("Interactive wizard to set up Teleclaw")
  .option("--workspace <dir>", "Workspace directory")
  .option("--non-interactive", "Non-interactive mode")
  .option("--ui", "Launch web-based setup wizard")
  .option("--ui-port <port>", "Port for setup WebUI", "7777")
  .option("--api-key <key>", "LLM provider API key")
  .option("--base-url <url>", "Base URL for local LLM server")
  .option("--user-id <id>", "Telegram User ID")
  .option("--search-provider <provider>", "Search provider: brave, gemini, grok, kimi, perplexity")
  .option("--search-api-key <key>", "API key for web search provider")
  .option("--bot-token <token>", "Telegram bot token from @BotFather")
  .action(async (options) => {
    try {
      await onboardCommand({
        workspace: options.workspace,
        nonInteractive: options.nonInteractive,
        ui: options.ui,
        uiPort: options.uiPort,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        userId: options.userId ? parseInt(options.userId) : undefined,
        searchProvider: options.searchProvider,
        searchApiKey: options.searchApiKey,
        botToken: options.botToken,
      });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Start command
program
  .command("start")
  .description("Start the Teleclaw agent")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("--webui", "Enable WebUI server (overrides config)")
  .option("--webui-port <port>", "WebUI server port (default: 7777)")
  .action(async (options) => {
    try {
      // Check if config exists
      if (!configExists(options.config)) {
        console.error("❌ Configuration not found");
        console.error(`   Expected file: ${options.config}`);
        console.error("\n💡 Run first: teleclaw setup");
        process.exit(1);
      }

      // Set environment variables for WebUI flags (will be picked up by config loader)
      if (options.webui) {
        process.env.TELECLAW_WEBUI_ENABLED = "true";
      }
      if (options.webuiPort) {
        process.env.TELECLAW_WEBUI_PORT = options.webuiPort;
      }

      await startApp(options.config);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Run system health checks")
  .action(async () => {
    try {
      await doctorCommand();
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// MCP server management
const mcp = program.command("mcp").description("Manage MCP (Model Context Protocol) servers");

mcp
  .command("add <package> [args...]")
  .description(
    "Add an MCP server (e.g. teleclaw mcp add @modelcontextprotocol/server-filesystem /tmp)"
  )
  .option("-n, --name <name>", "Server name (auto-derived from package if omitted)")
  .option("-s, --scope <scope>", "Tool scope: always | dm-only | group-only | admin-only", "always")
  .option(
    "-e, --env <KEY=VALUE...>",
    "Environment variables (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--url", "Treat <package> as an SSE/HTTP URL instead of an npx package")
  .option("-c, --config <path>", "Config file path")
  .action(async (pkg: string, args: string[], options) => {
    try {
      await mcpAddCommand(pkg, args, options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

mcp
  .command("remove <name>")
  .description("Remove an MCP server by name")
  .option("-c, --config <path>", "Config file path")
  .action(async (name: string, options) => {
    try {
      await mcpRemoveCommand(name, options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

mcp
  .command("list")
  .description("List configured MCP servers")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await mcpListCommand(options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Config management
program
  .command("config")
  .description("Manage configuration keys (set, get, list, unset)")
  .argument("<action>", "set | get | list | unset")
  .argument("[key]", "Config key (e.g., brave_api_key, telegram.bot_token)")
  .argument("[value]", "Value to set (prompts interactively if omitted)")
  .option("-c, --config <path>", "Config file path")
  .action(async (action: string, key: string | undefined, value: string | undefined, options) => {
    try {
      await configCommand(action, key, value, options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

program.action(() => {
  program.help();
});

// Skill commands
const skill = program.command("skill").description("Manage custom skills (plugins)");

skill
  .command("create <name>")
  .description("Create a new skill from template")
  .action((name: string) => {
    skillCreate(name);
  });

skill
  .command("list")
  .description("List installed skills")
  .action(() => {
    skillList();
  });

skill
  .command("remove <name>")
  .description("Remove a skill (moves to trash)")
  .action((name: string) => {
    skillRemove(name);
  });

program.parse(process.argv);
