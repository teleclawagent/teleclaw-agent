/**
 * Browser tools — screenshot URLs and extract structured data.
 * Uses headless Puppeteer-core if available, falls back to web_fetch.
 * No PC access needed — runs in the Teleclaw process.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry, ToolContext } from "../types.js";
import { webFetchExecutor } from "../web/fetch.js";

// ── browser_screenshot ─────────────────────────────────────────────────

interface BrowserScreenshotParams {
  url: string;
  full_page?: boolean;
}

const browserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description:
    "Take a screenshot of a web page. Returns the screenshot as a Telegram photo. " +
    "Requires puppeteer to be installed (npm i puppeteer). Falls back to text extraction if unavailable.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to screenshot" }),
    full_page: Type.Optional(
      Type.Boolean({ description: "Capture full page (default: viewport only)" })
    ),
  }),
};

const browserScreenshotExecutor: ToolExecutor<BrowserScreenshotParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    // Try puppeteer (optional dependency)
    // Puppeteer is an optional dependency — dynamically imported
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      mod = await (Function('return import("puppeteer")')() as Promise<unknown>);
    } catch {
      // Puppeteer not installed — fall back to text extraction
      const fetchResult = await webFetchExecutor(
        { url: params.url, extractMode: "markdown" },
        context
      );
      return {
        success: true,
        data: {
          fallback: true,
          message:
            "Puppeteer not installed — showing text content instead. Install with: npm i puppeteer",
          ...(fetchResult.data as object),
        },
      };
    }

    const browser = await mod.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });
      await page.goto(params.url, { waitUntil: "networkidle2", timeout: 30000 });

      const screenshot = await page.screenshot({
        fullPage: params.full_page ?? false,
        type: "png",
        encoding: "base64",
      });

      // Send as photo
      const buffer = Buffer.from(screenshot as string, "base64");
      await context.bridge.sendPhoto(context.chatId, buffer, {
        caption: `📸 Screenshot: ${params.url}`,
      });

      return {
        success: true,
        data: { url: params.url, sent: true },
      };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── browser_extract ────────────────────────────────────────────────────

interface BrowserExtractParams {
  url: string;
  selector?: string;
}

const browserExtractTool: Tool = {
  name: "browser_extract",
  description:
    "Extract structured content from a web page. Optionally target a CSS selector. " +
    "Uses headless browser if available, otherwise falls back to web_fetch.",
  category: "data-bearing",
  parameters: Type.Object({
    url: Type.String({ description: "URL to extract from" }),
    selector: Type.Optional(
      Type.String({
        description: "CSS selector to extract specific element (e.g. 'article', '.content')",
      })
    ),
  }),
};

const browserExtractExecutor: ToolExecutor<BrowserExtractParams> = async (
  params,
  context: ToolContext
): Promise<ToolResult> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      mod = await (Function('return import("puppeteer")')() as Promise<unknown>);
    } catch {
      // Fall back to web_fetch
      return webFetchExecutor({ url: params.url, extractMode: "markdown" }, context);
    }

    const browser = await mod.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.goto(params.url, { waitUntil: "networkidle2", timeout: 30000 });

      let text: string;
      if (params.selector) {
        text = await page
          .$eval(params.selector, (el: Element) => el.textContent ?? "")
          .catch(() => "Selector not found");
      } else {
        text = await page.evaluate(() => document.body.innerText);
      }

      const title = await page.title();

      // Truncate
      const maxLen = 50000;
      const truncated = text.length > maxLen;
      if (truncated) text = text.slice(0, maxLen);

      return {
        success: true,
        data: { title, text, url: params.url, truncated },
      };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── Export ──────────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: browserScreenshotTool, executor: browserScreenshotExecutor },
  { tool: browserExtractTool, executor: browserExtractExecutor },
];
