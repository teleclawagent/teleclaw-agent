/**
 * @teleclaw-agent/sdk — Plugin SDK for Teleclaw Agent
 *
 * Provides TypeScript types and utilities for building
 * Teleclaw Agent plugins with full autocompletion and type safety.
 *
 * @example
 * ```typescript
 * import type { PluginSDK, SimpleToolDef, PluginManifest } from "@teleclaw-agent/sdk";
 * import { PluginSDKError } from "@teleclaw-agent/sdk";
 *
 * export const manifest: PluginManifest = {
 *   name: "my-plugin",
 *   version: "1.0.0",
 * };
 *
 * export const tools = (sdk: PluginSDK): SimpleToolDef[] => [
 *   {
 *     name: "my_tool",
 *     description: "Does something useful",
 *     execute: async (params, context) => {
 *       const balance = await sdk.ton.getBalance();
 *       return { success: true, data: balance };
 *     },
 *   },
 * ];
 * ```
 *
 * @packageDocumentation
 */

// ─── Types ───────────────────────────────────────────────────────

export type {
  // Root SDK
  PluginSDK,
  // TON
  TonSDK,
  TonBalance,
  TonPrice,
  TonSendResult,
  TonTransaction,
  TransactionType,
  JettonBalance,
  JettonInfo,
  JettonSendResult,
  SignedTransfer,
  NftItem,
  // TON Analytics
  JettonPrice,
  JettonHolder,
  JettonHistory,
  // DEX
  DexSDK,
  DexQuoteParams,
  DexQuoteResult,
  DexSingleQuote,
  DexSwapParams,
  DexSwapResult,
  // DNS
  DnsSDK,
  DnsCheckResult,
  DnsAuction,
  DnsAuctionResult,
  DnsBidResult,
  DnsResolveResult,
  // Payment
  SDKVerifyPaymentParams,
  SDKPaymentVerification,
  // Telegram
  TelegramSDK,
  SendMessageOptions,
  EditMessageOptions,
  DiceResult,
  TelegramUser,
  SimpleMessage,
  ChatInfo,
  UserInfo,
  ResolvedPeer,
  MediaSendOptions,
  PollOptions,
  StarGift,
  ReceivedGift,
  StartContext,
  // Telegram Extensions
  Dialog,
  StarsTransaction,
  TransferResult,
  CollectibleInfo,
  UniqueGift,
  GiftValue,
  GiftOfferOptions,
  // Logger
  PluginLogger,
  // Secrets
  SecretsSDK,
  SecretDeclaration,
  // Storage
  StorageSDK,
  // Plugin definitions
  SimpleToolDef,
  PluginManifest,
  PluginToolContext,
  ToolResult,
  ToolScope,
  ToolCategory,
  // Plugin event hooks
  PluginMessageEvent,
  PluginCallbackEvent,
  // Bot SDK
  ButtonStyle,
  ButtonDef,
  InlineResultContent,
  InlineResult,
  InlineQueryContext,
  CallbackContext,
  ChosenResultContext,
  BotManifest,
  BotKeyboard,
  BotSDK,
  // Hook types
  HookName,
  HookHandlerMap,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforePromptBuildEvent,
  SessionStartEvent,
  SessionEndEvent,
  // New hook types (v1.1)
  MessageReceiveEvent,
  ResponseBeforeEvent,
  ResponseAfterEvent,
  ResponseErrorEvent,
  ToolErrorEvent,
  PromptAfterEvent,
  AgentStartEvent,
  AgentStopEvent,
} from "./types.js";

// ─── Errors ──────────────────────────────────────────────────────

export { PluginSDKError, type SDKErrorCode } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────

/** Current SDK version (semver) */
export const SDK_VERSION = "1.0.0";
