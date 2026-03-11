import { memoryWriteTool, memoryWriteExecutor } from "./memory-write.js";
import { memoryReadTool, memoryReadExecutor } from "./memory-read.js";
import type { ToolEntry } from "../../types.js";

export { memoryWriteTool, memoryWriteExecutor };
export { memoryReadTool, memoryReadExecutor };

export const tools: ToolEntry[] = [
  { tool: memoryWriteTool, executor: memoryWriteExecutor, scope: "dm-only" },
  { tool: memoryReadTool, executor: memoryReadExecutor },
];
