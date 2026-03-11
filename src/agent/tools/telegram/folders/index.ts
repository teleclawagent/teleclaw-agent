import { telegramGetFoldersTool, telegramGetFoldersExecutor } from "./get-folders.js";
import { telegramCreateFolderTool, telegramCreateFolderExecutor } from "./create-folder.js";
import {
  telegramAddChatToFolderTool,
  telegramAddChatToFolderExecutor,
} from "./add-chat-to-folder.js";
import type { ToolEntry } from "../../types.js";

export { telegramGetFoldersTool, telegramGetFoldersExecutor };
export { telegramCreateFolderTool, telegramCreateFolderExecutor };
export { telegramAddChatToFolderTool, telegramAddChatToFolderExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramGetFoldersTool, executor: telegramGetFoldersExecutor },
  { tool: telegramCreateFolderTool, executor: telegramCreateFolderExecutor },
  { tool: telegramAddChatToFolderTool, executor: telegramAddChatToFolderExecutor },
];
