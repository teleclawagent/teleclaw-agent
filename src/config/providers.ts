export type SupportedProvider =
  | "anthropic"
  | "claude-code"
  | "openai"
  | "openai-codex"
  | "google"
  | "xai"
  | "groq"
  | "openrouter"
  | "moonshot"
  | "mistral"
  | "cerebras"
  | "zai"
  | "minimax"
  | "huggingface"
  | "cocoon"
  | "local"
  | "deepseek"
  | "together"
  | "venice"
  | "litellm"
  | "qwen"
  | "volcengine"
  | "byteplus"
  | "cloudflare-ai"
  | "copilot"
  | "chutes"
  | "kilo"
  | "qianfan"
  | "modelstudio"
  | "vercel-ai"
  | "opencode"
  | "xiaomi"
  | "synthetic"
  | "custom";

export interface ProviderMetadata {
  id: SupportedProvider;
  displayName: string;
  envVar: string;
  keyPrefix: string | null;
  keyHint: string;
  consoleUrl: string;
  defaultModel: string;
  utilityModel: string;
  toolLimit: number | null;
  piAiProvider: string;
}

const PROVIDER_REGISTRY: Record<SupportedProvider, ProviderMetadata> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic (Claude)",
    envVar: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    keyHint: "sk-ant-api03-... or setup-token",
    consoleUrl: "https://console.anthropic.com/",
    defaultModel: "claude-opus-4-6",
    utilityModel: "claude-haiku-4-5-20251001",
    toolLimit: null,
    piAiProvider: "anthropic",
  },
  // claude-code kept for backward compat (existing configs) — maps to anthropic
  "claude-code": {
    id: "claude-code",
    displayName: "Anthropic (Claude)", // hidden from setup UI
    envVar: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    keyHint: "sk-ant-api03-...",
    consoleUrl: "https://console.anthropic.com/",
    defaultModel: "claude-opus-4-6",
    utilityModel: "claude-haiku-4-5-20251001",
    toolLimit: null,
    piAiProvider: "anthropic",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI (GPT-5.4)",
    envVar: "OPENAI_API_KEY",
    keyPrefix: "sk-",
    keyHint: "sk-proj-...",
    consoleUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.4",
    utilityModel: "gpt-4o-mini",
    toolLimit: null,
    piAiProvider: "openai",
  },
  // openai-codex: ChatGPT subscription via Codex CLI OAuth
  // Uses chatgpt.com/backend-api (openai-codex-responses API in pi-ai)
  "openai-codex": {
    id: "openai-codex",
    displayName: "ChatGPT Subscription",
    envVar: "OPENAI_API_KEY",
    keyPrefix: null,
    keyHint: "Auto-detected from Codex CLI",
    consoleUrl: "https://platform.openai.com/",
    defaultModel: "gpt-5.4",
    utilityModel: "gpt-5.1-codex-mini",
    toolLimit: null,
    piAiProvider: "openai-codex",
  },
  google: {
    id: "google",
    displayName: "Google (Gemini)",
    envVar: "GOOGLE_API_KEY",
    keyPrefix: null,
    keyHint: "AIza...",
    consoleUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-flash",
    utilityModel: "gemini-2.0-flash-lite",
    toolLimit: null,
    piAiProvider: "google",
  },
  xai: {
    id: "xai",
    displayName: "xAI (Grok)",
    envVar: "XAI_API_KEY",
    keyPrefix: "xai-",
    keyHint: "xai-...",
    consoleUrl: "https://console.x.ai/",
    defaultModel: "grok-3",
    utilityModel: "grok-3-mini-fast",
    toolLimit: null,
    piAiProvider: "xai",
  },
  groq: {
    id: "groq",
    displayName: "Groq",
    envVar: "GROQ_API_KEY",
    keyPrefix: "gsk_",
    keyHint: "gsk_...",
    consoleUrl: "https://console.groq.com/keys",
    defaultModel: "llama-3.3-70b-versatile",
    utilityModel: "llama-3.1-8b-instant",
    toolLimit: null,
    piAiProvider: "groq",
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    keyPrefix: "sk-or-",
    keyHint: "sk-or-v1-...",
    consoleUrl: "https://openrouter.ai/keys",
    defaultModel: "anthropic/claude-opus-4.5",
    utilityModel: "google/gemini-2.5-flash-lite",
    toolLimit: null,
    piAiProvider: "openrouter",
  },
  moonshot: {
    id: "moonshot",
    displayName: "Moonshot (Kimi K2.5)",
    envVar: "MOONSHOT_API_KEY",
    keyPrefix: "sk-",
    keyHint: "sk-...",
    consoleUrl: "https://platform.moonshot.ai/",
    defaultModel: "k2p5",
    utilityModel: "k2p5",
    toolLimit: null,
    piAiProvider: "kimi-coding",
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral AI",
    envVar: "MISTRAL_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "devstral-small-2507",
    utilityModel: "ministral-8b-latest",
    toolLimit: null,
    piAiProvider: "mistral",
  },
  cerebras: {
    id: "cerebras",
    displayName: "Cerebras",
    envVar: "CEREBRAS_API_KEY",
    keyPrefix: "csk-",
    keyHint: "csk-...",
    consoleUrl: "https://cloud.cerebras.ai/",
    defaultModel: "qwen-3-235b-a22b-instruct-2507",
    utilityModel: "llama3.1-8b",
    toolLimit: null,
    piAiProvider: "cerebras",
  },
  zai: {
    id: "zai",
    displayName: "ZAI (Zhipu)",
    envVar: "ZAI_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultModel: "glm-4.7",
    utilityModel: "glm-4.7-flash",
    toolLimit: null,
    piAiProvider: "zai",
  },
  minimax: {
    id: "minimax",
    displayName: "MiniMax",
    envVar: "MINIMAX_API_KEY",
    keyPrefix: null,
    keyHint: "Save your key — shown only once!",
    consoleUrl: "https://platform.minimax.io/",
    defaultModel: "MiniMax-M2.5",
    utilityModel: "MiniMax-M2",
    toolLimit: null,
    piAiProvider: "minimax",
  },
  huggingface: {
    id: "huggingface",
    displayName: "HuggingFace",
    envVar: "HF_TOKEN",
    keyPrefix: "hf_",
    keyHint: "hf_...",
    consoleUrl: "https://huggingface.co/settings/tokens",
    defaultModel: "deepseek-ai/DeepSeek-V3.2",
    utilityModel: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    toolLimit: null,
    piAiProvider: "huggingface",
  },
  cocoon: {
    id: "cocoon",
    displayName: "Cocoon Network (Decentralized)",
    envVar: "",
    keyPrefix: null,
    keyHint: "No API key needed — pays in TON",
    consoleUrl: "https://cocoon.network",
    defaultModel: "Qwen/Qwen3-32B",
    utilityModel: "Qwen/Qwen3-32B",
    toolLimit: null,
    piAiProvider: "cocoon",
  },
  local: {
    id: "local",
    displayName: "Local (Ollama, vLLM, LM Studio...)",
    envVar: "",
    keyPrefix: null,
    keyHint: "No API key needed",
    consoleUrl: "",
    defaultModel: "auto",
    utilityModel: "auto",
    toolLimit: null,
    piAiProvider: "local",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    keyPrefix: "sk-",
    keyHint: "sk-...",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    utilityModel: "deepseek-chat",
    toolLimit: null,
    piAiProvider: "deepseek",
  },
  together: {
    id: "together",
    displayName: "Together AI",
    envVar: "TOGETHER_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://api.together.xyz/settings/api-keys",
    defaultModel: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    utilityModel: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
    toolLimit: null,
    piAiProvider: "together",
  },
  venice: {
    id: "venice",
    displayName: "Venice AI",
    envVar: "VENICE_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://venice.ai/settings/api",
    defaultModel: "deepseek-r1-671b",
    utilityModel: "llama-3.3-70b",
    toolLimit: null,
    piAiProvider: "venice",
  },
  litellm: {
    id: "litellm",
    displayName: "LiteLLM Gateway",
    envVar: "LITELLM_API_KEY",
    keyPrefix: null,
    keyHint: "No API key needed",
    consoleUrl: "https://docs.litellm.ai/",
    defaultModel: "gpt-4o",
    utilityModel: "gpt-4o-mini",
    toolLimit: null,
    piAiProvider: "litellm",
  },
  qwen: {
    id: "qwen",
    displayName: "Qwen (Alibaba)",
    envVar: "DASHSCOPE_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://bailian.console.alibabacloud.com/",
    defaultModel: "qwen3-235b-a22b",
    utilityModel: "qwen3-30b-a3b",
    toolLimit: null,
    piAiProvider: "qwen",
  },
  volcengine: {
    id: "volcengine",
    displayName: "Volcano Engine",
    envVar: "VOLCENGINE_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://console.volcengine.com/",
    defaultModel: "deepseek-r1-250528",
    utilityModel: "deepseek-v3-250324",
    toolLimit: null,
    piAiProvider: "volcengine",
  },
  byteplus: {
    id: "byteplus",
    displayName: "BytePlus",
    envVar: "BYTEPLUS_API_KEY",
    keyPrefix: null,
    keyHint: "...",
    consoleUrl: "https://console.byteplus.com/",
    defaultModel: "deepseek-r1-250528",
    utilityModel: "deepseek-v3-250324",
    toolLimit: null,
    piAiProvider: "byteplus",
  },
  "cloudflare-ai": {
    id: "cloudflare-ai",
    displayName: "Cloudflare AI Gateway",
    envVar: "CF_AI_GATEWAY_API_KEY",
    keyPrefix: null,
    keyHint: "No API key needed",
    consoleUrl: "https://dash.cloudflare.com/",
    defaultModel: "workers-ai",
    utilityModel: "workers-ai",
    toolLimit: null,
    piAiProvider: "cloudflare-ai",
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot",
    envVar: "",
    keyPrefix: null,
    keyHint: "No API key needed — uses GitHub device login",
    consoleUrl: "https://github.com/settings/copilot",
    defaultModel: "claude-sonnet-4-6",
    utilityModel: "gpt-4o-mini",
    toolLimit: null,
    piAiProvider: "copilot",
  },
  chutes: {
    id: "chutes",
    displayName: "Chutes",
    envVar: "",
    keyPrefix: null,
    keyHint: "No API key needed — OAuth login",
    consoleUrl: "https://chutes.ai",
    defaultModel: "chutes-default",
    utilityModel: "chutes-default",
    toolLimit: null,
    piAiProvider: "chutes",
  },
  kilo: {
    id: "kilo",
    displayName: "Kilo Gateway",
    envVar: "KILO_API_KEY",
    keyPrefix: null,
    keyHint: "API key from Kilo",
    consoleUrl: "https://kilo.health",
    defaultModel: "anthropic/claude-opus-4.5",
    utilityModel: "google/gemini-2.5-flash-lite",
    toolLimit: null,
    piAiProvider: "openrouter",
  },
  qianfan: {
    id: "qianfan",
    displayName: "Qianfan (Baidu)",
    envVar: "QIANFAN_API_KEY",
    keyPrefix: null,
    keyHint: "API key",
    consoleUrl: "https://console.bce.baidu.com/qianfan/",
    defaultModel: "ernie-4.5-8k",
    utilityModel: "ernie-4.5-8k",
    toolLimit: null,
    piAiProvider: "qianfan",
  },
  modelstudio: {
    id: "modelstudio",
    displayName: "Alibaba Cloud Model Studio",
    envVar: "MODELSTUDIO_API_KEY",
    keyPrefix: null,
    keyHint: "API key",
    consoleUrl: "https://bailian.console.alibabacloud.com/",
    defaultModel: "qwen3-235b-a22b",
    utilityModel: "qwen3-30b-a3b",
    toolLimit: null,
    piAiProvider: "modelstudio",
  },
  "vercel-ai": {
    id: "vercel-ai",
    displayName: "Vercel AI Gateway",
    envVar: "VERCEL_AI_API_KEY",
    keyPrefix: null,
    keyHint: "API key",
    consoleUrl: "https://sdk.vercel.ai/",
    defaultModel: "anthropic/claude-sonnet-4-6",
    utilityModel: "anthropic/claude-haiku-4-5",
    toolLimit: null,
    piAiProvider: "vercel-ai",
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    envVar: "OPENCODE_API_KEY",
    keyPrefix: null,
    keyHint: "Shared API key from opencode.ai",
    consoleUrl: "https://opencode.ai",
    defaultModel: "claude-sonnet-4-6",
    utilityModel: "gpt-4o-mini",
    toolLimit: null,
    piAiProvider: "opencode",
  },
  xiaomi: {
    id: "xiaomi",
    displayName: "Xiaomi",
    envVar: "XIAOMI_API_KEY",
    keyPrefix: null,
    keyHint: "API key",
    consoleUrl: "https://xiaoai.mi.com/",
    defaultModel: "xiaomi-default",
    utilityModel: "xiaomi-default",
    toolLimit: null,
    piAiProvider: "xiaomi",
  },
  synthetic: {
    id: "synthetic",
    displayName: "Synthetic",
    envVar: "SYNTHETIC_API_KEY",
    keyPrefix: null,
    keyHint: "API key",
    consoleUrl: "https://synthetic.computer",
    defaultModel: "claude-sonnet-4-6",
    utilityModel: "claude-haiku-4-5",
    toolLimit: null,
    piAiProvider: "anthropic",
  },
  custom: {
    id: "custom",
    displayName: "Custom Provider",
    envVar: "CUSTOM_API_KEY",
    keyPrefix: null,
    keyHint: "Your API key",
    consoleUrl: "",
    defaultModel: "custom",
    utilityModel: "custom",
    toolLimit: null,
    piAiProvider: "openai",
  },
};

