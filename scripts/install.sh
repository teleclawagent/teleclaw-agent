#!/usr/bin/env bash
# Teleclaw — One-click install (Linux & macOS)
#
# Kullanım — terminale yapıştır:
#   curl -fsSL https://raw.githubusercontent.com/gioooton/teleclaw-agent/main/scripts/install.sh | bash

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}  →${RESET} $*"; }
ok()      { echo -e "${GREEN}  ✔${RESET} $*"; }
warn()    { echo -e "${YELLOW}  ⚠${RESET} $*"; }
fail()    { echo -e "${RED}  ✗${RESET} $*" >&2; exit 1; }

echo ""
echo -e "${BOLD}${CYAN}  🦞 Teleclaw Agent${RESET} — AI Agent for Telegram & TON"
echo ""

# ── Node.js ──────────────────────────────────────────────────────────────────

command -v node &>/dev/null || fail "Node.js bulunamadı. https://nodejs.org adresinden v20+ kur."

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js v20+ gerekli (mevcut: v$(node --version)). Güncelle: https://nodejs.org"
ok "Node.js $(node --version)"

# ── npm ───────────────────────────────────────────────────────────────────────

command -v npm &>/dev/null || fail "npm bulunamadı. Node.js'i yeniden kur."
ok "npm $(npm --version)"

# ── Install ───────────────────────────────────────────────────────────────────

info "Teleclaw kuruluyor..."
npm install -g teleclaw --loglevel=error || fail "npm install başarısız"

command -v teleclaw &>/dev/null || fail "teleclaw komutu bulunamadı. Kontrol et: npm config get prefix"
ok "Teleclaw kuruldu: $(teleclaw --version 2>/dev/null || echo 'ok')"

# ── Encryption secret ─────────────────────────────────────────────────────────

TDIR="$HOME/.teleclaw"
ENV_FILE="$TDIR/.env"
mkdir -p "$TDIR"

if [ -f "$ENV_FILE" ] && grep -q "TELECLAW_ENCRYPT_SECRET" "$ENV_FILE" 2>/dev/null; then
  warn "Mevcut encryption secret korunuyor: $ENV_FILE"
else
  info "Encryption secret oluşturuluyor..."
  SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  printf "# Teleclaw encryption secret — paylaşma\n# %s\nexport TELECLAW_ENCRYPT_SECRET=%s\n" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SECRET" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Secret kaydedildi: $ENV_FILE"
fi

# Shell rc'ye loader ekle
LOADER="[ -f \"$ENV_FILE\" ] && source \"$ENV_FILE\""
for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  if [ -f "$RC" ] && ! grep -q "TELECLAW_ENCRYPT_SECRET" "$RC" 2>/dev/null; then
    printf "\n# Teleclaw\n%s\n" "$LOADER" >> "$RC"
    ok "Loader eklendi: $RC"
    break
  fi
done

# Bu session için yükle
# shellcheck source=/dev/null
source "$ENV_FILE"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}  ✔ Teleclaw kuruldu!${RESET}"
echo ""
echo -e "  Şimdi setup wizard'ı çalıştır:"
echo ""
echo -e "    ${CYAN}teleclaw setup${RESET}"
echo ""
echo -e "  Gerekecekler:"
echo -e "    • Telegram Bot Token (@BotFather'dan)"
echo -e "    • AI provider ve API key (Anthropic, OpenAI vb.)"
echo -e "    • TON cüzdanı (yeni oluştur veya seed phrase ile import et)"
echo ""

# Eğer interaktif terminaldeyse setup'ı başlat
if [ -t 0 ]; then
  echo -e "  ${BOLD}Setup başlıyor...${RESET}"
  sleep 1
  teleclaw setup
fi
