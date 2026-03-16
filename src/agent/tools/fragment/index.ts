/**
 * Fragment Username Trading Tools
 *
 * 🔍 Sniper Mode — find undervalued usernames for flipping
 * 📊 Market Intelligence — trends, whale tracking, category analysis
 * 🤝 Deal Negotiation — OTC trading, buyer/seller matching
 * 📱 Portfolio Optimizer — P&L tracking, sell timing
 * 🏆 Combo Detector — find username sets worth more together
 * 🔗 Matchmaker — connect buyers and sellers automatically
 */

import type { ToolEntry } from "../types.js";

// Sniper Mode
import {
  fragmentSniperTool,
  fragmentSniperExecutor,
  fragmentValuationTool,
  fragmentValuationExecutor,
  fragmentCheckTool,
  fragmentCheckExecutor,
} from "./sniper.js";

// Market Intelligence
import {
  fragmentMarketTool,
  fragmentMarketExecutor,
  fragmentCategoryTool,
  fragmentCategoryExecutor,
  fragmentWhalesTool,
  fragmentWhalesExecutor,
  fragmentSearchTool,
  fragmentSearchExecutor,
} from "./market-intel.js";

// Deal Negotiation
import {
  fragmentCreateDealTool,
  fragmentCreateDealExecutor,
  fragmentBrowseDealsTool,
  fragmentBrowseDealsExecutor,
  fragmentMyDealsTool,
  fragmentMyDealsExecutor,
  fragmentCancelDealTool,
  fragmentCancelDealExecutor,
  fragmentCompareTool,
  fragmentCompareExecutor,
} from "./deal-negotiation.js";

// Portfolio Optimizer
import {
  portfolioAddTool,
  portfolioAddExecutor,
  portfolioRemoveTool,
  portfolioRemoveExecutor,
  portfolioViewTool,
  portfolioViewExecutor,
} from "./portfolio.js";

// Combo Detector
import {
  comboScanTool,
  comboScanExecutor,
  comboSuggestTool,
  comboSuggestExecutor,
} from "./combo-detector.js";

// Taste Profile
import {
  tasteSetupTool,
  tasteSetupExecutor,
  tasteViewTool,
  tasteViewExecutor,
} from "./taste-profile.js";

// Matchmaker
import {
  mmListTool,
  mmListExecutor,
  mmInterestTool,
  mmInterestExecutor,
  mmExpressInterestTool,
  mmExpressInterestExecutor,
  mmBrowseTool,
  mmBrowseExecutor,
  mmMyListingsTool,
  mmMyListingsExecutor,
  mmCancelTool,
  mmCancelExecutor,
  mmSoldTool,
  mmSoldExecutor,
} from "./matchmaker.js";

// Listing Watcher
import {
  listingWatchTool,
  listingWatchExecutor,
  listingUnwatchTool,
  listingUnwatchExecutor,
  watchSettingsTool,
  watchSettingsExecutor,
} from "./listing-watcher.js";

// Flip P&L Tracker
import {
  flipSellTool,
  flipSellExecutor,
  flipHistoryTool,
  flipHistoryExecutor,
  flipStatsTool,
  flipStatsExecutor,
} from "./flip-tracker.js";

// Number Rarity Tools
import {
  numberRarityTool,
  numberRarityExecutor,
  numberCompareTool,
  numberCompareExecutor,
  numberPortfolioRarityTool,
  numberPortfolioRarityExecutor,
} from "./number-tools.js";

// Number Profile & Matchmaker
import {
  numberProfileSetTool,
  numberProfileSetExecutor,
  numberProfileViewTool,
  numberProfileViewExecutor,
  numberListForSaleTool,
  numberListForSaleExecutor,
  numberBrowseListingsTool,
  numberBrowseListingsExecutor,
  numberSoldTool,
  numberSoldExecutor,
} from "./number-profile.js";

// Channel Scanner
import {
  channelScanAddTool,
  channelScanAddExecutor,
  channelScanRemoveTool,
  channelScanRemoveExecutor,
  channelScanListTool,
  channelScanListExecutor,
  channelParseTool,
  channelParseExecutor,
} from "./channel-scanner.js";

// Number Sniper
import {
  numberSniperTool,
  numberSniperExecutor,
  numberValuationTool,
  numberValuationExecutor,
  numberCheckTool,
  numberCheckExecutor,
} from "./number-sniper.js";

// Number Market Intel
import {
  numberMarketTool,
  numberMarketExecutor,
  numberCategoryTool,
  numberCategoryExecutor,
  numberWhalesTool,
  numberWhalesExecutor,
  numberSearchTool,
  numberSearchExecutor,
} from "./number-market-intel.js";

// 🎁 Gift Collections
import {
  giftCollectionsTool,
  giftCollectionsExecutor,
  giftCollectionDetailTool,
  giftCollectionDetailExecutor,
  giftRarityCheckTool,
  giftRarityCheckExecutor,
  giftSearchTool,
  giftSearchExecutor,
  giftRarestTool,
  giftRarestExecutor,
} from "./gifts-tools.js";