export function getProviderMetadata(provider: SupportedProvider): ProviderMetadata {
  const meta = PROVIDER_REGISTRY[provider];
  if (!meta) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return meta;
}

/** Hidden providers kept for backward compat only (existing configs still work) */
const HIDDEN_PROVIDERS = new Set(["claude-code", "openai-codex"]);

/** Get providers visible in setup UIs (excludes deprecated auto-detect providers) */
export function getSupportedProviders(): ProviderMetadata[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => !HIDDEN_PROVIDERS.has(p.id));
}

/** Get ALL providers including hidden ones (for config loading backward compat) */
export function getAllProviders(): ProviderMetadata[] {
  return Object.values(PROVIDER_REGISTRY);
}

export function validateApiKeyFormat(provider: SupportedProvider, key: string): string | undefined {
  const meta = PROVIDER_REGISTRY[provider];
  if (!meta) return `Unknown provider: ${provider}`;
  if (
    provider === "cocoon" ||
    provider === "local" ||
    provider === "claude-code" ||
    provider === "openai-codex" ||
    provider === "copilot" ||
    provider === "litellm" ||
    provider === "cloudflare-ai" ||
    provider === "chutes" ||
    provider === "custom"
  )
    return undefined; // No API key needed (auto-detects or device login)
  if (!key || key.trim().length === 0) return "API key is required";
  if (meta.keyPrefix && !key.startsWith(meta.keyPrefix)) {
    return `Invalid format (should start with ${meta.keyPrefix})`;
  }
  return undefined;
}

export { PROVIDER_REGISTRY };
