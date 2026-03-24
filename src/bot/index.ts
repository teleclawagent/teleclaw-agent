/**
 * Bot module — re-exports for SDK and plugin system.
 * Escrow DealBot removed. Teleclaw is matchmaker-only.
 */

export { InlineRouter } from "./inline-router.js";
export { PluginRateLimiter } from "./rate-limiter.js";
export { GramJSBotClient } from "./gramjs-bot.js";
export {
  toTLMarkup,
  toGrammyKeyboard,
  prefixButtons,
  hasStyledButtons,
  type StyledButtonDef,
} from "./services/styled-keyboard.js";
export { stripCustomEmoji, parseHtml } from "./services/html-parser.js";
