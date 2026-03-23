/**
 * PDF analysis tools — extract text from PDFs sent via Telegram or URLs.
 * Uses pdf-parse for text extraction, then sends to LLM for analysis.
 * No external browser or PC access needed.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry, ToolContext } from "../types.js";
import { chatWithContext } from "../../client.js";
import { getProviderMetadata, type SupportedProvider } from "../../../config/providers.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("PDF");

// ── pdf_analyze ────────────────────────────────────────────────────────

interface PdfAnalyzeParams {
  url: string;
  prompt?: string;
  max_pages?: number;
}

const pdfAnalyzeTool: Tool = {
  name: "pdf_analyze",
  description:
    "Download and analyze a PDF document from a URL. Extracts text and optionally answers questions about it. " +
    "Supports HTTP/HTTPS URLs. Max ~50 pages recommended.",
  category: "data-bearing",
  parameters: Type.Object({
    url: Type.String({ description: "URL of the PDF to analyze" }),
    prompt: Type.Optional(
      Type.String({ description: "Question or analysis instruction (default: summarize)" })
    ),
    max_pages: Type.Optional(Type.Number({ description: "Max pages to process (default: all)" })),
  }),
};

const pdfAnalyzeExecutor: ToolExecutor<PdfAnalyzeParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    // Download PDF
    const response = await fetch(params.url, {
      headers: { "User-Agent": "Teleclaw/1.0" },
      signal: AbortSignal.timeout(60000),
      redirect: "follow",
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("pdf") && !params.url.toLowerCase().endsWith(".pdf")) {
      return { success: false, error: "URL does not appear to be a PDF" };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    log.info({ url: params.url, bytes: buffer.length }, "PDF downloaded");

    // Try pdf-parse
    let extractedText: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfMod = await (Function('return import("pdf-parse")')() as Promise<any>);
      const pdfParse = pdfMod.default;
      const result = await pdfParse(buffer, {
        max: params.max_pages ?? 0, // 0 = all pages
      });

      extractedText = result.text;

      if (!extractedText || extractedText.trim().length < 10) {
        return {
          success: false,
          error: "PDF appears to be image-based (scanned). Text extraction returned no content.",
        };
      }
    } catch (parseErr) {
      // pdf-parse not installed
      return {
        success: false,
        error:
          "pdf-parse not installed. Run: npm install pdf-parse\n" +
          `Error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }

    // Truncate if too long
    const maxChars = 100000;
    const truncated = extractedText.length > maxChars;
    if (truncated) {
      extractedText = extractedText.slice(0, maxChars);
    }

    // If no prompt, just return extracted text
    if (!params.prompt) {
      return {
        success: true,
        data: {
          url: params.url,
          text: extractedText,
          truncated,
          charCount: extractedText.length,
        },
      };
    }

    // Analyze with LLM using utility model
    const config = context.config;
    if (!config) {
      return {
        success: true,
        data: {
          url: params.url,
          text: extractedText,
          truncated,
          note: "Config unavailable — returning raw text instead of analysis",
        },
      };
    }

    const provider = config.agent.provider as SupportedProvider;
    const meta = getProviderMetadata(provider);
    const utilityModel = config.agent.utility_model ?? meta.utilityModel;

    const analysisResponse = await chatWithContext(
      { ...config.agent, model: utilityModel, max_tokens: 4096 },
      {
        systemPrompt: "Analyze the following PDF content. Be concise and precise.",
        context: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${params.prompt}\n\n--- PDF CONTENT ---\n${extractedText}`,
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
      }
    );

    return {
      success: true,
      data: {
        url: params.url,
        analysis: analysisResponse.text,
        truncated,
        charCount: extractedText.length,
        model: utilityModel,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── Export ──────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [{ tool: pdfAnalyzeTool, executor: pdfAnalyzeExecutor }];