// 🏪 Gift Marketplace Aggregator
import {
  giftPriceCompareTool,
  giftPriceCompareExecutor,
  giftSniperTool,
  giftSniperExecutor,
  giftBestDealTool,
  giftBestDealExecutor,
  giftArbitrageTool,
  giftArbitrageExecutor,
} from "./aggregator-tools.js";

// 🎁 Gift OTC Matchmaker
import {
  giftMmListTool,
  giftMmListExecutor,
  giftMmInterestTool,
  giftMmInterestExecutor,
  giftMmBrowseTool,
  giftMmBrowseExecutor,
  giftMmMyListingsTool,
  giftMmMyListingsExecutor,
  giftMmCancelTool,
  giftMmCancelExecutor,
  giftMmExpressTool,
  giftMmExpressExecutor,
  giftMmSoldTool,
  giftMmSoldExecutor,
} from "./gift-matchmaker.js";

// 🎁 Gift Portfolio + P&L
import {
  giftPortfolioAddTool,
  giftPortfolioAddExecutor,
  giftPortfolioRemoveTool,
  giftPortfolioRemoveExecutor,
  giftPortfolioViewTool,
  giftPortfolioViewExecutor,
} from "./gift-portfolio.js";

// 🔍 Gift Trait Explorer
import {
  giftTraitSearchTool,
  giftTraitSearchExecutor,
  giftTraitCompareTool,
  giftTraitCompareExecutor,
} from "./gift-trait-explorer.js";

// 🎨 Gift Set Detector
import {
  giftSetScanTool,
  giftSetScanExecutor,
  giftSetSuggestTool,
  giftSetSuggestExecutor,
} from "./gift-set-detector.js";

// 💎 Gift Appraisal
import {
  giftAppraiseTool,
  giftAppraiseExecutor,
} from "./gift-appraisal.js";

// 🔔 Gift Alerts
import {
  giftAlertSetTool,
  giftAlertSetExecutor,
  giftAlertListTool,
  giftAlertListExecutor,
  giftAlertRemoveTool,
  giftAlertRemoveExecutor,
} from "./gift-alerts.js";

