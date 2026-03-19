# Teleclaw — One-click install (Windows PowerShell)
#
# Kullanım — PowerShell'e yapıştır:
#   irm https://raw.githubusercontent.com/gioooton/teleclaw-agent/main/scripts/install.ps1 | iex
#
# Veya dosyayı indirip çalıştır:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#   .\install.ps1

$ErrorActionPreference = "Stop"

function Write-Info  { Write-Host "  -> $args" -ForegroundColor Cyan }
function Write-OK    { Write-Host "  v  $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "  !  $args" -ForegroundColor Yellow }
function Write-Fail  { Write-Host "  x  $args" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Teleclaw Agent" -ForegroundColor Cyan -NoNewline
Write-Host " — AI Agent for Telegram & TON"
Write-Host ""

# ── Node.js ──────────────────────────────────────────────────────────────────

try { $nv = node --version 2>&1 } catch { Write-Fail "Node.js bulunamadi. https://nodejs.org (v20+)" }
$major = [int]($nv -replace 'v(\d+)\..*','$1')
if ($major -lt 20) { Write-Fail "Node.js v20+ gerekli (mevcut: $nv). https://nodejs.org" }
Write-OK "Node.js $nv"

# ── npm ───────────────────────────────────────────────────────────────────────

try { $npmv = npm --version 2>&1 } catch { Write-Fail "npm bulunamadi. Node.js'i yeniden kur." }
Write-OK "npm $npmv"

# ── Install ───────────────────────────────────────────────────────────────────

Write-Info "Teleclaw kuruluyor..."
npm install -g teleclaw --loglevel=error
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install basarisiz" }

try { $tc = Get-Command teleclaw -ErrorAction Stop }
catch { Write-Fail "teleclaw komutu bulunamadi. Kontrol: npm config get prefix" }
Write-OK "Teleclaw kuruldu: $($tc.Source)"

# ── Encryption secret ─────────────────────────────────────────────────────────

$TDir    = "$env:USERPROFILE\.teleclaw"
$EnvFile = "$TDir\.env.ps1"

if (-not (Test-Path $TDir)) { New-Item -ItemType Directory -Path $TDir -Force | Out-Null }

if ((Test-Path $EnvFile) -and (Select-String -Path $EnvFile -Pattern "TELECLAW_ENCRYPT_SECRET" -Quiet)) {
  Write-Warn "Mevcut encryption secret korunuyor: $EnvFile"
} else {
  Write-Info "Encryption secret olusturuluyor..."
  $Secret = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
  $Date   = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
  @"
# Teleclaw encryption secret — paylasma
# $Date
`$env:TELECLAW_ENCRYPT_SECRET = '$Secret'
"@ | Set-Content -Path $EnvFile -Encoding UTF8
  Write-OK "Secret kaydedildi: $EnvFile"
}

# PowerShell profile'a loader ekle
$Loader = ". `"$EnvFile`""
if (-not (Test-Path $PROFILE.CurrentUserAllHosts)) {
  New-Item -ItemType File -Path $PROFILE.CurrentUserAllHosts -Force | Out-Null
}
$ProfileContent = Get-Content $PROFILE.CurrentUserAllHosts -Raw -ErrorAction SilentlyContinue
if (-not ($ProfileContent -match "TELECLAW_ENCRYPT_SECRET")) {
  Add-Content -Path $PROFILE.CurrentUserAllHosts -Value "`n# Teleclaw`n$Loader"
  Write-OK "Loader eklendi: $($PROFILE.CurrentUserAllHosts)"
}

# Bu session icin yukle
. $EnvFile

# ── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Teleclaw kuruldu!" -ForegroundColor Green
Write-Host ""
Write-Host "  Simdi setup wizard'i calistir:" -ForegroundColor White
Write-Host ""
Write-Host "    teleclaw setup" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Gerekecekler:"
Write-Host "    * Telegram Bot Token (@BotFather'dan)"
Write-Host "    * AI provider ve API key (Anthropic, OpenAI vb.)"
Write-Host "    * TON cuzdani (yeni olustur veya seed phrase ile import et)"
Write-Host ""

if ([Environment]::UserInteractive) {
  Write-Host "  Setup basliyor..." -ForegroundColor White
  Start-Sleep -Seconds 1
  teleclaw setup
}
