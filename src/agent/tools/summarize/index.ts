/**
 * Summarize tools — summarize URLs, articles, YouTube videos, and text content.
 * Fetches content, extracts text, sends to LLM for summarization.
 * No external deps beyond what's already in Teleclaw.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry, ToolContext } from "../types.js";
import { webFetchExecutor } from "../web/fetch.js";
import { chatWithContext } from "../../client.js";
import { getProviderMetadata, type SupportedProvider } from "../../../config/providers.js";

// ── summarize_url ──────────────────────────────────────────────────────

interface SummarizeUrlParams {
  url: string;
  style?: "brief" | "detailed" | "bullets" | "eli5";
  language?: string;
}

const summarizeUrlTool: Tool = {
  name: "summarize_url",
  description:
    "Summarize any web page, article, blog post, or YouTube video. " +
    "Fetches the content and generates a concise summary. " +
    "For YouTube, extracts available transcript/description. " +
    "Styles: brief (1-2 paragraphs), detailed (full summary), bullets (key points), eli5 (simple explanation).",
  category: "data-bearing",
  parameters: Type.Object({
    url: Type.String({ description: "URL to summarize (article, blog, YouTube, etc.)" }),
    style: Type.Optional(
      Type.Union(
        [
          Type.Literal("brief"),
          Type.Literal("detailed"),
          Type.Literal("bullets"),
          Type.Literal("eli5"),
        ],
        { description: "Summary style (default: brief)" }
      )
    ),
    language: Type.Optional(
      Type.String({
        description: "Output language (default: same as content). e.g. 'Turkish', 'English'",
      })
    ),
  }),
};

const summarizeUrlExecutor: ToolExecutor<SummarizeUrlParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    // Fetch content
    const fetchResult = await webFetchExecutor(
      { url: params.url, extractMode: "markdown", max_length: 80000 },
      context
    );

    if (!fetchResult.success) {
      return fetchResult;
    }

    const fetchData = fetchResult.data as { title?: string; text?: string; url?: string };
    const content = fetchData.text ?? "";
    const title = fetchData.title ?? "";

    if (content.length < 50) {
      return {
        success: false,
        error:
          "Not enough content to summarize. Page may be behind a paywall or require JavaScript.",
      };
    }

    // Build summarization prompt
    const style = params.style ?? "brief";
    const styleInstructions: Record<string, string> = {
      brief: "Write a concise 1-2 paragraph summary covering the main points.",
      detailed:
        "Write a comprehensive summary covering all important details, arguments, and conclusions.",
      bullets:
        "Summarize in bullet points (5-10 key points). Each point should be one clear sentence.",
      eli5: "Explain this as if to a 5 year old. Use simple words and analogies.",
    };

    let prompt = `Summarize the following content.\n\n${styleInstructions[style]}`;
    if (params.language) {
      prompt += `\n\nWrite the summary in ${params.language}.`;
    }
    prompt += `\n\nTitle: ${title}\nURL: ${params.url}\n\n--- CONTENT ---\n${content}`;

    // Use utility model for summarization
    const config = context.config;
    if (!config) {
      return {
        success: true,
        data: {
          title,
          content: content.slice(0, 3000),
          note: "Config unavailable — returning raw content instead of summary",
        },
      };
    }

    const provider = config.agent.provider as SupportedProvider;
    const meta = getProviderMetadata(provider);
    const utilityModel = config.agent.utility_model ?? meta.utilityModel;

    const response = await chatWithContext(
      { ...config.agent, model: utilityModel, max_tokens: 4096 },
      {
        systemPrompt: "You are a precise summarizer. Only output the summary, nothing else.",
        context: {
          messages: [
            { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
          ],
        },
      }
    );

    return {
      success: true,
      data: {
        title,
        url: params.url,
        summary: response.text,
        style,
        model: utilityModel,
        contentLength: content.length,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── summarize_text ─────────────────────────────────────────────────────

interface SummarizeTextParams {
  text: string;
  style?: "brief" | "detailed" | "bullets" | "eli5";
  language?: string;
}

const summarizeTextTool: Tool = {
  name: "summarize_text",
  description:
    "Summarize a block of text. Use when you already have the content (e.g. from a file, message, or clipboard).",
  category: "data-bearing",
  parameters: Type.Object({
    text: Type.String({ description: "Text content to summarize" }),
    style: Type.Optional(
      Type.Union(
        [
          Type.Literal("brief"),
          Type.Literal("detailed"),
          Type.Literal("bullets"),
          Type.Literal("eli5"),
        ],
        { description: "Summary style (default: brief)" }
      )
    ),
    language: Type.Optional(
      Type.String({ description: "Output language (default: same as content)" })
    ),
  }),
};

const summarizeTextExecutor: ToolExecutor<SummarizeTextParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    if (params.text.length < 50) {
      return { success: false, error: "Text too short to summarize." };
    }

    const style = params.style ?? "brief";
    const styleInstructions: Record<string, string> = {
      brief: "Write a concise 1-2 paragraph summary.",
      detailed: "Write a comprehensive summary covering all important details.",
      bullets: "Summarize in 5-10 bullet points.",
      eli5: "Explain as if to a 5 year old.",
    };

    let prompt = `${styleInstructions[style]}`;
    if (params.language) {
      prompt += ` Write in ${params.language}.`;
    }
    prompt += `\n\n--- CONTENT ---\n${params.text.slice(0, 80000)}`;

    const config = context.config;
    if (!config) {
      return { success: false, error: "Config unavailable" };
    }

    const provider = config.agent.provider as SupportedProvider;
    const meta = getProviderMetadata(provider);
    const utilityModel = config.agent.utility_model ?? meta.utilityModel;

    const response = await chatWithContext(
      { ...config.agent, model: utilityModel, max_tokens: 4096 },
      {
        systemPrompt: "You are a precise summarizer. Only output the summary, nothing else.",
        context: {
          messages: [
            { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
          ],
        },
      }
    );

    return {
      success: true,
      data: {
        summary: response.text,
        style,
        model: utilityModel,
        inputLength: params.text.length,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── Export ──────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: summarizeUrlTool, executor: summarizeUrlExecutor },
  { tool: summarizeTextTool, executor: summarizeTextExecutor },
];