export const tools: ToolEntry[] = [
  // 🔍 Sniper Mode
  { tool: fragmentSniperTool, executor: fragmentSniperExecutor, scope: "dm-only" },
  { tool: fragmentValuationTool, executor: fragmentValuationExecutor },
  { tool: fragmentCheckTool, executor: fragmentCheckExecutor },

  // 📊 Market Intelligence
  { tool: fragmentMarketTool, executor: fragmentMarketExecutor },
  { tool: fragmentCategoryTool, executor: fragmentCategoryExecutor },
  { tool: fragmentWhalesTool, executor: fragmentWhalesExecutor },
  { tool: fragmentSearchTool, executor: fragmentSearchExecutor },

  // 🤝 Deal Negotiation
  { tool: fragmentCreateDealTool, executor: fragmentCreateDealExecutor, scope: "dm-only" },
  { tool: fragmentBrowseDealsTool, executor: fragmentBrowseDealsExecutor },
  { tool: fragmentMyDealsTool, executor: fragmentMyDealsExecutor, scope: "dm-only" },
  { tool: fragmentCancelDealTool, executor: fragmentCancelDealExecutor, scope: "dm-only" },
  { tool: fragmentCompareTool, executor: fragmentCompareExecutor },

  // 📱 Portfolio
  { tool: portfolioAddTool, executor: portfolioAddExecutor, scope: "dm-only" },
  { tool: portfolioRemoveTool, executor: portfolioRemoveExecutor, scope: "dm-only" },
  { tool: portfolioViewTool, executor: portfolioViewExecutor, scope: "dm-only" },

  // 🏆 Combo Detector
  { tool: comboScanTool, executor: comboScanExecutor },
  { tool: comboSuggestTool, executor: comboSuggestExecutor },

  // 👤 Taste Profile
  { tool: tasteSetupTool, executor: tasteSetupExecutor, scope: "dm-only" },
  { tool: tasteViewTool, executor: tasteViewExecutor, scope: "dm-only" },

  // 🔗 Matchmaker
  { tool: mmListTool, executor: mmListExecutor, scope: "dm-only" },
  { tool: mmInterestTool, executor: mmInterestExecutor, scope: "dm-only" },
  { tool: mmExpressInterestTool, executor: mmExpressInterestExecutor, scope: "dm-only" },
  { tool: mmBrowseTool, executor: mmBrowseExecutor },
  { tool: mmMyListingsTool, executor: mmMyListingsExecutor, scope: "dm-only" },
  { tool: mmCancelTool, executor: mmCancelExecutor, scope: "dm-only" },
  { tool: mmSoldTool, executor: mmSoldExecutor, scope: "dm-only" },

  // 🔔 Listing Watcher
  { tool: listingWatchTool, executor: listingWatchExecutor, scope: "dm-only" },
  { tool: listingUnwatchTool, executor: listingUnwatchExecutor, scope: "dm-only" },
  { tool: watchSettingsTool, executor: watchSettingsExecutor, scope: "dm-only" },

  // 💰 Flip P&L Tracker
  { tool: flipSellTool, executor: flipSellExecutor, scope: "dm-only" },
  { tool: flipHistoryTool, executor: flipHistoryExecutor, scope: "dm-only" },
  { tool: flipStatsTool, executor: flipStatsExecutor, scope: "dm-only" },

  // 🔢 Number Rarity
  { tool: numberRarityTool, executor: numberRarityExecutor },
  { tool: numberCompareTool, executor: numberCompareExecutor },
  { tool: numberPortfolioRarityTool, executor: numberPortfolioRarityExecutor, scope: "dm-only" },

  // 🔢 Number Profile & Matchmaker
  { tool: numberProfileSetTool, executor: numberProfileSetExecutor, scope: "dm-only" },
  { tool: numberProfileViewTool, executor: numberProfileViewExecutor, scope: "dm-only" },
  { tool: numberListForSaleTool, executor: numberListForSaleExecutor, scope: "dm-only" },
  { tool: numberBrowseListingsTool, executor: numberBrowseListingsExecutor },
  { tool: numberSoldTool, executor: numberSoldExecutor, scope: "dm-only" },

  // 📡 Channel Scanner
  { tool: channelScanAddTool, executor: channelScanAddExecutor, scope: "dm-only" },
  { tool: channelScanRemoveTool, executor: channelScanRemoveExecutor, scope: "dm-only" },
  { tool: channelScanListTool, executor: channelScanListExecutor, scope: "dm-only" },
  { tool: channelParseTool, executor: channelParseExecutor, scope: "dm-only" },

  // 🔢🔍 Number Sniper
  { tool: numberSniperTool, executor: numberSniperExecutor, scope: "dm-only" },
  { tool: numberValuationTool, executor: numberValuationExecutor },
  { tool: numberCheckTool, executor: numberCheckExecutor },

  // 🔢📊 Number Market Intel
  { tool: numberMarketTool, executor: numberMarketExecutor },
  { tool: numberCategoryTool, executor: numberCategoryExecutor },
  { tool: numberWhalesTool, executor: numberWhalesExecutor },
  { tool: numberSearchTool, executor: numberSearchExecutor },

  // 🎁 Gift Collections
  { tool: giftCollectionsTool, executor: giftCollectionsExecutor },
  { tool: giftCollectionDetailTool, executor: giftCollectionDetailExecutor },
  { tool: giftRarityCheckTool, executor: giftRarityCheckExecutor },
  { tool: giftSearchTool, executor: giftSearchExecutor },
  { tool: giftRarestTool, executor: giftRarestExecutor },

  // 🏪 Gift Marketplace Aggregator
  { tool: giftPriceCompareTool, executor: giftPriceCompareExecutor },
  { tool: giftSniperTool, executor: giftSniperExecutor, scope: "dm-only" },
  { tool: giftBestDealTool, executor: giftBestDealExecutor },
  { tool: giftArbitrageTool, executor: giftArbitrageExecutor },

  // 🎁 Gift OTC Matchmaker
  { tool: giftMmListTool, executor: giftMmListExecutor, scope: "dm-only" },
  { tool: giftMmInterestTool, executor: giftMmInterestExecutor, scope: "dm-only" },
  { tool: giftMmBrowseTool, executor: giftMmBrowseExecutor },
  { tool: giftMmMyListingsTool, executor: giftMmMyListingsExecutor, scope: "dm-only" },
  { tool: giftMmCancelTool, executor: giftMmCancelExecutor, scope: "dm-only" },
  { tool: giftMmExpressTool, executor: giftMmExpressExecutor, scope: "dm-only" },
  { tool: giftMmSoldTool, executor: giftMmSoldExecutor, scope: "dm-only" },

  // 🎁 Gift Portfolio + P&L
  { tool: giftPortfolioAddTool, executor: giftPortfolioAddExecutor, scope: "dm-only" },
  { tool: giftPortfolioRemoveTool, executor: giftPortfolioRemoveExecutor, scope: "dm-only" },
  { tool: giftPortfolioViewTool, executor: giftPortfolioViewExecutor, scope: "dm-only" },

  // 🔍 Gift Trait Explorer
  { tool: giftTraitSearchTool, executor: giftTraitSearchExecutor },
  { tool: giftTraitCompareTool, executor: giftTraitCompareExecutor },

  // 🎨 Gift Set Detector
  { tool: giftSetScanTool, executor: giftSetScanExecutor, scope: "dm-only" },
  { tool: giftSetSuggestTool, executor: giftSetSuggestExecutor },

  // 💎 Gift Appraisal
  { tool: giftAppraiseTool, executor: giftAppraiseExecutor },

  // 🔔 Gift Alerts
  { tool: giftAlertSetTool, executor: giftAlertSetExecutor, scope: "dm-only" },
  { tool: giftAlertListTool, executor: giftAlertListExecutor, scope: "dm-only" },
  { tool: giftAlertRemoveTool, executor: giftAlertRemoveExecutor, scope: "dm-only" },
];
