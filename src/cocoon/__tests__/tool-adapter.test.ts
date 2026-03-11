import { describe, it, expect } from "vitest";
import {
  injectToolsIntoSystemPrompt,
  stripCocoonPayload,
  parseToolCallsFromText,
  extractPlainText,
  wrapToolResult,
} from "../tool-adapter.js";
import type { Tool } from "@mariozechner/pi-ai";

// ── Helpers ──────────────────────────────────────────────────────────

const makeTool = (name: string, desc = "A test tool"): Tool => ({
  name,
  description: desc,
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "search query" } },
    required: ["query"],
  },
});

// ── injectToolsIntoSystemPrompt ──────────────────────────────────────

describe("injectToolsIntoSystemPrompt", () => {
  it("should append tool definitions in <tools> XML block", () => {
    const result = injectToolsIntoSystemPrompt("You are helpful.", [makeTool("web_search")]);
    expect(result).toContain("You are helpful.");
    expect(result).toContain("<tools>");
    expect(result).toContain("</tools>");
    expect(result).toContain('"name":"web_search"');
    expect(result).toContain("<tool_call>");
  });

  it("should include all tools", () => {
    const tools = [makeTool("tool_a"), makeTool("tool_b"), makeTool("tool_c")];
    const result = injectToolsIntoSystemPrompt("sys", tools);
    expect(result).toContain('"name":"tool_a"');
    expect(result).toContain('"name":"tool_b"');
    expect(result).toContain('"name":"tool_c"');
  });

  it("should return system prompt unchanged if no tools", () => {
    expect(injectToolsIntoSystemPrompt("sys", [])).toBe("sys");
  });

  it("should include parameter schemas", () => {
    const result = injectToolsIntoSystemPrompt("sys", [makeTool("t")]);
    expect(result).toContain('"parameters"');
    expect(result).toContain('"query"');
  });

  it("should handle tools with complex parameter schemas", () => {
    const tool: Tool = {
      name: "complex_tool",
      description: "Tool with nested params",
      parameters: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              nested: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: [],
      },
    };
    const result = injectToolsIntoSystemPrompt("sys", [tool]);
    expect(result).toContain('"complex_tool"');
    expect(result).toContain('"nested"');
  });
});

// ── stripCocoonPayload ───────────────────────────────────────────────

describe("stripCocoonPayload", () => {
  it("should remove unsupported fields", () => {
    const payload: Record<string, unknown> = {
      model: "Qwen/Qwen3-32B",
      messages: [],
      tools: [{ name: "a" }],
      tool_choice: "auto",
      store: true,
      reasoning_effort: "high",
      stream_options: { include_usage: true },
    };
    stripCocoonPayload(payload);
    expect(payload.model).toBe("Qwen/Qwen3-32B");
    expect(payload.messages).toEqual([]);
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("stream_options");
  });

  it("should set presence_penalty to 1.5 if not provided", () => {
    const payload: Record<string, unknown> = {};
    stripCocoonPayload(payload);
    expect(payload.presence_penalty).toBe(1.5);
  });

  it("should preserve existing presence_penalty", () => {
    const payload: Record<string, unknown> = { presence_penalty: 2.0 };
    stripCocoonPayload(payload);
    expect(payload.presence_penalty).toBe(2.0);
  });

  it("should preserve presence_penalty = 0", () => {
    // 0 is falsy but should NOT be overridden by ?? 1.5
    const payload: Record<string, unknown> = { presence_penalty: 0 };
    stripCocoonPayload(payload);
    expect(payload.presence_penalty).toBe(0);
  });

  it("should handle null payload gracefully", () => {
    expect(() => stripCocoonPayload(null)).not.toThrow();
  });

  it("should handle non-object payload gracefully", () => {
    expect(() => stripCocoonPayload("string")).not.toThrow();
    expect(() => stripCocoonPayload(42)).not.toThrow();
    expect(() => stripCocoonPayload(undefined)).not.toThrow();
  });
});

// ── parseToolCallsFromText ───────────────────────────────────────────

