import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { generateDealId, calculateExpiry, formatDealProposal } from "../../../deals/utils.js";
import {
  checkStrategyCompliance,
  formatStrategyCheckJSON,
  type AssetValue,
} from "../../../deals/strategy-checker.js";
import { checkTokenGate } from "../fragment/token-gate.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

interface DealProposeParams {
  chatId: string;
  userId: number;
  userGivesType: "ton" | "gift";
  userGivesTonAmount?: number;
  userGivesGiftId?: string;
  userGivesGiftSlug?: string;
  userGivesValueTon: number;
  agentGivesType: "ton" | "gift";
  agentGivesTonAmount?: number;
  agentGivesGiftId?: string;
  agentGivesGiftSlug?: string;
  agentGivesValueTon: number;
  userUsername?: string;
}

export const dealProposeTool: Tool = {
  name: "deal_propose",
  description:
    "Create a trade deal with Accept/Decline buttons. Sends an inline bot message — do NOT send another message after. Strategy compliance is enforced automatically (will reject bad deals). User always sends first. Expires in 2 minutes.",
  parameters: Type.Object({
    chatId: Type.String({ description: "Chat ID where to send proposal" }),
    userId: Type.Number({ description: "Telegram user ID" }),
    userGivesType: Type.Union([Type.Literal("ton"), Type.Literal("gift")]),
    userGivesTonAmount: Type.Optional(
      Type.Number({ description: "TON amount user gives (if type=ton)" })
    ),
    userGivesGiftId: Type.Optional(
      Type.String({ description: "Gift msgId user gives (if type=gift)" })
    ),
    userGivesGiftSlug: Type.Optional(
      Type.String({
        description:
          "Gift's slug field from telegram_get_my_gifts (e.g. 'LolPop-425402'), NOT the title",
      })
    ),
    userGivesValueTon: Type.Number({ description: "Estimated TON value of what user gives" }),
    agentGivesType: Type.Union([Type.Literal("ton"), Type.Literal("gift")]),
    agentGivesTonAmount: Type.Optional(
      Type.Number({ description: "TON amount you give (if type=ton)" })
    ),
    agentGivesGiftId: Type.Optional(
      Type.String({ description: "Gift msgId you give (if type=gift)" })
    ),
    agentGivesGiftSlug: Type.Optional(
      Type.String({
        description:
          "Gift's slug field from telegram_get_my_gifts (e.g. 'LolPop-425402'), NOT the title",
      })
    ),
    agentGivesValueTon: Type.Number({ description: "Estimated TON value of what you give" }),
    userUsername: Type.Optional(Type.String({ description: "User's @username for display" })),
  }),
};

export const dealProposeExecutor: ToolExecutor<DealProposeParams> = async (
  params,
  context
): Promise<ToolResult> => {
  // Token gate check
  const gate = await checkTokenGate(context.db, context.senderId);
  if (!gate.allowed) {
    return { success: false, error: gate.reason };
  }

  try {
    const userGives: AssetValue = {
      type: params.userGivesType,
      tonAmount: params.userGivesTonAmount,
      giftSlug: params.userGivesGiftSlug,
      valueTon: params.userGivesValueTon,
    };

    const agentGives: AssetValue = {
      type: params.agentGivesType,
      tonAmount: params.agentGivesTonAmount,
      giftSlug: params.agentGivesGiftSlug,
      valueTon: params.agentGivesValueTon,
    };

    // CRITICAL: Check strategy compliance
    const strategyCheck = checkStrategyCompliance(userGives, agentGives);

    if (!strategyCheck.acceptable) {
      return {
        success: false,
        error: `Deal rejected by strategy rules:\n${strategyCheck.reason}`,
      };
    }

    // Generate deal ID and expiry
    const dealId = generateDealId();
    const expiresAt = calculateExpiry();
    const createdAt = Math.floor(Date.now() / 1000);

    // Create deal in database
    context.db
      .prepare(
        `
      INSERT INTO deals (
        id, status, user_telegram_id, user_username, chat_id,
        user_gives_type, user_gives_ton_amount, user_gives_gift_id, user_gives_gift_slug, user_gives_value_ton,
        agent_gives_type, agent_gives_ton_amount, agent_gives_gift_id, agent_gives_gift_slug, agent_gives_value_ton,
        strategy_check, profit_ton, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        dealId,
        "proposed",
        params.userId,
        params.userUsername || null,
        params.chatId,
        params.userGivesType,
        params.userGivesTonAmount || null,
        params.userGivesGiftId || null,
        params.userGivesGiftSlug || null,
        params.userGivesValueTon,
        params.agentGivesType,
        params.agentGivesTonAmount || null,
        params.agentGivesGiftId || null,
        params.agentGivesGiftSlug || null,
        params.agentGivesValueTon,
        formatStrategyCheckJSON(strategyCheck),
        strategyCheck.profit,
        createdAt,
        expiresAt
      );

    log.info(`[Deal] Created deal #${dealId} - profit: ${strategyCheck.profit.toFixed(2)} TON`);

    // Send deal proposal message with Accept/Decline inline buttons (Bot API)
    const proposalText = formatDealProposal(
      dealId,
      {
        type: params.userGivesType,
        tonAmount: params.userGivesTonAmount,
        giftSlug: params.userGivesGiftSlug,
        valueTon: params.userGivesValueTon,
      },
      {
        type: params.agentGivesType,
        tonAmount: params.agentGivesTonAmount,
        giftSlug: params.agentGivesGiftSlug,
        valueTon: params.agentGivesValueTon,
      },
      strategyCheck.profit,
      true
    );

    const sentMessage = await context.bridge.sendMessage({
      chatId: params.chatId,
      text: proposalText,
      inlineKeyboard: [
        [
          { text: "✅ Accept", callback_data: `accept:${dealId}` },
          { text: "❌ Decline", callback_data: `decline:${dealId}` },
        ],
      ],
    });

    context.db
      .prepare(`UPDATE deals SET proposal_message_id = ? WHERE id = ?`)
      .run(sentMessage.id, dealId);

    return {
      success: true,
      data: {
        dealId,
        profit: strategyCheck.profit,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        strategyRule: strategyCheck.rule,
        note: "Deal card sent with buttons. STOP HERE — do NOT send any follow-up message. The user will click Accept/Decline on the card.",
      },
    };
  } catch (error) {
    log.error({ err: error }, "Error creating deal proposal");
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
