# 🦞 Teleclaw Agent

**Self-hosted AI agent for Telegram & TON Blockchain.**

Your own AI-powered Telegram bot with 150+ built-in tools for crypto trading, NFT/gift management, DeFi, Fragment username flipping, and more.

## Quick Start

```bash
npm install -g teleclaw
teleclaw setup
teleclaw start
```

That's it. Setup asks for your BotFather token and AI provider key, then you're live.

## What It Does

Teleclaw is a personal AI agent that runs as your Telegram bot. Users chat with it naturally, and it uses tools to:

- **🔍 Fragment** — Snipe undervalued usernames, track market trends, OTC matchmaker
- **🎁 Gifts** — Rarity analysis, price comparison, portfolio valuation, marketplace aggregator  
- **💰 TON** — Wallet management, transfers, balance checks
- **📊 DeFi** — STON.fi & DeDust swaps, pool analytics, trending tokens
- **🐋 Whale Watcher** — Track large wallet movements
- **📡 Alpha Radar** — Monitor channels for early signals
- **🤖 Agentic Wallet** — Autonomous trading with safety rules
- **🔗 OTC Matchmaker** — Connect buyers & sellers (username + gift trading)
- **🌐 Web** — Search and fetch web content
- **📝 Memory** — Per-user memory, session management
- **🔌 Custom Skills** — Add your own tools with hot-reload

## Features

### Multi-Model Support
Choose your AI provider: Claude, GPT, Gemini, local models (Ollama), or bring your own.

### Skill System
Extend Teleclaw with custom skills:

```bash
teleclaw skill create my-tool    # generates template
teleclaw skill list              # see installed skills
teleclaw skill remove my-tool    # safe delete
```

Skills are JavaScript plugins in `~/.teleclaw/plugins/` with hot-reload.

### Tool RAG
With 150+ tools, Teleclaw uses semantic search to pick the right tools for each message. No manual tool selection needed.

### Privacy
- Self-hosted: your data stays on your machine
- Per-user memory: each user's conversations are private
- No data sent anywhere except your chosen AI provider

## Configuration

Config lives at `~/.teleclaw/config.yaml`. Key settings:

```yaml
telegram:
  mode: bot              # Bot API mode
  bot_token: "..."       # from @BotFather

agent:
  provider: anthropic    # claude, openai, google, local, etc.
  model: claude-sonnet-4-20250514  # or any model you prefer
  api_key: "..."         # your provider API key
```

Use `/addprovider` to configure AI providers and `/models` to switch between them.

## Commands

```bash
teleclaw setup          # interactive setup wizard
teleclaw start          # start the agent
teleclaw doctor         # diagnose issues
teleclaw skill create   # create a custom skill
teleclaw skill list     # list installed skills
teleclaw config set     # update config values
teleclaw mcp add        # add MCP server
```

## Requirements

- Node.js 20+
- A Telegram bot token (free from @BotFather)
- An AI provider API key (Claude, GPT, Gemini, etc.)

## Architecture

```
User → Telegram Bot API → Teleclaw Agent → AI Provider
                              ↓
                    Tool Registry (150+ tools)
                    ├── Fragment (usernames, gifts)
                    ├── TON (wallet, transfers)
                    ├── DeFi (STON.fi, DeDust)
                    ├── Marketplace (aggregator)
                    ├── Memory (per-user)
                    └── Custom Skills (plugins/)
```

## $TELECLAW Token Gate

OTC Matchmaker features require holding 0.1% of $TELECLAW supply. This keeps the marketplace quality high and spam-free.

## Links

- **GitHub:** https://github.com/teleclawagent/teleclaw-agent
- **Telegram:** @ton_cabal
- **X:** @teleclawonton

## License

MIT
