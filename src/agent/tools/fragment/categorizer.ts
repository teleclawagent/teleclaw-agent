/**
 * 🏷️ Smart Username Categorizer
 *
 * 3-layer categorization:
 * 1. Rule-based (length, patterns, structure)
 * 2. Dictionary-based (500+ keywords mapped to categories)
 * 3. Seller-provided tags (manual override/addition)
 *
 * Designed to handle thousands of usernames accurately.
 */

import { createLogger } from "../../../utils/logger.js";

const _log = createLogger("Categorizer");

// ─── Category Definitions ────────────────────────────────────────────

export const CATEGORIES = {
  // By length
  ultra_short: { label: "Ultra Short (1-3)", desc: "Extremely rare, 1-3 character usernames" },
  short: { label: "Short (4)", desc: "4-character usernames — premium tier" },
  medium: { label: "Medium (5-6)", desc: "5-6 character usernames" },
  standard: { label: "Standard (7+)", desc: "7+ character usernames" },

  // By pattern
  numeric: { label: "Numeric", desc: "All digits (e.g. @8888, @123456)" },
  repeating: { label: "Repeating", desc: "Repeating pattern (e.g. @aaaa, @abab)" },
  palindrome: { label: "Palindrome", desc: "Reads same forwards/backwards" },
  single_word: { label: "Single Word", desc: "Clean dictionary word" },

  // By industry
  crypto: { label: "Crypto/Web3", desc: "Blockchain, DeFi, trading related" },
  finance: { label: "Finance", desc: "Banking, payments, money related" },
  gaming: { label: "Gaming", desc: "Games, esports, entertainment" },
  tech: { label: "Tech", desc: "Software, AI, development" },
  social: { label: "Social", desc: "Community, chat, networking" },
  business: { label: "Business", desc: "Commerce, brands, professional" },
  lifestyle: { label: "Lifestyle", desc: "Fashion, food, travel, health" },
  media: { label: "Media", desc: "News, content, streaming" },

  // By value type
  premium: { label: "Premium", desc: "High-value dictionary words, brand-worthy" },
  brandable: { label: "Brandable", desc: "Could be a company/product name" },
  emoji_name: { label: "Emoji/Symbol", desc: "Contains emoji or special chars" },
  country: { label: "Country/City", desc: "Geographic names" },
  name: { label: "Personal Name", desc: "First names, common names" },

  // Special
  ton_related: { label: "TON Ecosystem", desc: "Specifically TON/Telegram related" },
  meme: { label: "Meme/Culture", desc: "Meme culture, viral terms" },
  chinese: {
    label: "Chinese/中文",
    desc: "Pinyin words, lucky numbers, Chinese cultural significance",
  },
  other: { label: "Other", desc: "Uncategorized" },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

// ─── Extended Keyword Dictionary ─────────────────────────────────────

const KEYWORD_DICT: Record<string, CategoryKey[]> = {
  // ── Crypto/Web3 ──
  ton: ["crypto", "ton_related"],
  toncoin: ["crypto", "ton_related"],
  crypto: ["crypto"],
  bitcoin: ["crypto"],
  btc: ["crypto"],
  eth: ["crypto"],
  ethereum: ["crypto"],
  solana: ["crypto"],
  sol: ["crypto"],
  bnb: ["crypto"],
  defi: ["crypto"],
  nft: ["crypto"],
  dao: ["crypto"],
  web3: ["crypto"],
  token: ["crypto"],
  coin: ["crypto"],
  chain: ["crypto"],
  block: ["crypto"],
  blockchain: ["crypto"],
  dex: ["crypto"],
  cex: ["crypto"],
  swap: ["crypto"],
  stake: ["crypto"],
  staking: ["crypto"],
  yield: ["crypto"],
  farm: ["crypto"],
  mining: ["crypto"],
  miner: ["crypto"],
  mine: ["crypto"],
  hash: ["crypto"],
  ledger: ["crypto"],
  vault: ["crypto"],
  airdrop: ["crypto"],
  degen: ["crypto"],
  hodl: ["crypto"],
  whale: ["crypto"],
  bull: ["crypto"],
  bear: ["crypto"],
  pump: ["crypto"],
  dump: ["crypto"],
  moon: ["crypto"],
  rekt: ["crypto"],
  sats: ["crypto"],
  gwei: ["crypto"],
  wei: ["crypto"],
  bridge: ["crypto"],
  layer2: ["crypto"],
  l2: ["crypto"],
  rollup: ["crypto"],
  zk: ["crypto"],
  oracle: ["crypto"],
  liquidity: ["crypto"],
  pool: ["crypto"],
  validator: ["crypto"],
  node: ["crypto"],
  consensus: ["crypto"],
  protocol: ["crypto"],
  smart: ["crypto", "tech"],
  contract: ["crypto"],
  onchain: ["crypto"],
  offchain: ["crypto"],
  crosschain: ["crypto"],
  multichain: ["crypto"],
  metaverse: ["crypto", "gaming"],

  // ── TON Ecosystem ──
  tg: ["ton_related"],
  telegram: ["ton_related"],
  fragment: ["ton_related"],
  tonkeeper: ["ton_related"],
  tonhub: ["ton_related"],
  getgems: ["ton_related"],
  tonapi: ["ton_related"],
  tonscan: ["ton_related"],
  stonfi: ["ton_related"],
  dedust: ["ton_related"],
  jetton: ["ton_related", "crypto"],
  tonstake: ["ton_related", "crypto"],
  tonspace: ["ton_related"],
  wallet: ["crypto", "finance"],
  wallets: ["crypto", "finance"],

  // ── Finance ──
  bank: ["finance"],
  banking: ["finance"],
  pay: ["finance"],
  payment: ["finance"],
  cash: ["finance"],
  money: ["finance"],
  fund: ["finance"],
  funds: ["finance"],
  invest: ["finance"],
  investor: ["finance"],
  trading: ["finance", "crypto"],
  trade: ["finance", "crypto"],
  trader: ["finance", "crypto"],
  forex: ["finance"],
  stock: ["finance"],
  stocks: ["finance"],
  market: ["finance", "business"],
  capital: ["finance"],
  asset: ["finance"],
  assets: ["finance"],
  credit: ["finance"],
  debit: ["finance"],
  loan: ["finance"],
  mortgage: ["finance"],
  insurance: ["finance"],
  fintech: ["finance", "tech"],
  revenue: ["finance"],
  profit: ["finance"],
  income: ["finance"],
  wealth: ["finance"],
  rich: ["finance"],

  // ── Gaming ──
  game: ["gaming"],
  games: ["gaming"],
  gamer: ["gaming"],
  play: ["gaming"],
  player: ["gaming"],
  esport: ["gaming"],
  esports: ["gaming"],
  gg: ["gaming"],
  pvp: ["gaming"],
  rpg: ["gaming"],
  mmo: ["gaming"],
  fps: ["gaming"],
  quest: ["gaming"],
  level: ["gaming"],
  boss: ["gaming"],
  loot: ["gaming"],
  raid: ["gaming"],
  clan: ["gaming"],
  guild: ["gaming"],
  arena: ["gaming"],
  battle: ["gaming"],
  score: ["gaming"],
  win: ["gaming"],
  winner: ["gaming"],
  champ: ["gaming"],
  champion: ["gaming"],
  bet: ["gaming", "finance"],
  betting: ["gaming", "finance"],
  casino: ["gaming"],
  poker: ["gaming"],
  dice: ["gaming"],
  slot: ["gaming"],
  slots: ["gaming"],
  jackpot: ["gaming"],
  streak: ["gaming"],
  combo: ["gaming"],

  // ── Tech ──
  dev: ["tech"],
  developer: ["tech"],
  code: ["tech"],
  coder: ["tech"],
  coding: ["tech"],
  hack: ["tech"],
  hacker: ["tech"],
  api: ["tech"],
  sdk: ["tech"],
  app: ["tech"],
  apps: ["tech"],
  software: ["tech"],
  cloud: ["tech"],
  server: ["tech"],
  data: ["tech"],
  ai: ["tech"],
  bot: ["tech", "ton_related"],
  bots: ["tech", "ton_related"],
  ml: ["tech"],
  neural: ["tech"],
  algo: ["tech"],
  algorithm: ["tech"],
  cyber: ["tech"],
  digital: ["tech"],
  pixel: ["tech"],
  binary: ["tech"],
  quantum: ["tech"],
  robot: ["tech"],
  auto: ["tech"],
  automation: ["tech"],
  open: ["tech"],
  source: ["tech"],
  git: ["tech"],
  linux: ["tech"],
  web: ["tech"],
  net: ["tech"],
  io: ["tech"],
  sys: ["tech"],
  system: ["tech"],

  // ── Social ──
  chat: ["social", "ton_related"],
  group: ["social"],
  community: ["social"],
  social: ["social"],
  friend: ["social"],
  friends: ["social"],
  follow: ["social"],
  like: ["social"],
  share: ["social"],
  connect: ["social"],
  network: ["social"],
  club: ["social"],
  hub: ["social"],
  space: ["social"],
  meet: ["social"],
  dating: ["social"],
  love: ["social"],
  match: ["social"],

  // ── Business ──
  shop: ["business"],
  store: ["business"],
  buy: ["business"],
  sell: ["business"],
  deal: ["business"],
  deals: ["business"],
  sale: ["business"],
  sales: ["business"],
  offer: ["business"],
  brand: ["business"],
  biz: ["business"],
  company: ["business"],
  corp: ["business"],
  inc: ["business"],
  llc: ["business"],
  ceo: ["business"],
  founder: ["business"],
  startup: ["business"],
  agency: ["business"],
  service: ["business"],
  pro: ["business"],
  premium: ["business", "premium"],
  vip: ["business", "premium"],
  elite: ["business", "premium"],
  luxury: ["business", "premium"],

  // ── Lifestyle ──
  fashion: ["lifestyle"],
  style: ["lifestyle"],
  beauty: ["lifestyle"],
  fitness: ["lifestyle"],
  gym: ["lifestyle"],
  health: ["lifestyle"],
  food: ["lifestyle"],
  travel: ["lifestyle"],
  hotel: ["lifestyle"],
  car: ["lifestyle"],
  cars: ["lifestyle"],
  speed: ["lifestyle"],
  fast: ["lifestyle"],
  zen: ["lifestyle"],
  yoga: ["lifestyle"],
  vegan: ["lifestyle"],
  organic: ["lifestyle"],
  eco: ["lifestyle"],
  green: ["lifestyle"],
  nature: ["lifestyle"],
  art: ["lifestyle"],
  music: ["lifestyle"],
  photo: ["lifestyle"],
  design: ["lifestyle"],

  // ── Media ──
  news: ["media"],
  media: ["media"],
  press: ["media"],
  blog: ["media"],
  vlog: ["media"],
  video: ["media"],
  stream: ["media"],
  live: ["media"],
  tv: ["media"],
  radio: ["media"],
  podcast: ["media"],
  channel: ["media", "ton_related"],
  content: ["media"],
  creator: ["media"],
  viral: ["media"],

  // ── Premium/Value Words ──
  king: ["premium"],
  queen: ["premium"],
  royal: ["premium"],
  crown: ["premium"],
  diamond: ["premium"],
  gold: ["premium"],
  golden: ["premium"],
  silver: ["premium"],
  platinum: ["premium"],
  star: ["premium"],
  stars: ["premium"],
  mega: ["premium"],
  super: ["premium"],
  ultra: ["premium"],
  prime: ["premium"],
  alpha: ["premium"],
  omega: ["premium"],
  god: ["premium"],
  legend: ["premium"],
  epic: ["premium"],
  rare: ["premium"],
  top: ["premium"],
  best: ["premium"],
  first: ["premium"],
  one: ["premium"],
  max: ["premium"],
  power: ["premium"],
  fire: ["premium"],
  flame: ["premium"],
  thunder: ["premium"],
  dark: ["premium"],
  shadow: ["premium"],
  night: ["premium"],
  storm: ["premium"],
  dragon: ["premium"],
  wolf: ["premium"],
  eagle: ["premium"],
  lion: ["premium"],
  tiger: ["premium"],
  phoenix: ["premium"],
  ghost: ["premium"],
  ninja: ["premium"],
  samurai: ["premium"],
  knight: ["premium"],
  warrior: ["premium"],

  // ── Meme/Culture ──
  meme: ["meme"],
  doge: ["meme", "crypto"],
  pepe: ["meme", "crypto"],
  ape: ["meme", "crypto"],
  frog: ["meme"],
  based: ["meme"],
  chad: ["meme"],
  sigma: ["meme"],
  cope: ["meme"],
  fomo: ["meme", "crypto"],
  wagmi: ["meme", "crypto"],
  ngmi: ["meme", "crypto"],
  gm: ["meme", "crypto"],
  ser: ["meme", "crypto"],
  anon: ["meme", "crypto"],
  wen: ["meme", "crypto"],
  lambo: ["meme", "crypto"],
  yolo: ["meme"],
  bruh: ["meme"],
  lol: ["meme"],
  vibe: ["meme"],
  ratio: ["meme"],

  // ── Countries/Cities ──
  usa: ["country"],
  uk: ["country"],
  dubai: ["country"],
  london: ["country"],
  paris: ["country"],
  tokyo: ["country"],
  berlin: ["country"],
  moscow: ["country"],
  china: ["country"],
  india: ["country"],
  korea: ["country"],
  japan: ["country"],
  turkey: ["country"],
  istanbul: ["country"],
  ankara: ["country"],
  russia: ["country"],
  brazil: ["country"],
  mexico: ["country"],
  canada: ["country"],
  australia: ["country"],
  singapore: ["country"],
  hong: ["country"],
  kong: ["country"],
  europe: ["country"],
  asia: ["country"],
  africa: ["country"],
  arab: ["country"],
  global: ["country"],
  world: ["country"],
  inter: ["country"],

  // ── Common Names ──
  alex: ["name"],
  sam: ["name"],
  adam: ["name"],
  john: ["name"],
  mike: ["name"],
  david: ["name"],
  james: ["name"],
  dan: ["name"],
  ali: ["name"],
  omar: ["name"],
  ahmed: ["name"],
  chris: ["name"],
  nick: ["name"],
  mark: ["name"],
  leo: ["name"],
  kai: ["name"],
  ace: ["name", "premium"],
  ben: ["name"],
  tom: ["name"],
  jack: ["name"],
  emma: ["name"],
  anna: ["name"],
  sara: ["name"],
  luna: ["name", "crypto"],
  nova: ["name", "premium"],

  // ── Chinese / Pinyin ──
  // Common pinyin words with high value in Chinese market
  // Wealth & Prosperity
  fa: ["chinese", "premium"],
  facai: ["chinese", "premium"],
  cai: ["chinese", "finance"],
  fu: ["chinese", "premium"],
  fuqi: ["chinese"],
  jinbi: ["chinese", "finance"],
  jin: ["chinese", "premium"],
  bao: ["chinese", "premium"],
  caifu: ["chinese", "finance"],
  qian: ["chinese", "finance"],
  fuhao: ["chinese", "premium"],
  dafei: ["chinese"],

  // Lucky / Auspicious
  jixiang: ["chinese"],
  hao: ["chinese"],
  daji: ["chinese"],
  xingfu: ["chinese"],
  xiyun: ["chinese"],
  ruyi: ["chinese"],
  shunli: ["chinese"],
  haoyun: ["chinese"],
  fuyun: ["chinese"],

  // Love & Relationships (ai already defined in tech section)
  aiqing: ["chinese"],
  xin: ["chinese"],
  qing: ["chinese"],
  meili: ["chinese"],
  aini: ["chinese"],

  // Power & Status
  wang: ["chinese", "name"],
  huang: ["chinese", "premium"],
  long: ["chinese", "premium"],
  feng: ["chinese"],
  tian: ["chinese"],
  di: ["chinese"],
  shen: ["chinese"],
  xiong: ["chinese"],
  ying: ["chinese"],
  zhan: ["chinese"],
  ba: ["chinese"],
  dawang: ["chinese", "premium"],
  laoban: ["chinese", "business"],
  zong: ["chinese", "business"],

  // Animals (zodiac + cultural)
  longma: ["chinese"],
  hu: ["chinese"],
  she: ["chinese"],
  niu: ["chinese"],
  tu: ["chinese"],
  ma: ["chinese"],
  yang: ["chinese"],
  hou: ["chinese"],
  ji: ["chinese"],
  gou: ["chinese"],
  zhu: ["chinese"],
  shu: ["chinese"],

  // Nature & Elements
  shan: ["chinese"],
  shui: ["chinese"],
  huo: ["chinese"],
  // feng already defined in Power & Status
  // yun already defined above
  // yue already defined above
  ri: ["chinese"],
  xing: ["chinese"],
  hai: ["chinese"],
  he: ["chinese"],
  hua: ["chinese"],
  lin: ["chinese"],
  mei: ["chinese", "lifestyle"],

  // Tech & Modern
  keji: ["chinese", "tech"],
  wangluo: ["chinese", "tech"],
  dianzi: ["chinese", "tech"],
  zhineng: ["chinese", "tech"],
  youxi: ["chinese", "gaming"],
  wanjia: ["chinese", "gaming"],
  dianshang: ["chinese", "business"],
  pingtai: ["chinese", "tech"],

  // Common Chinese names (pinyin)
  // wei already defined in crypto section
  ming: ["chinese", "name"],
  jun: ["chinese", "name"],
  jie: ["chinese", "name"],
  ling: ["chinese", "name"],
  xiao: ["chinese", "name"],
  chen: ["chinese", "name"],
  li: ["chinese", "name"],
  zhang: ["chinese", "name"],
  liu: ["chinese", "name"],
  zhao: ["chinese", "name"],
  wu: ["chinese", "name"],
  zhou: ["chinese", "name"],
  sun: ["chinese", "name"],
  qiang: ["chinese", "name"],
  fang: ["chinese", "name"],
  liang: ["chinese", "name"],
  cheng: ["chinese", "name"],
  peng: ["chinese", "name"],
  zhi: ["chinese", "name"],
  // hong already defined in country section
  guo: ["chinese"],

  // High-value compound words (record sales / premium)
  danbao: ["chinese", "finance"],
  zhongguo: ["chinese", "country"],
  taobao: ["chinese", "business"],
  baidu: ["chinese", "tech"],
  douyin: ["chinese", "media"],
  kuaishou: ["chinese", "media"],
  bilibili: ["chinese", "media"],
  xiaohongshu: ["chinese", "media"],
  zhifubao: ["chinese", "finance"],
  jingdong: ["chinese", "business"],
  meituan: ["chinese", "business"],
  pinduoduo: ["chinese", "business"],
  tencent: ["chinese", "tech"],
  alibaba: ["chinese", "business"],
  wechat: ["chinese", "tech"],
  alipay: ["chinese", "finance"],
  bytedance: ["chinese", "tech"],
  xiaomi: ["chinese", "tech"],
  huawei: ["chinese", "tech"],
  oppo: ["chinese", "tech"],
  vivo: ["chinese", "tech"],
  lenovo: ["chinese", "tech"],

  // Business & Finance compound
  shangye: ["chinese", "business"],
  touzi: ["chinese", "finance"],
  gupiao: ["chinese", "finance"],
  jijin: ["chinese", "finance"],
  yinhang: ["chinese", "finance"],
  zhengquan: ["chinese", "finance"],
  baoxian: ["chinese", "finance"],
  dichan: ["chinese", "finance"],
  fangchan: ["chinese", "finance"],
  jinrong: ["chinese", "finance"],
  huobi: ["chinese", "finance"],
  qukuailian: ["chinese", "tech"],
  shuzi: ["chinese", "tech"],
  shumabi: ["chinese", "finance"],

  // Culture & Society compound
  zhonghua: ["chinese", "premium"],
  guobao: ["chinese", "premium"],
  longfeng: ["chinese", "premium"],
  fenghuang: ["chinese", "premium"],
  qilin: ["chinese", "premium"],
  tianxia: ["chinese", "premium"],
  jiangshan: ["chinese", "premium"],
  shenlong: ["chinese", "premium"],
  wulong: ["chinese", "lifestyle"],
  longteng: ["chinese", "premium"],
  huli: ["chinese"],
  maotai: ["chinese", "premium"],
  baijiu: ["chinese", "lifestyle"],
  gongfu: ["chinese"],
  wushu: ["chinese"],
  taiji: ["chinese"],
  shaolin: ["chinese"],
  kunlun: ["chinese"],
  emei: ["chinese"],
  wudang: ["chinese"],

  // Internet & Social compound
  wangzhan: ["chinese", "tech"],
  youxiang: ["chinese", "tech"],
  shouji: ["chinese", "tech"],
  dianhua: ["chinese", "tech"],
  diannao: ["chinese", "tech"],
  ruanjian: ["chinese", "tech"],
  yingyong: ["chinese", "tech"],
  wangdian: ["chinese", "business"],
  zhibo: ["chinese", "media"],
  duanshipin: ["chinese", "media"],
  zixun: ["chinese", "media"],
  xinwen: ["chinese", "media"],

  // Education & Health compound
  jiaoyu: ["chinese"],
  yiliao: ["chinese"],
  yiyuan: ["chinese"],
  xuexiao: ["chinese"],
  daxue: ["chinese"],
  laoshi: ["chinese", "name"],

  // Food & Lifestyle
  cha: ["chinese", "lifestyle"],
  fan: ["chinese"],
  chi: ["chinese"],
  meishi: ["chinese", "lifestyle"],
  chaye: ["chinese", "lifestyle"],
  // baijiu already defined above

  // Business & Commerce (unique entries only — shangye, touzi, jijin, zhengquan, huobi, qukuailian already above)
  maoyi: ["chinese", "business"],
  gongsi: ["chinese", "business"],
  bibi: ["chinese", "crypto"],

  // Numbers as pinyin (liu already defined in names section)
  yi: ["chinese"],
  er: ["chinese"],
  san: ["chinese"],
  si: ["chinese"],
  qi: ["chinese"],
  shi: ["chinese"],
};

// ─── Chinese Lucky Number Analysis ───────────────────────────────────

interface ChineseNumberAnalysis {
  isChinese: boolean;
  luckyScore: number; // -100 to +100
  meaning: string[];
  tier: "ultra_lucky" | "very_lucky" | "lucky" | "neutral" | "unlucky" | "mixed";
}

function analyzeChineseNumbers(username: string): ChineseNumberAnalysis {
  const clean = username.replace(/^@/, "");
  if (!/^\d+$/.test(clean)) {
    return { isChinese: false, luckyScore: 0, meaning: [], tier: "neutral" };
  }

  const digits = clean.split("").map(Number);
  let score = 0;
  const meanings: string[] = [];

  // Individual digit scoring
  const digitScores: Record<number, { score: number; meaning: string }> = {
    0: { score: 0, meaning: "零 (líng) — wholeness" },
    1: { score: 5, meaning: "一 (yī) — unity, first" },
    2: { score: 10, meaning: "二 (èr) — pairs, harmony" },
    3: { score: 5, meaning: "三 (sān) — life, growth" },
    4: { score: -30, meaning: "四 (sì) — sounds like 死 (death) ⚠️" },
    5: { score: 5, meaning: "五 (wǔ) — balance, elements" },
    6: { score: 20, meaning: "六 (liù) — 顺 smooth, everything goes well" },
    7: { score: 5, meaning: "七 (qī) — togetherness" },
    8: { score: 30, meaning: "八 (bā) — 发 wealth, prosperity 🔥" },
    9: { score: 15, meaning: "九 (jiǔ) — 久 longevity, eternal" },
  };

  for (const d of digits) {
    const info = digitScores[d];
    if (info) {
      score += info.score;
      if (!meanings.includes(info.meaning)) meanings.push(info.meaning);
    }
  }

  // Pattern bonuses
  // All same digit (e.g. 8888)
  if (new Set(digits).size === 1) {
    score += 30;
    meanings.push(`Repeating ${digits[0]} — extreme emphasis`);
  }

  // Sequential (ascending/descending)
  const isAsc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const isDesc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (isAsc || isDesc) {
    score += 10;
    meanings.push("Sequential — flowing energy");
  }

  // Special combos
  const str = clean;
  if (str === "520") {
    score += 25;
    meanings.push("520 = 我爱你 (I love you) 💕");
  }
  if (str === "1314") {
    score += 25;
    meanings.push("1314 = 一生一世 (forever) 💕");
  }
  if (str === "5201314") {
    score += 60;
    meanings.push("5201314 = I love you forever 💕💕");
  }
  if (str === "666") {
    score += 25;
    meanings.push("666 = 牛牛牛 (awesome!) 🔥");
  }
  if (str === "888") {
    score += 35;
    meanings.push("888 = triple wealth 🔥🔥🔥");
  }
  if (str === "168") {
    score += 20;
    meanings.push("168 = 一路发 (prosperity all the way)");
  }
  if (str === "518") {
    score += 20;
    meanings.push("518 = 我要发 (I will be rich)");
  }
  if (str === "1688") {
    score += 25;
    meanings.push("1688 = 一路发发 (wealth on the way)");
  }
  if (str === "6688") {
    score += 25;
    meanings.push("6688 = smooth + wealthy");
  }
  if (str === "9999") {
    score += 30;
    meanings.push("9999 = eternal, long-lasting");
  }
  if (str === "8888") {
    score += 40;
    meanings.push("8888 = ultimate wealth 🔥🔥🔥🔥");
  }
  if (str === "6666") {
    score += 25;
    meanings.push("6666 = everything smooth");
  }
  if (/^[68]+$/.test(str)) {
    score += 15;
    meanings.push("Only 6s and 8s — pure luck + wealth");
  }
  if (/^[89]+$/.test(str)) {
    score += 15;
    meanings.push("Only 8s and 9s — wealth + longevity");
  }

  // No 4s bonus
  if (!digits.includes(4) && digits.some((d) => [6, 8, 9].includes(d))) {
    score += 5;
    meanings.push("No 4 (no death association) ✓");
  }

  // All 4s penalty
  if (digits.every((d) => d === 4)) {
    score -= 50;
    meanings.push("All 4s — extremely unlucky in Chinese culture ⚠️");
  }

  // Normalize score to -100..+100
  score = Math.max(-100, Math.min(100, score));

  const tier: ChineseNumberAnalysis["tier"] =
    score >= 60
      ? "ultra_lucky"
      : score >= 35
        ? "very_lucky"
        : score >= 15
          ? "lucky"
          : score >= -10
            ? "neutral"
            : score < -10 && digits.some((d) => [6, 8].includes(d))
              ? "mixed"
              : "unlucky";

  return { isChinese: true, luckyScore: score, meaning: meanings, tier };
}

// Export for valuation engine
export { analyzeChineseNumbers };
export type { ChineseNumberAnalysis };

// ─── Chinese Meaning Dictionary ──────────────────────────────────────

const CHINESE_MEANINGS: Record<
  string,
  { hanzi: string; pinyin: string; meaning: string; cultural?: string }
> = {
  // Wealth & Prosperity
  fa: {
    hanzi: "发",
    pinyin: "fā",
    meaning: "wealth, to prosper",
    cultural: "Symbol of getting rich",
  },
  facai: {
    hanzi: "发财",
    pinyin: "fā cái",
    meaning: "get rich, make a fortune",
    cultural: "One of the most auspicious phrases",
  },
  cai: { hanzi: "财", pinyin: "cái", meaning: "wealth, money" },
  fu: {
    hanzi: "福",
    pinyin: "fú",
    meaning: "fortune, blessing",
    cultural: "Most important Chinese character for luck",
  },
  fuqi: { hanzi: "富气", pinyin: "fù qì", meaning: "wealthy aura" },
  jin: { hanzi: "金", pinyin: "jīn", meaning: "gold" },
  jinbi: { hanzi: "金币", pinyin: "jīn bì", meaning: "gold coin" },
  bao: { hanzi: "宝", pinyin: "bǎo", meaning: "treasure, precious" },
  caifu: { hanzi: "财富", pinyin: "cái fù", meaning: "wealth, riches" },
  qian: { hanzi: "钱", pinyin: "qián", meaning: "money" },
  fuhao: { hanzi: "富豪", pinyin: "fù háo", meaning: "tycoon, mogul" },
  dafei: { hanzi: "大飞", pinyin: "dà fēi", meaning: "big flight, soaring" },
  huang: {
    hanzi: "黄",
    pinyin: "huáng",
    meaning: "gold/imperial yellow",
    cultural: "Color of emperors",
  },

  // Lucky & Auspicious
  jixiang: { hanzi: "吉祥", pinyin: "jí xiáng", meaning: "auspicious, lucky" },
  hao: { hanzi: "好", pinyin: "hǎo", meaning: "good, excellent" },
  daji: {
    hanzi: "大吉",
    pinyin: "dà jí",
    meaning: "great luck",
    cultural: "Used in blessings and celebrations",
  },
  xingfu: { hanzi: "幸福", pinyin: "xìng fú", meaning: "happiness, bliss" },
  xiyun: { hanzi: "喜运", pinyin: "xǐ yùn", meaning: "happy fortune" },
  ruyi: {
    hanzi: "如意",
    pinyin: "rú yì",
    meaning: "as one wishes",
    cultural: "Symbol of fulfilled desires",
  },
  shunli: { hanzi: "顺利", pinyin: "shùn lì", meaning: "smooth, successful" },
  haoyun: { hanzi: "好运", pinyin: "hǎo yùn", meaning: "good luck" },
  fuyun: { hanzi: "福运", pinyin: "fú yùn", meaning: "blessed fortune" },

  // Love & Relationships
  ai: { hanzi: "爱", pinyin: "ài", meaning: "love" },
  aiqing: { hanzi: "爱情", pinyin: "ài qíng", meaning: "romantic love" },
  xin: { hanzi: "心", pinyin: "xīn", meaning: "heart" },
  qing: { hanzi: "情", pinyin: "qíng", meaning: "emotion, feeling" },
  meili: { hanzi: "美丽", pinyin: "měi lì", meaning: "beautiful" },
  aini: { hanzi: "爱你", pinyin: "ài nǐ", meaning: "I love you" },

  // Power & Status
  wang: { hanzi: "王", pinyin: "wáng", meaning: "king" },
  long: {
    hanzi: "龙",
    pinyin: "lóng",
    meaning: "dragon",
    cultural: "Symbol of imperial power and strength",
  },
  feng: { hanzi: "凤", pinyin: "fèng", meaning: "phoenix" },
  tian: { hanzi: "天", pinyin: "tiān", meaning: "heaven, sky" },
  di: { hanzi: "帝", pinyin: "dì", meaning: "emperor" },
  shen: { hanzi: "神", pinyin: "shén", meaning: "god, divine" },
  dawang: { hanzi: "大王", pinyin: "dà wáng", meaning: "great king" },
  laoban: {
    hanzi: "老板",
    pinyin: "lǎo bǎn",
    meaning: "boss",
    cultural: "Term of respect in business",
  },
  zong: { hanzi: "总", pinyin: "zǒng", meaning: "chief, general (title)" },
  tianxia: {
    hanzi: "天下",
    pinyin: "tiān xià",
    meaning: "all under heaven",
    cultural: "The whole world/empire",
  },
  jiangshan: {
    hanzi: "江山",
    pinyin: "jiāng shān",
    meaning: "rivers and mountains",
    cultural: "Metaphor for nation/empire",
  },

  // Culture & Premium
  zhonghua: {
    hanzi: "中华",
    pinyin: "zhōng huá",
    meaning: "China/Chinese civilization",
    cultural: "The most prestigious term for China",
  },
  zhongguo: { hanzi: "中国", pinyin: "zhōng guó", meaning: "China" },
  guobao: {
    hanzi: "国宝",
    pinyin: "guó bǎo",
    meaning: "national treasure",
    cultural: "Also refers to the panda",
  },
  longfeng: {
    hanzi: "龙凤",
    pinyin: "lóng fèng",
    meaning: "dragon and phoenix",
    cultural: "Symbol of perfect harmony",
  },
  fenghuang: {
    hanzi: "凤凰",
    pinyin: "fèng huáng",
    meaning: "phoenix",
    cultural: "Symbol of rebirth and beauty",
  },
  qilin: {
    hanzi: "麒麟",
    pinyin: "qí lín",
    meaning: "qilin (mythical beast)",
    cultural: "Brings prosperity and luck",
  },
  shenlong: { hanzi: "神龙", pinyin: "shén lóng", meaning: "divine dragon" },
  longteng: {
    hanzi: "龙腾",
    pinyin: "lóng téng",
    meaning: "dragon rising",
    cultural: "Symbol of China's rise",
  },
  maotai: {
    hanzi: "茅台",
    pinyin: "máo tái",
    meaning: "Moutai liquor",
    cultural: "Most prestigious Chinese spirit",
  },
  gongfu: { hanzi: "功夫", pinyin: "gōng fu", meaning: "kung fu, martial arts" },
  wushu: { hanzi: "武术", pinyin: "wǔ shù", meaning: "martial arts" },
  taiji: {
    hanzi: "太极",
    pinyin: "tài jí",
    meaning: "tai chi",
    cultural: "Represents yin-yang balance",
  },
  shaolin: {
    hanzi: "少林",
    pinyin: "shào lín",
    meaning: "Shaolin",
    cultural: "Legendary martial arts temple",
  },

  // Business & Finance compound
  danbao: {
    hanzi: "担保",
    pinyin: "dān bǎo",
    meaning: "guarantee, collateral",
    cultural: "Important in finance and trust",
  },
  shangye: { hanzi: "商业", pinyin: "shāng yè", meaning: "business, commerce" },
  touzi: { hanzi: "投资", pinyin: "tóu zī", meaning: "investment" },
  gupiao: { hanzi: "股票", pinyin: "gǔ piào", meaning: "stocks, shares" },
  jijin: { hanzi: "基金", pinyin: "jī jīn", meaning: "fund (investment)" },
  yinhang: { hanzi: "银行", pinyin: "yín háng", meaning: "bank" },
  jinrong: { hanzi: "金融", pinyin: "jīn róng", meaning: "finance" },
  huobi: { hanzi: "货币", pinyin: "huò bì", meaning: "currency" },
  dichan: { hanzi: "地产", pinyin: "dì chǎn", meaning: "real estate" },
  fangchan: { hanzi: "房产", pinyin: "fáng chǎn", meaning: "property" },

  // Tech Brands
  taobao: {
    hanzi: "淘宝",
    pinyin: "táo bǎo",
    meaning: "search for treasure",
    cultural: "Alibaba's e-commerce platform",
  },
  baidu: {
    hanzi: "百度",
    pinyin: "bǎi dù",
    meaning: "hundred times",
    cultural: "China's largest search engine",
  },
  douyin: {
    hanzi: "抖音",
    pinyin: "dǒu yīn",
    meaning: "vibrating sound",
    cultural: "TikTok's Chinese version",
  },
  kuaishou: {
    hanzi: "快手",
    pinyin: "kuài shǒu",
    meaning: "fast hand",
    cultural: "Major short video platform",
  },
  bilibili: {
    hanzi: "哔哩哔哩",
    pinyin: "bì lì bì lì",
    meaning: "onomatopoeia",
    cultural: "Leading anime/video platform",
  },
  zhifubao: {
    hanzi: "支付宝",
    pinyin: "zhī fù bǎo",
    meaning: "payment treasure",
    cultural: "Alipay",
  },
  jingdong: {
    hanzi: "京东",
    pinyin: "jīng dōng",
    meaning: "capital east",
    cultural: "JD.com e-commerce",
  },
  meituan: {
    hanzi: "美团",
    pinyin: "měi tuán",
    meaning: "beautiful group",
    cultural: "Food delivery & services",
  },
  pinduoduo: {
    hanzi: "拼多多",
    pinyin: "pīn duō duō",
    meaning: "together more more",
    cultural: "Group-buy e-commerce",
  },
  weixin: { hanzi: "微信", pinyin: "wēi xìn", meaning: "micro message", cultural: "WeChat" },
  xiaomi: { hanzi: "小米", pinyin: "xiǎo mǐ", meaning: "little rice", cultural: "Tech giant" },
  huawei: {
    hanzi: "华为",
    pinyin: "huá wéi",
    meaning: "China can",
    cultural: "Telecom & tech leader",
  },

  // Media & Internet
  zhibo: { hanzi: "直播", pinyin: "zhí bō", meaning: "livestream" },
  xinwen: { hanzi: "新闻", pinyin: "xīn wén", meaning: "news" },
  zixun: { hanzi: "资讯", pinyin: "zī xùn", meaning: "information" },

  // Nature
  shan: { hanzi: "山", pinyin: "shān", meaning: "mountain" },
  shui: { hanzi: "水", pinyin: "shuǐ", meaning: "water" },
  huo: { hanzi: "火", pinyin: "huǒ", meaning: "fire" },
  yun: { hanzi: "云", pinyin: "yún", meaning: "cloud" },
  yue: { hanzi: "月", pinyin: "yuè", meaning: "moon" },
  hai: { hanzi: "海", pinyin: "hǎi", meaning: "sea, ocean" },
  hua: { hanzi: "花", pinyin: "huā", meaning: "flower" },

  // Animals (zodiac)
  hu: { hanzi: "虎", pinyin: "hǔ", meaning: "tiger" },
  she: { hanzi: "蛇", pinyin: "shé", meaning: "snake" },
  niu: { hanzi: "牛", pinyin: "niú", meaning: "ox/bull", cultural: "Also slang for awesome" },
  ma: { hanzi: "马", pinyin: "mǎ", meaning: "horse" },
  longma: {
    hanzi: "龙马",
    pinyin: "lóng mǎ",
    meaning: "dragon horse",
    cultural: "Symbol of vitality",
  },

  // Food & Lifestyle
  cha: { hanzi: "茶", pinyin: "chá", meaning: "tea", cultural: "Central to Chinese culture" },
  jiu: { hanzi: "酒", pinyin: "jiǔ", meaning: "wine/liquor" },
  baijiu: { hanzi: "白酒", pinyin: "bái jiǔ", meaning: "Chinese white liquor" },
  wulong: { hanzi: "乌龙", pinyin: "wū lóng", meaning: "oolong tea" },
  mei: { hanzi: "美", pinyin: "měi", meaning: "beautiful" },
};

/**
 * Get the Chinese cultural meaning of a username.
 * Returns meaning info if the username (or parts of it) have Chinese significance.
 */
export interface ChineseMeaning {
  hasMeaning: boolean;
  hanzi?: string;
  pinyin?: string;
  meaning?: string;
  cultural?: string;
  numberAnalysis?: ChineseNumberAnalysis;
  summary: string; // Human-readable one-liner
}

export function getChineseMeaning(username: string): ChineseMeaning {
  const clean = username.replace(/^@/, "").toLowerCase();

  // Check exact match first
  if (CHINESE_MEANINGS[clean]) {
    const m = CHINESE_MEANINGS[clean];
    const summary = `${m.hanzi} (${m.pinyin}) — ${m.meaning}${m.cultural ? ` | ${m.cultural}` : ""}`;
    return { hasMeaning: true, ...m, summary };
  }

  // Check if it's a number
  if (/^\d+$/.test(clean)) {
    const numAnalysis = analyzeChineseNumbers(clean);
    if (numAnalysis.tier !== "neutral") {
      // Prefer special combo meanings (520, 888, etc.) over digit-by-digit
      const specialMeanings = numAnalysis.meaning.filter(
        (m) => m.includes("=") || m.includes("Repeating") || m.includes("Only")
      );
      const summary =
        specialMeanings.length > 0
          ? specialMeanings.slice(0, 2).join(" · ")
          : numAnalysis.meaning.slice(0, 2).join(" · ");
      return {
        hasMeaning: true,
        numberAnalysis: numAnalysis,
        summary: `Lucky number: ${summary}`,
      };
    }
  }

  // Check compound: split into known pinyin parts
  // Try splitting username into two known words
  for (let i = 2; i < clean.length - 1; i++) {
    const part1 = clean.slice(0, i);
    const part2 = clean.slice(i);
    if (CHINESE_MEANINGS[part1] && CHINESE_MEANINGS[part2]) {
      const m1 = CHINESE_MEANINGS[part1];
      const m2 = CHINESE_MEANINGS[part2];
      const summary = `${m1.hanzi}${m2.hanzi} (${m1.pinyin} ${m2.pinyin}) — ${m1.meaning} + ${m2.meaning}`;
      return {
        hasMeaning: true,
        hanzi: `${m1.hanzi}${m2.hanzi}`,
        pinyin: `${m1.pinyin} ${m2.pinyin}`,
        meaning: `${m1.meaning} + ${m2.meaning}`,
        summary,
      };
    }
  }

  // Check if username contains a known word + digits
  const alphaMatch = clean.match(/^([a-z]+)(\d+)$/);
  if (alphaMatch) {
    const [, word, nums] = alphaMatch;
    if (CHINESE_MEANINGS[word]) {
      const m = CHINESE_MEANINGS[word];
      const numAnalysis = analyzeChineseNumbers(nums);
      const numPart =
        numAnalysis.tier !== "neutral" ? ` + ${numAnalysis.meaning[0] || nums}` : ` + ${nums}`;
      const summary = `${m.hanzi} (${m.pinyin}) — ${m.meaning}${numPart}`;
      return { hasMeaning: true, ...m, numberAnalysis: numAnalysis, summary };
    }
  }

  return { hasMeaning: false, summary: "" };
}

// ─── Rule-Based Categorization ───────────────────────────────────────

function applyRules(username: string): CategoryKey[] {
  const clean = username.replace(/^@/, "").toLowerCase();
  const cats = new Set<CategoryKey>();
  const len = clean.length;

  // ── Length Rules ──
  if (len <= 3) cats.add("ultra_short");
  else if (len === 4) cats.add("short");
  else if (len <= 6) cats.add("medium");
  else cats.add("standard");

  // ── Pattern Rules ──
  // All numeric
  if (/^\d+$/.test(clean)) {
    cats.add("numeric");
  }

  // Repeating character (e.g. aaaa, xxxx)
  if (/^(.)\1+$/.test(clean)) {
    cats.add("repeating");
  }

  // Repeating pattern (e.g. abab, abcabc)
  if (/^(.{1,3})\1+$/.test(clean)) {
    cats.add("repeating");
  }

  // Palindrome
  if (clean === clean.split("").reverse().join("") && len >= 3) {
    cats.add("palindrome");
  }

  // Emoji
  if (/[\u{1F000}-\u{1FFFF}]/u.test(clean)) {
    cats.add("emoji_name");
  }

  // ── Chinese Number Analysis ──
  if (/^\d+$/.test(clean)) {
    const chineseAnalysis = analyzeChineseNumbers(clean);
    if (chineseAnalysis.luckyScore >= 15 || chineseAnalysis.luckyScore <= -15) {
      cats.add("chinese");
    }
  }

  // ── Dictionary Matching ──
  // Exact match
  if (KEYWORD_DICT[clean]) {
    for (const cat of KEYWORD_DICT[clean]) cats.add(cat);
  }

  // Chinese pinyin keywords should only match via fuzzy/substring if the username
  // is predominantly composed of pinyin segments (not random English words).
  // Strategy: exact match always, substring/prefix only if:
  //   1. The keyword covers >40% of the username length, OR
  //   2. The username is mostly digits + the keyword, OR
  //   3. Multiple Chinese keywords found in the same username

  const chineseHits: string[] = []; // track Chinese keyword matches for multi-hit validation

  // Substring match — check if username contains any keyword (3+ chars)
  for (const [keyword, categories] of Object.entries(KEYWORD_DICT)) {
    if (keyword.length < 3) continue;
    if (clean === keyword) {
      for (const cat of categories) cats.add(cat);
      if (categories.includes("chinese" as CategoryKey)) chineseHits.push(keyword);
    } else if (clean.includes(keyword)) {
      const isChinese = categories.includes("chinese" as CategoryKey);
      if (isChinese) {
        // Chinese keyword fuzzy matching: require significant coverage or digit-combo
        const coverage = keyword.length / len;
        const remainder = clean.replace(keyword, "");
        const remainderIsDigits = /^\d*$/.test(remainder);
        const remainderIsPinyin = Object.keys(KEYWORD_DICT).some(
          (k) => KEYWORD_DICT[k].includes("chinese" as CategoryKey) && remainder === k
        );
        if (coverage >= 0.6 || remainderIsDigits || remainderIsPinyin) {
          for (const cat of categories) cats.add(cat);
          chineseHits.push(keyword);
        } else {
          chineseHits.push(keyword); // track but don't add yet
        }
      } else {
        for (const cat of categories) cats.add(cat);
      }
    }
  }

  // Prefix/suffix match for 2-char keywords
  for (const [keyword, categories] of Object.entries(KEYWORD_DICT)) {
    if (keyword.length !== 2) continue;
    if (clean === keyword) {
      for (const cat of categories) cats.add(cat);
      if (categories.includes("chinese" as CategoryKey)) chineseHits.push(keyword);
    } else if (len <= 5) {
      const isChinese = categories.includes("chinese" as CategoryKey);
      if (clean.startsWith(keyword) || clean.endsWith(keyword)) {
        if (isChinese) {
          const remainder = clean.startsWith(keyword)
            ? clean.slice(keyword.length)
            : clean.slice(0, -keyword.length);
          const remainderIsDigits = /^\d*$/.test(remainder);
          if (remainderIsDigits || len <= 3) {
            for (const cat of categories) cats.add(cat);
            chineseHits.push(keyword);
          } else {
            chineseHits.push(keyword);
          }
        } else {
          for (const cat of categories) cats.add(cat);
        }
      }
    }
  }

  // If multiple Chinese keywords found → high confidence, add chinese category
  if (chineseHits.length >= 2 && !cats.has("chinese" as CategoryKey)) {
    cats.add("chinese" as CategoryKey);
  }

  // ── Brandability Check ──
  // Clean, pronounceable, no numbers = brandable
  if (/^[a-z]+$/.test(clean) && len >= 4 && len <= 8) {
    // Check if it has vowels (pronounceable)
    const vowelRatio = (clean.match(/[aeiou]/g) || []).length / len;
    if (vowelRatio >= 0.2 && vowelRatio <= 0.6) {
      cats.add("brandable");
    }
  }

  // ── Single dictionary word bonus ──
  if (/^[a-z]+$/.test(clean) && len >= 3 && len <= 10) {
    // Simple heuristic: if it's all letters and a reasonable length,
    // it's likely a word (proper dictionary check would need a wordlist)
    cats.add("single_word");
  }

  // If nothing matched beyond length, mark as other
  const nonLengthCats = Array.from(cats).filter(
    (c) => !["ultra_short", "short", "medium", "standard"].includes(c)
  );
  if (nonLengthCats.length === 0) {
    cats.add("other");
  }

  return Array.from(cats);
}

// ─── Main Categorize Function ────────────────────────────────────────

export interface CategorizedUsername {
  username: string;
  categories: CategoryKey[];
  labels: string[];
  primaryCategory: CategoryKey;
  confidence: "high" | "medium" | "low";
}

/**
 * Categorize a username using rules + dictionary.
 * Returns structured categories with labels and confidence.
 */
export function categorizeUsername(username: string): CategorizedUsername {
  const clean = `@${username.replace(/^@/, "").toLowerCase()}`;
  const categories = applyRules(clean);

  // Determine primary category (most specific non-length one)
  const priority: CategoryKey[] = [
    "ton_related",
    "crypto",
    "finance",
    "gaming",
    "tech",
    "social",
    "business",
    "media",
    "lifestyle",
    "meme",
    "country",
    "name",
    "premium",
    "brandable",
    "numeric",
    "repeating",
    "palindrome",
    "emoji_name",
    "single_word",
    "ultra_short",
    "short",
    "medium",
    "standard",
    "other",
  ];

  const primaryCategory = priority.find((p) => categories.includes(p)) || "other";

  // Labels for human readability
  const labels = categories.filter((c) => c in CATEGORIES).map((c) => CATEGORIES[c].label);

  // Confidence based on how many categories matched
  const nonLengthCats = categories.filter(
    (c) =>
      !["ultra_short", "short", "medium", "standard", "other", "single_word", "brandable"].includes(
        c
      )
  );
  const confidence: "high" | "medium" | "low" =
    nonLengthCats.length >= 2 ? "high" : nonLengthCats.length === 1 ? "medium" : "low";

  return {
    username: clean,
    categories,
    labels,
    primaryCategory,
    confidence,
  };
}

/**
 * Check if two usernames share categories (for matching).
 */
export function categoriesOverlap(
  cats1: CategoryKey[],
  cats2: CategoryKey[]
): { overlap: CategoryKey[]; score: number } {
  // Ignore length categories for matching — they're too broad
  const meaningful1 = cats1.filter(
    (c) => !["ultra_short", "short", "medium", "standard", "other", "single_word"].includes(c)
  );
  const meaningful2 = cats2.filter(
    (c) => !["ultra_short", "short", "medium", "standard", "other", "single_word"].includes(c)
  );

  const overlap = meaningful1.filter((c) => meaningful2.includes(c));
  const totalUnique = new Set([...meaningful1, ...meaningful2]).size;
  const score = totalUnique > 0 ? overlap.length / totalUnique : 0;

  return { overlap: overlap as CategoryKey[], score };
}

/**
 * Get all available category keys for user selection.
 */
export function getAvailableCategories(): Array<{ key: CategoryKey; label: string; desc: string }> {
  return Object.entries(CATEGORIES).map(([key, val]) => ({
    key: key as CategoryKey,
    label: val.label,
    desc: val.desc,
  }));
}
