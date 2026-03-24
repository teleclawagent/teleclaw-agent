// src/agent/tools/web/fetch.ts

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { WEB_FETCH_MAX_TEXT_LENGTH } from "../../../constants/limits.js";
import { sanitizeForContext } from "../../../utils/sanitize.js";
import { getErrorMessage } from "../../../utils/errors.js";

interface WebFetchParams {
  url: string;
  max_length?: number;
  extractMode?: "markdown" | "text";
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page and extract readable text/markdown. HTTP/HTTPS only. No API key needed.",
  category: "data-bearing",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch (http or https only)" }),
    max_length: Type.Optional(
      Type.Number({
        description: `Max characters of extracted text (default ${WEB_FETCH_MAX_TEXT_LENGTH})`,
      })
    ),
    extractMode: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
        description: 'Extraction mode: "markdown" (default) or "text"',
      })
    ),
  }),
};

// ── HTML Extraction ────────────────────────────────────────────────────

/** Strip HTML tags and decode common entities */
function htmlToText(html: string): string {
  // Remove script, style, noscript blocks
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Replace br/hr/p/div/li/tr/h tags with newlines
  text = text.replace(
    /<\/?(p|div|br|hr|li|tr|h[1-6]|blockquote|section|article|header|footer|nav|main|aside)[^>]*\/?>/gi,
    "\n"
  );
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Convert HTML to simple markdown */
function htmlToMarkdown(html: string): string {
  // Remove script, style, noscript blocks
  let md = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove HTML comments
  md = md.replace(/<!--[\s\S]*?-->/g, "");
  // Headers
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");
  // Bold & italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  // Links
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  // Images
  md = md.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  // List items
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  // Blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1\n");
  // Code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  // Paragraphs, divs, brs
  md = md.replace(/<\/?(p|div|section|article|header|footer|nav|main|aside)[^>]*>/gi, "\n");
  md = md.replace(/<br[^>]*\/?>/gi, "\n");
  md = md.replace(/<hr[^>]*\/?>/gi, "\n---\n");
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, "");
  // Decode entities
  md = md
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  // Collapse whitespace
  md = md.replace(/[ \t]+/g, " ");
  md = md.replace(/\n{3,}/g, "\n\n");
  return md.trim();
}

/** Extract page title from HTML */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ── Executor ───────────────────────────────────────────────────────────

export const webFetchExecutor: ToolExecutor<WebFetchParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const { url, max_length = WEB_FETCH_MAX_TEXT_LENGTH, extractMode = "markdown" } = params;

    // Validate URL scheme
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: "Invalid URL" };
    }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return {
        success: false,
        error: `Blocked URL scheme: ${parsed.protocol} — only http/https allowed`,
      };
    }

    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      return {
        success: false,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const html = await resp.text();

    // If not HTML, return raw text truncated
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      const text = html.slice(0, max_length);
      return {
        success: true,
        data: {
          title: parsed.hostname,
          text: sanitizeForContext(text),
          url,
          length: text.length,
          truncated: html.length > max_length,
        },
      };
    }

    const title = extractTitle(html) ?? parsed.hostname;
    let text = extractMode === "text" ? htmlToText(html) : htmlToMarkdown(html);

    const truncated = text.length > max_length;
    if (truncated) {
      text = text.slice(0, max_length);
    }

    return {
      success: true,
      data: {
        title: sanitizeForContext(title),
        text: sanitizeForContext(text),
        url,
        length: text.length,
        truncated,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
