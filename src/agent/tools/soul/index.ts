/**
 * src/agent/tools/soul/index.ts
 *
 * Agent'ın kendi SOUL.md, STRATEGY.md ve MEMORY.md dosyalarını
 * okuyup yazabilmesi için iki tool.
 *
 * Neden ayrı bir tool?
 *   workspace_write bu dosyaları IMMUTABLE_FILES listesiyle engelliyor.
 *   Ama kullanıcı "soul'una şunu ekle" dediğinde agent yapabilmeli.
 *   Bu tool o kısıtlamayı aşıp doğrudan yazıyor.
 *
 * Kapsam: dm-only — soul kişisel, grup chatlerde değiştirilmemeli.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { WORKSPACE_PATHS } from "../../../workspace/paths.js";
import { clearPromptCache } from "../../../soul/loader.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

// ── Hangi dosyalar yazılabilir ─────────────────────────────────────────────

const EDITABLE_FILES = {
  soul: WORKSPACE_PATHS.SOUL, // SOUL.md     — karakter, kişilik
  strategy: WORKSPACE_PATHS.STRATEGY, // STRATEGY.md — ticaret/iş stratejisi
  memory: WORKSPACE_PATHS.MEMORY, // MEMORY.md   — kalıcı hafıza
  security: WORKSPACE_PATHS.SECURITY, // SECURITY.md — güvenlik kuralları
} as const;

type EditableFile = keyof typeof EDITABLE_FILES;

// ── soul_read ──────────────────────────────────────────────────────────────

interface SoulReadParams {
  file: EditableFile;
}

const soulReadTool: Tool = {
  name: "soul_read",
  description:
    "Read the content of SOUL.md, STRATEGY.md, MEMORY.md, or SECURITY.md. " +
    "Use this before editing to see the current content.",
  parameters: Type.Object({
    file: Type.Union(
      [
        Type.Literal("soul"),
        Type.Literal("strategy"),
        Type.Literal("memory"),
        Type.Literal("security"),
      ],
      {
        description:
          "'soul' = SOUL.md (personality), 'strategy' = STRATEGY.md, " +
          "'memory' = MEMORY.md, 'security' = SECURITY.md",
      }
    ),
  }),
};

const soulReadExecutor: ToolExecutor<SoulReadParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  const filePath = EDITABLE_FILES[params.file];

  if (!existsSync(filePath)) {
    return {
      success: true,
      data: {
        file: params.file,
        content: "",
        message: `${params.file.toUpperCase()}.md does not exist yet. Use soul_edit to create it.`,
      },
    };
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return {
      success: true,
      data: {
        file: params.file,
        path: filePath,
        content,
        lines: content.split("\n").length,
      },
    };
  } catch (error) {
    log.error({ err: error }, `soul_read: failed to read ${params.file}`);
    return {
      success: false,
      error: `Failed to read ${params.file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ── soul_edit ──────────────────────────────────────────────────────────────

interface SoulEditParams {
  file: EditableFile;
  content: string;
  mode: "overwrite" | "append" | "prepend";
}

const soulEditTool: Tool = {
  name: "soul_edit",
  description:
    "Edit SOUL.md (personality/character), STRATEGY.md (trading strategy), " +
    "MEMORY.md (persistent memory), or SECURITY.md. " +
    "Changes take effect immediately — no restart needed.\n\n" +
    "Modes:\n" +
    "- overwrite: Replace the entire file\n" +
    "- append: Add to the end (good for adding new rules or memories)\n" +
    "- prepend: Add to the beginning\n\n" +
    "Always use soul_read first to see current content before overwriting.",
  parameters: Type.Object({
    file: Type.Union(
      [
        Type.Literal("soul"),
        Type.Literal("strategy"),
        Type.Literal("memory"),
        Type.Literal("security"),
      ],
      {
        description:
          "Which file to edit: 'soul' (SOUL.md), 'strategy' (STRATEGY.md), " +
          "'memory' (MEMORY.md), 'security' (SECURITY.md)",
      }
    ),
    content: Type.String({
      description: "The content to write. For append/prepend, just the new section to add.",
    }),
    mode: Type.Union([Type.Literal("overwrite"), Type.Literal("append"), Type.Literal("prepend")], {
      description:
        "overwrite = replace entire file, append = add to end, prepend = add to beginning. " +
        "Default: append (safest).",
      default: "append",
    }),
  }),
};

const soulEditExecutor: ToolExecutor<SoulEditParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  const { file, content, mode = "append" } = params;
  const filePath = EDITABLE_FILES[file];

  if (!content || content.trim().length === 0) {
    return { success: false, error: "Content cannot be empty." };
  }

  // Max size guard — 200KB per file
  const MAX_SIZE = 200 * 1024;
  if (Buffer.byteLength(content, "utf-8") > MAX_SIZE) {
    return { success: false, error: "Content too large (max 200KB per file)." };
  }

  try {
    let finalContent: string;

    if (mode === "overwrite" || !existsSync(filePath)) {
      finalContent = content;
    } else {
      const existing = readFileSync(filePath, "utf-8");
      if (mode === "append") {
        finalContent = existing.trimEnd() + "\n\n" + content;
      } else {
        // prepend
        finalContent = content.trimEnd() + "\n\n" + existing;
      }
    }

    writeFileSync(filePath, finalContent, { encoding: "utf-8" });

    // Invalidate the soul loader cache so changes take effect immediately
    clearPromptCache();

    const fileName = file.toUpperCase() + ".md";
    log.info(
      { file, mode, bytes: Buffer.byteLength(finalContent, "utf-8") },
      "soul_edit: file updated"
    );

    return {
      success: true,
      data: {
        file,
        path: filePath,
        mode,
        bytes: Buffer.byteLength(finalContent, "utf-8"),
        message: `${fileName} updated (${mode}). Changes are active immediately.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, `soul_edit: failed to write ${file}`);
    return {
      success: false,
      error: `Failed to write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ── Export ─────────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: soulReadTool, executor: soulReadExecutor, scope: "dm-only" },
  { tool: soulEditTool, executor: soulEditExecutor, scope: "dm-only" },
];
