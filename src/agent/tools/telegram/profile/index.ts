import { telegramUpdateProfileTool, telegramUpdateProfileExecutor } from "./update-profile.js";
import { telegramSetBioTool, telegramSetBioExecutor } from "./set-bio.js";
import { telegramSetUsernameTool, telegramSetUsernameExecutor } from "./set-username.js";
import {
  telegramSetPersonalChannelTool,
  telegramSetPersonalChannelExecutor,
} from "./set-personal-channel.js";
import type { ToolEntry } from "../../types.js";

export { telegramUpdateProfileTool, telegramUpdateProfileExecutor };
export { telegramSetBioTool, telegramSetBioExecutor };
export { telegramSetUsernameTool, telegramSetUsernameExecutor };
export { telegramSetPersonalChannelTool, telegramSetPersonalChannelExecutor };

export const tools: ToolEntry[] = [
  { tool: telegramUpdateProfileTool, executor: telegramUpdateProfileExecutor, scope: "userbot-only" },
  { tool: telegramSetBioTool, executor: telegramSetBioExecutor, scope: "userbot-only" },
  { tool: telegramSetUsernameTool, executor: telegramSetUsernameExecutor, scope: "userbot-only" },
  {
    tool: telegramSetPersonalChannelTool,
    executor: telegramSetPersonalChannelExecutor,
    scope: "userbot-only",
  },
];
