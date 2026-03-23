/**
 * src/agent/tools/register-all.ts  — TAM REPLACEMENT
 *
 * Mevcut dosyayı bu dosya ile değiştir.
 * Eklenenler: soulTools, skillTools
 */

import type { ToolRegistry } from "./registry.js";
import type { ToolEntry } from "./types.js";

import { tools as telegramTools } from "./telegram/index.js";
import { tools as tonTools } from "./ton/index.js";
import { tools as dnsTools } from "./dns/index.js";
import { tools as stonfiTools } from "./stonfi/index.js";
import { tools as dedustTools } from "./dedust/index.js";
import { tools as journalTools } from "./journal/index.js";
import { tools as workspaceTools } from "./workspace/index.js";
import { tools as webTools } from "./web/index.js";
import { tools as botTools } from "./bot/index.js";
import { tools as fragmentTools } from "./fragment/index.js";
import { tools as marketplaceTools } from "./marketplace/index.js";
import { tools as agenticWalletTools } from "./agentic-wallet/index.js";
import { tools as giftMarketTools } from "./gift-market/index.js";
import { tools as soulTools } from "./soul/index.js";
import { tools as skillTools } from "./skill/index.js";
import { tools as fileOpsTools } from "./file-ops/index.js";
import { tools as browserTools } from "./browser/index.js";
import { tools as cronTools } from "./cron/index.js";
import { tools as subagentTools } from "./subagent/index.js";
import { tools as pdfTools } from "./pdf/index.js";
import { tools as summarizeTools } from "./summarize/index.js";

const ALL_CATEGORIES: ToolEntry[][] = [
  telegramTools,
  tonTools,
  dnsTools,
  stonfiTools,
  dedustTools,
  journalTools,
  workspaceTools,
  webTools,
  botTools,
  fragmentTools,
  marketplaceTools,
  agenticWalletTools,
  giftMarketTools,
  soulTools,
  skillTools,
  fileOpsTools,
  browserTools,
  cronTools,
  subagentTools,
  pdfTools,
  summarizeTools,
];

export function registerAllTools(registry: ToolRegistry): void {
  for (const category of ALL_CATEGORIES) {
    for (const { tool, executor, scope } of category) {
      registry.register(tool, executor, scope);
    }
  }
}
