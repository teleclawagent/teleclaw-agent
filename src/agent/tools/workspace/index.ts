// src/agent/tools/workspace/index.ts

import { workspaceListTool, workspaceListExecutor } from "./list.js";
import { workspaceReadTool, workspaceReadExecutor } from "./read.js";
import { workspaceWriteTool, workspaceWriteExecutor } from "./write.js";
import { workspaceDeleteTool, workspaceDeleteExecutor } from "./delete.js";
import { workspaceInfoTool, workspaceInfoExecutor } from "./info.js";
import { workspaceRenameTool, workspaceRenameExecutor } from "./rename.js";
import type { ToolEntry } from "../types.js";

export { workspaceListTool, workspaceListExecutor };
export { workspaceReadTool, workspaceReadExecutor };
export { workspaceWriteTool, workspaceWriteExecutor };
export { workspaceDeleteTool, workspaceDeleteExecutor };
export { workspaceInfoTool, workspaceInfoExecutor };
export { workspaceRenameTool, workspaceRenameExecutor };

export const tools: ToolEntry[] = [
  { tool: workspaceWriteTool, executor: workspaceWriteExecutor, scope: "dm-only" },
  { tool: workspaceDeleteTool, executor: workspaceDeleteExecutor, scope: "dm-only" },
  { tool: workspaceRenameTool, executor: workspaceRenameExecutor, scope: "dm-only" },
  { tool: workspaceListTool, executor: workspaceListExecutor },
  { tool: workspaceReadTool, executor: workspaceReadExecutor },
  { tool: workspaceInfoTool, executor: workspaceInfoExecutor },
];