describe("parseToolCallsFromText", () => {
  it("should parse a single tool call", () => {
    const text = `I'll search for that.
<tool_call>
{"name": "web_search", "arguments": {"query": "hello world"}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("toolCall");
    expect(calls[0].name).toBe("web_search");
    expect(calls[0].arguments).toEqual({ query: "hello world" });
    expect(calls[0].id).toMatch(/^cocoon_/);
  });

  it("should parse multiple tool calls", () => {
    const text = `<tool_call>
{"name": "tool_a", "arguments": {"x": 1}}
</tool_call>
<tool_call>
{"name": "tool_b", "arguments": {"y": 2}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("tool_a");
    expect(calls[1].name).toBe("tool_b");
  });

  it("should handle nested JSON in arguments", () => {
    const text = `<tool_call>
{"name": "send_msg", "arguments": {"text": "He said \\"hello\\"", "config": {"nested": true}}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("send_msg");
    expect(calls[0].arguments.config).toEqual({ nested: true });
  });

  it("should strip <think> blocks before parsing", () => {
    const text = `<think>
I need to search for this.
</think>
<tool_call>
{"name": "web_search", "arguments": {"query": "test"}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("web_search");
  });

  it("should return empty array for no tool calls", () => {
    expect(parseToolCallsFromText("Just a regular response.")).toEqual([]);
  });

  it("should return empty array for malformed JSON", () => {
    const text = `<tool_call>
{not valid json}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([]);
  });

  it("should skip tool calls without a name", () => {
    const text = `<tool_call>
{"arguments": {"x": 1}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([]);
  });

  it("should default arguments to empty object", () => {
    const text = `<tool_call>
{"name": "simple_tool"}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({});
  });

  it("should handle unclosed tool_call tag", () => {
    const text = `<tool_call>
{"name": "broken", "arguments": {}}
no closing tag`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([]);
  });

  it("should handle empty tool_call tags", () => {
    const text = `<tool_call></tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([]);
  });

  it("should generate unique IDs for each call", () => {
    const text = `<tool_call>
{"name": "a", "arguments": {}}
</tool_call>
<tool_call>
{"name": "b", "arguments": {}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls[0].id).not.toBe(calls[1].id);
  });

  it("should handle arguments with special characters", () => {
    // JSON requires \" for quotes inside strings — use String.raw to preserve backslashes
    const text = String.raw`<tool_call>
{"name": "send", "arguments": {"text": "Hello <world> & \"friends\""}}
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments.text).toBe('Hello <world> & "friends"');
  });
});

// ── extractPlainText ─────────────────────────────────────────────────

describe("extractPlainText", () => {
  it("should remove tool_call blocks and keep surrounding text", () => {
    const text = `Hello world.
<tool_call>
{"name": "test", "arguments": {}}
</tool_call>
Goodbye.`;
    expect(extractPlainText(text)).toBe("Hello world.\n\nGoodbye.");
  });

  it("should remove multiple tool_call blocks", () => {
    const text = `A<tool_call>X</tool_call>B<tool_call>Y</tool_call>C`;
    expect(extractPlainText(text)).toBe("ABC");
  });

  it("should remove think blocks", () => {
    const text = `<think>reasoning here</think>The answer is 42.`;
    expect(extractPlainText(text)).toBe("The answer is 42.");
  });

  it("should remove both think and tool_call blocks", () => {
    const text = `<think>hmm</think>Hello<tool_call>{"name":"x","arguments":{}}</tool_call> world`;
    expect(extractPlainText(text)).toBe("Hello world");
  });

  it("should return empty string for pure tool calls", () => {
    const text = `<tool_call>
{"name": "a", "arguments": {}}
</tool_call>`;
    expect(extractPlainText(text)).toBe("");
  });

  it("should handle text with no special blocks", () => {
    expect(extractPlainText("Just regular text.")).toBe("Just regular text.");
  });

  it("should handle consecutive tool_call blocks", () => {
    const text = `<tool_call>A</tool_call><tool_call>B</tool_call><tool_call>C</tool_call>`;
    expect(extractPlainText(text)).toBe("");
  });
});

// ── wrapToolResult ───────────────────────────────────────────────────

describe("wrapToolResult", () => {
  it("should wrap in tool_response with CDATA", () => {
    const result = wrapToolResult("success: true");
    expect(result).toBe(`<tool_response>\n<![CDATA[success: true]]>\n</tool_response>`);
  });

  it("should escape ]]> in content (CDATA injection)", () => {
    const result = wrapToolResult("data with ]]> inside");
    expect(result).toBe(
      `<tool_response>\n<![CDATA[data with ]]]]><![CDATA[> inside]]>\n</tool_response>`
    );
  });

  it("should handle empty result", () => {
    const result = wrapToolResult("");
    expect(result).toBe(`<tool_response>\n<![CDATA[]]>\n</tool_response>`);
  });

  it("should handle result with XML-like content", () => {
    const result = wrapToolResult('<div class="test">Hello & World</div>');
    expect(result).toContain('<div class="test">Hello & World</div>');
  });

  it("should handle multiple ]]> sequences", () => {
    const result = wrapToolResult("a]]>b]]>c");
    // Each ]]> gets split
    expect(result).not.toContain("]]>]]>");
    // But the structure should be valid CDATA
    expect(result).toContain("<tool_response>");
    expect(result).toContain("</tool_response>");
  });

  it("should handle large content", () => {
    const bigContent = "x".repeat(100000);
    const result = wrapToolResult(bigContent);
    expect(result).toContain(bigContent);
  });
});
