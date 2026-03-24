/**
 * src/agent/tools/skill/index.ts
 *
 * Kullanıcının Teleclaw'a skill (plugin) ekleyip kaldırabilmesi için toollar.
 *
 * HOT-RELOAD:
 *   config.yaml'da `dev.hot_reload: true` olursa agent restart olmadan
 *   skill'ler anında aktif olur. false ise restart gerekir.
 *   Kullanıcıya her iki durumda da ne yapması gerektiği söylenir.
 *
 * SKILL FORMAT (~/. teleclaw/plugins/<isim>/index.js):
 *   export const manifest = { name, version, description };
 *   export const tools = [{ name, description, parameters, execute }];
 *
 * Kapsam: dm-only — skill yönetimi kişisel, grup'ta olmamalı.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { WORKSPACE_PATHS } from "../../../workspace/paths.js";
import { fetchWithTimeout } from "../../../utils/fetch.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

const PLUGINS_DIR = WORKSPACE_PATHS.PLUGINS_DIR;

// ── Helpers ────────────────────────────────────────────────────────────────

function ensurePluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

interface SkillInfo {
  name: string;
  version: string;
  description: string;
  toolCount: number;
  path: string;
}

function getInstalledSkills(): SkillInfo[] {
  ensurePluginsDir();
  const skills: SkillInfo[] = [];

  try {
    const entries = readdirSync(PLUGINS_DIR);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const entryPath = join(PLUGINS_DIR, entry);
      if (!statSync(entryPath).isDirectory()) {
        // Single-file plugin
        if (!entry.endsWith(".js")) continue;
        skills.push({
          name: entry.replace(/\.js$/, ""),
          version: "unknown",
          description: "Single-file skill",
          toolCount: 0,
          path: entryPath,
        });
        continue;
      }

      // Directory plugin — try to read manifest
      const manifestPath = join(entryPath, "manifest.json");
      const indexPath = join(entryPath, "index.js");

      if (!existsSync(indexPath)) continue;

      let version = "1.0.0";
      let description = "Custom skill";
      let toolCount = 0;

      if (existsSync(manifestPath)) {
        try {
          const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
          version = m.version ?? version;
          description = m.description ?? description;
        } catch {
          /* ignore */
        }
      }

      // Count tools (rough estimate — count `name:` occurrences in index.js)
      try {
        const src = readFileSync(indexPath, "utf-8");
        toolCount = (src.match(/name:\s*["'`]/g) || []).length;
      } catch {
        /* ignore */
      }

      skills.push({ name: entry, version, description, toolCount, path: entryPath });
    }
  } catch (error) {
    log.error({ err: error }, "skill_list: failed to read plugins dir");
  }

  return skills;
}

function isHotReloadEnabled(context: { config?: { dev?: { hot_reload?: boolean } } }): boolean {
  return context.config?.dev?.hot_reload === true;
}

// ── skill_list ─────────────────────────────────────────────────────────────

const skillListTool: Tool = {
  name: "skill_list",
  description:
    "List all installed custom skills (plugins). " +
    "Skills are user-created tools stored in ~/.teleclaw/plugins/. " +
    "Built-in tools (TON, Telegram, Fragment, etc.) are not listed here.",
  parameters: Type.Object({}),
};

const skillListExecutor: ToolExecutor<Record<never, never>> = async (
  _params,
  _context
): Promise<ToolResult> => {
  const skills = getInstalledSkills();

  if (skills.length === 0) {
    return {
      success: true,
      data: {
        skills: [],
        count: 0,
        pluginsDir: PLUGINS_DIR,
        message: "No custom skills installed yet. Use skill_add to install one.",
      },
    };
  }

  return {
    success: true,
    data: {
      skills: skills.map((s) => ({
        name: s.name,
        version: s.version,
        description: s.description,
        tools: s.toolCount,
        path: s.path,
      })),
      count: skills.length,
      pluginsDir: PLUGINS_DIR,
    },
  };
};

// ── skill_add ──────────────────────────────────────────────────────────────

interface SkillAddParams {
  name: string;
  source: string;
  source_type: "code" | "url";
  description?: string;
}

const skillAddTool: Tool = {
  name: "skill_add",
  description:
    "Install a custom skill (plugin) to extend Teleclaw's capabilities.\n\n" +
    "Two ways to add a skill:\n" +
    "1. source_type='code': Provide JavaScript code directly\n" +
    "2. source_type='url': Download from a URL (GitHub raw, gist, etc.)\n\n" +
    "Skill format (index.js):\n" +
    "  export const manifest = { name, version, description };\n" +
    "  export const tools = [{ name, description, parameters, execute: async (params, ctx) => ({...}) }];\n\n" +
    "After installing: if hot-reload is enabled, the skill is immediately active.\n" +
    "If not, tell the user to restart Teleclaw.",
  parameters: Type.Object({
    name: Type.String({
      description:
        "Skill name (lowercase, letters/numbers/hyphens only). " +
        "Will be the folder name: ~/.teleclaw/plugins/<name>/",
      pattern: "^[a-z0-9][a-z0-9-_]*$",
    }),
    source: Type.String({
      description:
        "For source_type='code': the JavaScript code to write as index.js. " +
        "For source_type='url': the raw URL to download (GitHub raw, Gist, etc.)",
    }),
    source_type: Type.Union([Type.Literal("code"), Type.Literal("url")], {
      description: "'code' = direct JS code, 'url' = download from URL",
    }),
    description: Type.Optional(
      Type.String({
        description: "Short description of what this skill does (saved to manifest.json)",
      })
    ),
  }),
};

