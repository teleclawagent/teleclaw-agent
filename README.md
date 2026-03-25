<p align="center">
  <img src="https://teleclaw.meme/lobster-sm.jpg" width="80" alt="Teleclaw" />
</p>

<h1 align="center">Teleclaw Agent</h1>

<p align="center">
  <strong>Self-hosted AI agent for Telegram & TON.</strong><br>
  150+ tools. Natural language. Your keys stay yours.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/teleclaw"><img src="https://img.shields.io/npm/v/teleclaw" alt="npm" /></a>
  <a href="https://github.com/teleclawagent/teleclaw-agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" /></a>
  <a href="https://t.me/teleclawtg"><img src="https://img.shields.io/badge/Telegram-Channel-blue?logo=telegram" alt="Telegram" /></a>
</p>

---

## Quick Start

```bash
npm install -g teleclaw
teleclaw setup
teleclaw start
```

Setup walks you through bot token, AI provider, and wallet — you're live in under 2 minutes.

## What Is This?

Teleclaw is a personal AI agent that runs as your Telegram bot. You chat with it in plain text, and it uses 150+ built-in tools to handle everything on TON.

**Named by Durov** — Pavel Durov [demoed a bot called TeleClaw](https://x.com/durov/status/2028455440862830970) when announcing real-time streaming for Telegram bots.

## Features

| Category | What It Does |
|----------|-------------|
| **Fragment** | Username sniping, whale tracking, valuation engine, market analytics |
| **OTC Marketplace** | Cross-bot P2P trading for usernames, gifts, and +888 numbers |
| **Gifts** | Rarity analysis, price comparison, portfolio valuation, marketplace aggregator |
| **DeFi** | STON.fi & DeDust swaps, pool analytics, trending tokens |
| **Agentic Wallet** | TON wallet with transfers, safety rules, and PIN protection |
| **Whale Watcher** | Track large wallet movements in real-time |
| **Alpha Radar** | Monitor channels for early signals |
| **Multi-Model AI** | Claude, GPT, Gemini, Grok, DeepSeek, Mistral, local models — 30+ providers |
| **Memory** | Per-user conversations, persistent context across sessions |
| **Plugin System** | Build custom tools with hot-reload SDK |

## Configuration

```yaml
# ~/.teleclaw/config.yaml
telegram:
  bot_token: "your-bot-token"    # from @BotFather
  admin_ids: [123456789]

agent:
  provider: anthropic            # or openai, google, xai, groq, local...
  api_key: "your-api-key"
  model: claude-sonnet-4-20250514

wallet:
  mnemonic: "your 24 words"      # optional — enables TON features
```

## Self-Service Commands

Users can configure their own AI provider without touching config files:

| Command | What It Does |
|---------|-------------|
| `/addprovider` | Set up AI provider with inline buttons (supports ChatGPT & Claude subscriptions) |
| `/models` | Switch between providers and models mid-conversation |
| `/removeprovider` | Clear custom provider settings |
| `/otc` | OTC marketplace info and how-to |

## Docker

```bash
docker run -d \
  -v teleclaw-data:/data \
  -e BOT_TOKEN=your_token \
  -e AI_PROVIDER=anthropic \
  -e AI_API_KEY=sk-ant-... \
  teleclaw/agent:latest
```

## CLI

```bash
teleclaw setup          # Interactive setup wizard
teleclaw start          # Start the agent
teleclaw doctor         # Diagnose issues
teleclaw skill create   # Create a custom tool
teleclaw skill list     # List installed tools
teleclaw config set     # Update config values
teleclaw mcp add        # Add MCP server
```

## Architecture

```
User ──→ Telegram Bot API ──→ Teleclaw Agent ──→ AI Provider
                                    │
                          Tool Registry (150+)
                          ├── Fragment (70+ tools)
                          ├── DeFi (swaps, pools)
                          ├── Agentic Wallet
                          ├── OTC Marketplace
                          ├── Memory & Sessions
                          └── Custom Plugins
```

## $TELECLAW

| | |
|---|---|
| **Token** | TELECLAW 🦞 |
| **Chain** | TON |
| **DEX** | [DeDust](https://dedust.io/swap/TON/EQD01TwE1plYpYKvRwWOLwAzzAJaDKwpB2bR3nfg-wkJJwks) |
| **Chart** | [DexScreener](https://dexscreener.com/ton/eqbrw_hvpwp3yeikerhvawc9o-4hda_q5gb9x1qslhlkt5g_) |
| **Utility** | OTC Marketplace access (0.1% supply gate) |

```
CA: EQD01TwE1plYpYKvRwWOLwAzzAJaDKwpB2bR3nfg-wkJJwks
```

## Requirements

- Node.js 20+
- Telegram bot token (free from [@BotFather](https://t.me/BotFather))
- AI provider API key

## Contributing

PRs welcome. Please target the `dev` branch.

```bash
git clone https://github.com/teleclawagent/teleclaw-agent.git
cd teleclaw-agent
npm install
npm run typecheck
npm test
```

## Links

- **GitHub:** [teleclawagent/teleclaw-agent](https://github.com/teleclawagent/teleclaw-agent)
- **npm:** [teleclaw](https://www.npmjs.com/package/teleclaw)
- **Telegram:** [@teleclawtg](https://t.me/teleclawtg) · [@teleclawonton](https://t.me/teleclawonton)
- **X:** [@Teleclawonton](https://x.com/Teleclawonton)

## License

[MIT](LICENSE)
