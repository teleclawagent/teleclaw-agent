/**
 * Cocoon Tool Adapter
 *
 * Translation layer for tool calling via Cocoon proxy.
 * The proxy doesn't support the OpenAI `tools` parameter, so we:
 * 1. Inject tool definitions into the system prompt (Qwen3 Hermes format)
 * 2. Strip unsupported fields from the request body
 * 3. Parse <tool_call> XML tags from the model's text response
 */

import { randomUUID } from "crypto";
import { createLogger } from "../utils/logger.js";
import type { Tool } from "@mariozechner/pi-ai";

const log = createLogger("Cocoon");

// ── System Prompt Injection ──────────────────────────────────────────

const TOOL_PREAMBLE = `

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
`;

const TOOL_POSTAMBLE = `</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>`;

/**
 * Append Qwen3-style tool definitions to the system prompt.
 */
export function injectToolsIntoSystemPrompt(systemPrompt: string, tools: Tool[]): string {
  if (!tools || tools.length === 0) return systemPrompt;

  const toolLines = tools.map((t) =>
    JSON.stringify({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })
  );

  return systemPrompt + TOOL_PREAMBLE + toolLines.join("\n") + "\n" + TOOL_POSTAMBLE;
}

// ── Payload Stripping (onPayload callback) ───────────────────────────

/** Fields the Cocoon proxy rejects as "unknown option". */
const UNSUPPORTED_FIELDS = ["tools", "tool_choice", "store", "reasoning_effort", "stream_options"];

/**
 * pi-ai `onPayload` callback — mutates the request body to remove
 * fields that the Cocoon proxy doesn't understand, and adds
 * Qwen3-recommended parameters.
 */
export function stripCocoonPayload(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const obj = payload as Record<string, unknown>;
  for (const field of UNSUPPORTED_FIELDS) {
    delete obj[field];
  }
  // Qwen3 recommended: reduce repetitions (e.g. "How can I assist you?")
  obj.presence_penalty = obj.presence_penalty ?? 1.5;
}

// ── Response Parsing ─────────────────────────────────────────────────

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const THINK_RE = /<think>[\s\S]*?<\/think>/g;

export interface SyntheticToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Extract a complete JSON object from text starting at `startIndex`,
 * handling nested braces correctly.
 */
function extractJsonObject(
  text: string,
  startIndex: number
): { json: string; endIndex: number } | null {
  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") braceCount++;
      if (ch === "}") {
        braceCount--;
        if (braceCount === 0) {
          return { json: text.slice(startIndex, i + 1), endIndex: i };
        }
      }
    }
  }
  return null;
}

/**
 * Parse `<tool_call>` blocks from the model's text response.
 * Uses balanced brace parsing to handle nested JSON in arguments.
 * Returns an array of synthetic ToolCall objects compatible with pi-ai.
 */
export function parseToolCallsFromText(
  text: string,
  allowedTools?: Set<string>
): SyntheticToolCall[] {
  // Strip <think> blocks before parsing
  const cleaned = text.replace(THINK_RE, "").trim();

  const calls: SyntheticToolCall[] = [];
  let searchFrom = 0;

  while (true) {
    const openIdx = cleaned.indexOf(TOOL_CALL_OPEN, searchFrom);
    if (openIdx === -1) break;

    const contentStart = openIdx + TOOL_CALL_OPEN.length;
    const closeIdx = cleaned.indexOf(TOOL_CALL_CLOSE, contentStart);
    if (closeIdx === -1) break;

    // Find the first '{' inside the tag content
    const braceStart = cleaned.indexOf("{", contentStart);
    if (braceStart === -1 || braceStart >= closeIdx) {
      searchFrom = closeIdx + TOOL_CALL_CLOSE.length;
      continue;
    }

    // Extract balanced JSON object
    const extracted = extractJsonObject(cleaned, braceStart);
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted.json);
        if (parsed.name && typeof parsed.name === "string") {
          if (allowedTools && !allowedTools.has(parsed.name)) {
            log.warn(`Cocoon: rejected tool call "${parsed.name}" — not in allowed set`);
          } else {
            calls.push({
              type: "toolCall",
              id: `cocoon_${randomUUID()}`,
              name: parsed.name,
              arguments: parsed.arguments ?? {},
            });
          }
        }
      } catch (e) {
        log.debug(`Failed to parse tool call JSON: ${String(e)}`);
        log.debug(`Raw: ${extracted.json.slice(0, 200)}`);
      }
    }

    searchFrom = closeIdx + TOOL_CALL_CLOSE.length;
  }

  return calls;
}

/**
 * Extract the plain text content from a response, stripping
 * <tool_call> and <think> blocks.
 */
export function extractPlainText(text: string): string {
  let result = text.replace(THINK_RE, "");

  // Remove all <tool_call>...</tool_call> blocks
  let searchFrom = 0;
  while (true) {
    const openIdx = result.indexOf(TOOL_CALL_OPEN, searchFrom);
    if (openIdx === -1) break;
    const closeIdx = result.indexOf(TOOL_CALL_CLOSE, openIdx);
    if (closeIdx === -1) break;
    result = result.slice(0, openIdx) + result.slice(closeIdx + TOOL_CALL_CLOSE.length);
    searchFrom = openIdx;
  }

  return result.trim();
}

// ── Tool Result Formatting ───────────────────────────────────────────

/**
 * Wrap a tool result string in `<tool_response>` tags for Qwen3.
 * Uses CDATA to prevent XML injection from result content.
 */
export function wrapToolResult(resultText: string): string {
  const safe = resultText.replace(/]]>/g, "]]]]><![CDATA[>");
  return `<tool_response>\n<![CDATA[${safe}]]>\n</tool_response>`;
}
