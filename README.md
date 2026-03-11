# 🦞 Teleclaw Agent

**AI Agent for Telegram & TON Blockchain**

Teleclaw is an autonomous AI agent that operates as a real Telegram user account (not a bot). It thinks, remembers, and acts — with native TON blockchain integration for payments, swaps, and more.

## Features

- **Real Telegram Account** — operates via MTProto (GramJS), full user-level access
- **Agentic Loop** — multi-step tool calling with reasoning
- **15 LLM Providers** — Anthropic, OpenAI, Google, xAI, Groq, and more
- **TON Blockchain** — built-in wallet, send/receive TON & jettons, DEX swaps (STON.fi + DeDust), NFTs, DNS
- **125+ Tools** — messaging, media, blockchain, trading, and more
- **Persistent Memory** — hybrid RAG with semantic search
- **Plugin SDK** — extend with custom tools
- **MCP Client** — connect external tool servers with YAML config
- **Web Dashboard** — manage settings, monitor activity

## Quick Start

```bash
# Install
npm install

# Build
npm run build

# Setup (interactive wizard)
teleclaw setup

# Start
teleclaw start
```

## Configuration

Setup wizard handles:
- LLM provider & API key
- Telegram authentication
- TON wallet generation
- Access policies

Config stored in `~/.teleclaw/`

## 100% Free & Open Source

All features are available to everyone — no paywalls, no token gates, no limits. Fork it, run it, make it yours.

## Community

- Telegram: [@teleclawonton](https://t.me/teleclawonton)

## License

MIT