const skillAddExecutor: ToolExecutor<SkillAddParams> = async (
  params,
  context
): Promise<ToolResult> => {
  const { name, source, source_type, description } = params;

  // Validate name
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
    return {
      success: false,
      error: "Skill name must be lowercase letters, numbers, hyphens or underscores only.",
    };
  }

  // Reserved names
  const RESERVED = [
    "teleclaw",
    "core",
    "system",
    "ton",
    "telegram",
    "fragment",
    "dedust",
    "stonfi",
  ];
  if (RESERVED.includes(name)) {
    return { success: false, error: `"${name}" is a reserved name. Choose a different name.` };
  }

  ensurePluginsDir();

  const skillDir = join(PLUGINS_DIR, name);
  const indexPath = join(skillDir, "index.js");
  const manifestPath = join(skillDir, "manifest.json");

  const alreadyExists = existsSync(skillDir);

  // Get code
  let code: string;
  if (source_type === "url") {
    try {
      const res = await fetchWithTimeout(source, { timeoutMs: 15_000 });
      if (!res.ok) {
        return { success: false, error: `Failed to download skill: HTTP ${res.status}` };
      }
      code = await res.text();
      if (!code.trim()) {
        return { success: false, error: "Downloaded file is empty." };
      }
    } catch (error) {
      return {
        success: false,
        error: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    code = source;
  }

  // Basic safety check — block obvious node built-ins abuse
  const BLOCKED_PATTERNS = [
    /require\s*\(\s*["']child_process["']\s*\)/,
    /\bexec\s*\(/,
    /\bspawn\s*\(/,
    /process\.exit/,
    /eval\s*\(/,
  ];
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return {
        success: false,
        error: `Skill code contains blocked pattern: ${pattern.toString()}. For security, exec/eval/child_process are not allowed.`,
      };
    }
  }

  // Write files
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(indexPath, code, { encoding: "utf-8" });

    const manifest = {
      name,
      version: "1.0.0",
      description: description ?? `Custom skill: ${name}`,
      installedAt: new Date().toISOString(),
      source: source_type === "url" ? source : "direct",
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });

    log.info({ name, source_type }, `skill_add: skill "${name}" installed`);

    const hotReload = isHotReloadEnabled(context as Parameters<typeof isHotReloadEnabled>[0]);

    return {
      success: true,
      data: {
        name,
        path: skillDir,
        action: alreadyExists ? "updated" : "installed",
        hotReload,
        message: hotReload
          ? `✅ Skill "${name}" ${alreadyExists ? "updated" : "installed"} and active immediately.`
          : `✅ Skill "${name}" ${alreadyExists ? "updated" : "installed"}. Restart Teleclaw to activate it: /stop then start again.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, `skill_add: failed to install "${name}"`);
    return {
      success: false,
      error: `Failed to install skill: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ── skill_remove ───────────────────────────────────────────────────────────

interface SkillRemoveParams {
  name: string;
}

const skillRemoveTool: Tool = {
  name: "skill_remove",
  description:
    "Remove an installed custom skill. " +
    "This permanently deletes the skill folder from ~/.teleclaw/plugins/. " +
    "Cannot remove built-in tools.",
  parameters: Type.Object({
    name: Type.String({
      description: "Name of the skill to remove (same as the folder name in ~/.teleclaw/plugins/)",
    }),
  }),
};

const skillRemoveExecutor: ToolExecutor<SkillRemoveParams> = async (
  params,
  context
): Promise<ToolResult> => {
  const { name } = params;

  ensurePluginsDir();

  const skillDir = join(PLUGINS_DIR, name);
  const singleFile = join(PLUGINS_DIR, `${name}.js`);

  const dirExists = existsSync(skillDir) && statSync(skillDir).isDirectory();
  const fileExists = existsSync(singleFile);

  if (!dirExists && !fileExists) {
    // List what IS installed to help
    const installed = getInstalledSkills().map((s) => s.name);
    return {
      success: false,
      error: `Skill "${name}" not found.${installed.length > 0 ? ` Installed skills: ${installed.join(", ")}` : " No skills installed."}`,
    };
  }

  try {
    if (dirExists) {
      rmSync(skillDir, { recursive: true, force: true });
    } else {
      rmSync(singleFile, { force: true });
    }

    log.info({ name }, `skill_remove: skill "${name}" removed`);

    const hotReload = isHotReloadEnabled(context as Parameters<typeof isHotReloadEnabled>[0]);

    return {
      success: true,
      data: {
        name,
        message: hotReload
          ? `✅ Skill "${name}" removed and deactivated immediately.`
          : `✅ Skill "${name}" removed. Restart Teleclaw for it to fully deactivate.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, `skill_remove: failed to remove "${name}"`);
    return {
      success: false,
      error: `Failed to remove skill: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ── Export ─────────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: skillListTool, executor: skillListExecutor, scope: "dm-only" },
  { tool: skillAddTool, executor: skillAddExecutor, scope: "dm-only" },
  { tool: skillRemoveTool, executor: skillRemoveExecutor, scope: "dm-only" },
];
