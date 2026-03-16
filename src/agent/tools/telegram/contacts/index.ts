import { telegramBlockUserTool, telegramBlockUserExecutor } from "./block-user.js";
import { telegramGetBlockedTool, telegramGetBlockedExecutor } from "./get-blocked.js";
import { telegramGetCommonChatsTool, telegramGetCommonChatsExecutor } from "./get-common-chats.js";
import { telegramGetUserInfoTool, telegramGetUserInfoExecutor } from "./get-user-info.js";
import { telegramCheckUsernameTool, telegramCheckUsernameExecutor } from "./check-username.js";
import type { ToolEntry } from "../../types.js";

export { telegramBlockUserTool, telegramBlockUserExecutor };
export { telegramGetBlockedTool, telegramGetBlockedExecutor };
export { telegramGetCommonChatsTool, telegramGetCommonChatsExecutor };
export { telegramGetUserInfoTool, telegramGetUserInfoExecutor };
export { telegramCheckUsernameTool, telegramCheckUsernameExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramBlockUserTool, executor: telegramBlockUserExecutor, scope: "userbot-only" },
  { tool: telegramGetBlockedTool, executor: telegramGetBlockedExecutor, scope: "userbot-only" },
  { tool: telegramGetCommonChatsTool, executor: telegramGetCommonChatsExecutor , scope: "userbot-only" },
  { tool: telegramGetUserInfoTool, executor: telegramGetUserInfoExecutor , scope: "userbot-only" },
  { tool: telegramCheckUsernameTool, executor: telegramCheckUsernameExecutor , scope: "userbot-only" },
];
