# Changelog

## v1.0.0-beta.1 (2026-03-16)

### 🚀 Initial Beta Release

**Core:**
- 232 built-in tools across 17 categories
- Bot API mode (grammY) — no phone/userbot needed
- Multi-provider LLM support (15 providers)
- Tool RAG — smart tool selection per message
- Per-user memory & session management
- Plugin system with hot-reload
- MCP (Model Context Protocol) support

**OTC Matchmaker:**
- Username matchmaker (list/browse/express interest/sold)
- Gift matchmaker (rarity-aware, tier filtering)
- DM notifications for all parties (buyer, seller, sold alerts)
- Stale listing reminders (48h+)
- Auto-expire past due listings
- $TELECLAW token gate (0.1% supply required)

**Fragment:**
- Username search, valuation, sniper, whale tracker
- Gift rarity database (109 collections, 7K+ models)
- Gift appraisal, arbitrage, portfolio tracking
- Number market intelligence

**DeFi:**
- STON.fi & DeDust swap/quote
- TON wallet (W5R1), send/receive
- Agentic wallet with safety rules

**Setup:**
- Interactive wizard — BotFather token + API key, done in 5 minutes
- Admin claim code — `/start <code>` to become admin
- Per-user API key support — `/apikey <provider> <key>`
- `/update` command — self-update from npm

**Admin Commands:**
- 20+ commands: /status, /help, /reset, /settings, /wallet, /portfolio, /version, /update, etc.
- BotFather command menu registered automatically
