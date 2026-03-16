/**
 * Teleclaw Skill CLI — create, list, and manage custom skills (plugins)
 *
 * Skills are lightweight plugins that add new tools to Teleclaw.
 * They live in ~/.teleclaw/plugins/<skill-name>/
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, renameSync } from "fs";
import { join, basename } from "path";
import { WORKSPACE_PATHS } from "../../workspace/paths.js";

const PLUGINS_DIR = WORKSPACE_PATHS.PLUGINS_DIR;

// ── Skill Template ──

const SKILL_INDEX_TEMPLATE = (name: string, toolName: string) => `/**
 * ${name} — Custom Teleclaw Skill
 *
 * This skill adds the "${toolName}" tool to your Teleclaw agent.
 * Edit this file to customize the tool's behavior.
 *
 * Docs: https://github.com/gioooton/teleclaw-agent/wiki/Skills
 */

export const manifest = {
  name: "${name}",
  version: "1.0.0",
  description: "A custom Teleclaw skill",
};

export const tools = [
  {
    name: "${toolName}",
    description: "Describe what this tool does — the AI reads this to decide when to use it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Input query or parameter",
        },
      },
      required: ["query"],
    },
    execute: async (params, context) => {
      // params.query — the input from the AI
      // context.chatId — current chat ID
      // context.senderId — user's Telegram ID
      // context.bridge — send messages, media, etc.

      // Your skill logic here:
      const result = \`Hello from ${name}! You said: \${params.query}\`;

      return {
        success: true,
        data: { result },
      };
    },
  },
];
`;

const SKILL_README_TEMPLATE = (name: string) => `# ${name}

A custom Teleclaw skill.

## Tools

- **tool_name** — Describe what it does

## Installation

This skill is auto-loaded from \`~/.teleclaw/plugins/${name}/\`.

## Configuration

Add to your \`config.yaml\`:

\`\`\`yaml
plugins:
  ${name}:
    # your config here
\`\`\`

Config is available in your tool via \`context.config?.plugins?.${name}\`.
`;

// ── Commands ──

export function skillCreate(name: string): void {
  if (!name || name.trim().length === 0) {
    console.error("❌ Skill name is required. Usage: teleclaw skill create <name>");
    process.exit(1);
  }

  const skillName = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  const toolName = skillName.replace(/-/g, "_");
  const skillDir = join(PLUGINS_DIR, skillName);

  if (existsSync(skillDir)) {
    console.error(`❌ Skill "${skillName}" already exists at ${skillDir}`);
    process.exit(1);
  }

  // Create skill directory
  mkdirSync(skillDir, { recursive: true });

  // Write template files
  writeFileSync(join(skillDir, "index.js"), SKILL_INDEX_TEMPLATE(skillName, toolName));
  writeFileSync(join(skillDir, "README.md"), SKILL_README_TEMPLATE(skillName));

  console.log(`\n  ✅ Skill "${skillName}" created!\n`);
  console.log(`  📁 ${skillDir}/`);
  console.log(`     ├── index.js    — Tool definitions`);
  console.log(`     └── README.md   — Documentation\n`);
  console.log(`  Next steps:`);
  console.log(`  1. Edit ${skillDir}/index.js`);
  console.log(`  2. Restart Teleclaw (or use hot-reload)`);
  console.log(`  3. Your "${toolName}" tool is now available!\n`);
}

export function skillList(): void {
  if (!existsSync(PLUGINS_DIR)) {
    console.log("\n  No skills installed. Create one with: teleclaw skill create <name>\n");
    return;
  }

  const entries = readdirSync(PLUGINS_DIR).filter((entry) => {
    const entryPath = join(PLUGINS_DIR, entry);
    return statSync(entryPath).isDirectory() && !entry.startsWith(".");
  });

  if (entries.length === 0) {
    console.log("\n  No skills installed. Create one with: teleclaw skill create <name>\n");
    return;
  }

  console.log(`\n  📦 Installed skills (${entries.length}):\n`);

  for (const entry of entries) {
    const indexPath = join(PLUGINS_DIR, entry, "index.js");
    const manifestPath = join(PLUGINS_DIR, entry, "package.json");
    let version = "";
    let description = "";

    if (existsSync(manifestPath)) {
      try {
        const pkg = JSON.parse(readFileSync(manifestPath, "utf-8"));
        version = pkg.version || "";
        description = pkg.description || "";
      } catch {
        // ignore
      }
    }

    const hasIndex = existsSync(indexPath);
    const status = hasIndex ? "✅" : "⚠️";
    const versionStr = version ? ` v${version}` : "";
    const descStr = description ? ` — ${description}` : "";

    console.log(`  ${status} ${entry}${versionStr}${descStr}`);
  }

  console.log(`\n  Skills directory: ${PLUGINS_DIR}\n`);
}

export function skillRemove(name: string): void {
  if (!name || name.trim().length === 0) {
    console.error("❌ Skill name is required. Usage: teleclaw skill remove <name>");
    process.exit(1);
  }

  const skillDir = join(PLUGINS_DIR, name);

  if (!existsSync(skillDir)) {
    console.error(`❌ Skill "${name}" not found at ${skillDir}`);
    process.exit(1);
  }

  // Move to trash instead of deleting
  const trashDir = join(PLUGINS_DIR, ".trash");
  mkdirSync(trashDir, { recursive: true });

  const trashPath = join(trashDir, `${name}-${Date.now()}`);
  renameSync(skillDir, trashPath);

  console.log(`\n  🗑️  Skill "${name}" removed (moved to ${trashPath})\n`);
}
