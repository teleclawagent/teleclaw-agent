#!/bin/bash
set -e

echo ""
echo "⚡ Teleclaw Agent — Personal AI for Telegram"
echo "============================================="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js is required but not installed."
  echo ""
  echo "   Install it from: https://nodejs.org (v18+)"
  echo "   Or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js v18+ required (you have v$NODE_VERSION)"
  exit 1
fi

echo "✅ Node.js $(node -v) detected"
echo ""

# Install Teleclaw
echo "📦 Installing Teleclaw..."
npm install -g teleclaw@beta 2>&1 | grep -E "added|up to date|ERR" || true
echo ""

# Verify
if ! command -v teleclaw &>/dev/null; then
  echo "❌ Installation failed. Try manually: npm install -g teleclaw@beta"
  exit 1
fi

echo "✅ Teleclaw installed successfully!"
echo ""

# Launch setup + start
teleclaw
