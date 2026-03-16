#!/usr/bin/env bash
set -euo pipefail

# Teleclaw Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/gioooton/teleclaw-agent/main/install.sh | bash

REPO="gioooton/teleclaw-agent"
DOCKER_IMAGE="ghcr.io/${REPO}:latest"
NPM_PACKAGE="teleclaw"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

install_npm() {
  echo ""
  echo -e "${BOLD}Installing via npm...${NC}"
  if command -v npm &>/dev/null; then
    npm install -g "${NPM_PACKAGE}"
    ok "Teleclaw installed via npm"
    echo ""
    echo "Next steps:"
    echo "  teleclaw setup    # Configure your agent"
    echo "  teleclaw start    # Start the agent"
    echo "  teleclaw doctor   # Run health checks"
  else
    err "npm not found. Install Node.js 18+ first."
    exit 1
  fi
}

install_docker() {
  echo ""
  echo -e "${BOLD}Installing via Docker...${NC}"
  if command -v docker &>/dev/null; then
    docker pull "${DOCKER_IMAGE}"
    ok "Teleclaw Docker image pulled"
    echo ""
    echo "Setup:"
    echo "  docker run -it -v ~/.teleclaw:/data ${DOCKER_IMAGE} setup"
    echo ""
    echo "Start:"
    echo "  docker run -d -v ~/.teleclaw:/data --name teleclaw ${DOCKER_IMAGE}"
    echo ""
    echo "Health check:"
    echo "  docker run -it -v ~/.teleclaw:/data ${DOCKER_IMAGE} doctor"
  else
    err "Docker not found."
    exit 1
  fi
}

install_binary() {
  local install_dir="${HOME}/.teleclaw-app"
  local bin_dir="${HOME}/.local/bin"
  local version="latest"

  echo ""
  echo -e "${BOLD}Installing standalone binary...${NC}"

  local os=$(uname -s | tr '[:upper:]' '[:lower:]')
  local arch=$(uname -m)
  [[ "$arch" == "x86_64" ]] && arch="amd64"
  [[ "$arch" == "aarch64" || "$arch" == "arm64" ]] && arch="arm64"

  local tarball="teleclaw-${os}-${arch}.tar.gz"
  local url="https://github.com/${REPO}/releases/${version}/download/${tarball}"

  mkdir -p "${install_dir}" "${bin_dir}"

  echo "Downloading ${url}..."
  curl -fsSL "${url}" | tar xz -C "${install_dir}"

  ln -sf "${install_dir}/bin/teleclaw.js" "${bin_dir}/teleclaw"

  if echo "$PATH" | grep -q "${bin_dir}"; then
    ok "Teleclaw installed to ${bin_dir}/teleclaw"
  else
    ok "Teleclaw installed to ${bin_dir}/teleclaw"
    warn "Add ${bin_dir} to your PATH:"
    echo "  export PATH=\"\$PATH:${bin_dir}\""
  fi

  echo ""
  echo "Next steps:"
  echo "  teleclaw setup    # Configure your agent"
  echo "  teleclaw start    # Start the agent"
}

# ── Main ──────────────────────────────────────────────────────────────
clear 2>/dev/null || true
echo ""
echo -e "${BOLD}  ╔═══════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║       Teleclaw Installer          ║${NC}"
echo -e "${BOLD}  ║   AI Agent for Telegram & TON     ║${NC}"
echo -e "${BOLD}  ╚═══════════════════════════════════╝${NC}"
echo ""

echo "Choose installation method:"
echo ""
echo "  1) npm (recommended)"
echo "  2) Docker"
echo "  3) Standalone binary"
echo ""

read -rp "Select [1-3]: " choice

case "${choice}" in
  1) install_npm ;;
  2) install_docker ;;
  3) install_binary ;;
  *) err "Invalid choice"; exit 1 ;;
esac

echo ""
ok "Done! 🚀"
