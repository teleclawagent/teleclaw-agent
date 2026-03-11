// src/agent/tools/web/index.ts

import { webSearchTool, webSearchExecutor } from "./search.js";
import { webFetchTool, webFetchExecutor } from "./fetch.js";
import type { ToolEntry } from "../types.js";

export { webSearchTool, webSearchExecutor };
export { webFetchTool, webFetchExecutor };

export const tools: ToolEntry[] = [
  { tool: webSearchTool, executor: webSearchExecutor },
  { tool: webFetchTool, executor: webFetchExecutor },
];
