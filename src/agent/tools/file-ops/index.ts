/**
 * File operations tools — read, write, edit files in the workspace.
 * Sandboxed to ~/.teleclaw/workspace/ for safety.
 */

import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname, relative } from "path";
import { homedir } from "os";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";

const WORKSPACE_ROOT = join(homedir(), ".teleclaw", "workspace");

function ensureWorkspace(): void {
  if (!existsSync(WORKSPACE_ROOT)) {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }
}

function safePath(filePath: string): string {
  // Resolve relative to workspace
  const resolved =
    filePath.startsWith("/") || filePath.startsWith("~")
      ? resolve(filePath.replace(/^~/, homedir()))
      : resolve(WORKSPACE_ROOT, filePath);

  // Must be within workspace
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Access denied: path must be within ~/.teleclaw/workspace/`);
  }
  return resolved;
}

// ── file_read ──────────────────────────────────────────────────────────

interface FileReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

const fileReadTool: Tool = {
  name: "file_read",
  description:
    "Read a file from the workspace (~/.teleclaw/workspace/). Use relative paths. Supports offset/limit for large files.",
  category: "data-bearing",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Max lines to read" })),
  }),
};

const fileReadExecutor: ToolExecutor<FileReadParams> = async (params): Promise<ToolResult> => {
  try {
    ensureWorkspace();
    const fullPath = safePath(params.path);

    if (!existsSync(fullPath)) {
      return { success: false, error: `File not found: ${params.path}` };
    }

    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    const offset = (params.offset ?? 1) - 1;
    const limit = params.limit ?? lines.length;
    const slice = lines.slice(offset, offset + limit);

    return {
      success: true,
      data: {
        path: relative(WORKSPACE_ROOT, fullPath),
        content: slice.join("\n"),
        totalLines: lines.length,
        fromLine: offset + 1,
        toLine: Math.min(offset + limit, lines.length),
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── file_write ─────────────────────────────────────────────────────────

interface FileWriteParams {
  path: string;
  content: string;
}

const fileWriteTool: Tool = {
  name: "file_write",
  description: "Write or create a file in the workspace. Creates parent directories automatically.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    content: Type.String({ description: "Content to write" }),
  }),
};

const fileWriteExecutor: ToolExecutor<FileWriteParams> = async (params): Promise<ToolResult> => {
  try {
    ensureWorkspace();
    const fullPath = safePath(params.path);
    const dir = dirname(fullPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, params.content, "utf-8");

    return {
      success: true,
      data: {
        path: relative(WORKSPACE_ROOT, fullPath),
        bytes: Buffer.byteLength(params.content, "utf-8"),
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── file_edit ──────────────────────────────────────────────────────────

interface FileEditParams {
  path: string;
  old_text: string;
  new_text: string;
}

const fileEditTool: Tool = {
  name: "file_edit",
  description:
    "Edit a file by replacing exact text. The old_text must match exactly (including whitespace).",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    old_text: Type.String({ description: "Exact text to find and replace" }),
    new_text: Type.String({ description: "New text to replace with" }),
  }),
};

const fileEditExecutor: ToolExecutor<FileEditParams> = async (params): Promise<ToolResult> => {
  try {
    ensureWorkspace();
    const fullPath = safePath(params.path);

    if (!existsSync(fullPath)) {
      return { success: false, error: `File not found: ${params.path}` };
    }

    const content = readFileSync(fullPath, "utf-8");

    if (!content.includes(params.old_text)) {
      return { success: false, error: "old_text not found in file" };
    }

    const newContent = content.replace(params.old_text, params.new_text);
    writeFileSync(fullPath, newContent, "utf-8");

    return {
      success: true,
      data: {
        path: relative(WORKSPACE_ROOT, fullPath),
        replaced: true,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── file_list ──────────────────────────────────────────────────────────

interface FileListParams {
  path?: string;
}

const fileListTool: Tool = {
  name: "file_list",
  description: "List files and directories in the workspace.",
  category: "data-bearing",
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({ description: "Directory path relative to workspace (default: root)" })
    ),
  }),
};

const fileListExecutor: ToolExecutor<FileListParams> = async (params): Promise<ToolResult> => {
  try {
    ensureWorkspace();
    const fullPath = safePath(params.path || ".");

    if (!existsSync(fullPath)) {
      return { success: false, error: `Directory not found: ${params.path || "."}` };
    }

    const entries = readdirSync(fullPath).map((name) => {
      const entryPath = join(fullPath, name);
      const stat = statSync(entryPath);
      return {
        name,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.isFile() ? stat.size : undefined,
      };
    });

    return {
      success: true,
      data: {
        path: relative(WORKSPACE_ROOT, fullPath) || ".",
        entries,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── Export ──────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: fileReadTool, executor: fileReadExecutor },
  { tool: fileWriteTool, executor: fileWriteExecutor },
  { tool: fileEditTool, executor: fileEditExecutor },
  { tool: fileListTool, executor: fileListExecutor },
];
