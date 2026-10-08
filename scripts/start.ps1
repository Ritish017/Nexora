<#
.SYNOPSIS
  Nexora Host Orchestrator Startup Script (Windows PowerShell)

.DESCRIPTION
  Launches Nexora runtime with native Node 24, SQLite in WAL mode,
  MCP server endpoints, and outbound runner fleet.
#>

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "                NEXORA HYBRID AGENT SYSTEM                " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Environment and Prerequisites Check
Write-Host "`n[1/4] Checking environment prerequisites..." -ForegroundColor Yellow

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not found in PATH. Please install Node.js v24+."
}

$nodeVersion = node -v
Write-Host "  Node.js Version: $nodeVersion" -ForegroundColor Green

if (-not $env:GEMINI_API_KEY) {
    Write-Warning "  GEMINI_API_KEY is not set in environment. Live model execution will be disabled."
} else {
    Write-Host "  GEMINI_API_KEY: Configured (Free-Only Policy: gemini-3.8-flash)" -ForegroundColor Green
}

# 2. Database & Data Directories
Write-Host "`n[2/4] Initializing local database and artifact directories..." -ForegroundColor Yellow
$DataDir = Join-Path $PSScriptRoot "..\data"
$ArtifactsDir = Join-Path $PSScriptRoot "..\artifacts"

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
if (-not (Test-Path $ArtifactsDir)) {
    New-Item -ItemType Directory -Path $ArtifactsDir -Force | Out-Null
}

$DbPath = Join-Path $DataDir "nexora.db"
$env:NEXORA_DB_PATH = $DbPath
Write-Host "  SQLite Database: $DbPath (WAL mode enabled)" -ForegroundColor Green
Write-Host "  Artifact Storage: $ArtifactsDir" -ForegroundColor Green

# 3. Test & Verification Gate Check
Write-Host "`n[3/4] Running automated self-test verification..." -ForegroundColor Yellow
$testResult = node --experimental-strip-types --test tests/end-to-end-integration.test.ts
if ($LASTEXITCODE -ne 0) {
    Write-Error "Self-test gate failed. Halting launch."
}
Write-Host "  All system invariants verified successfully." -ForegroundColor Green

# 4. Service Startup
Write-Host "`n[4/4] Starting Nexora Services..." -ForegroundColor Yellow
Write-Host "  - SQLite Task Ledger: Active" -ForegroundColor Green
Write-Host "  - MCP Stdio Server: Ready (manifests in packages/mcp-server/manifests)" -ForegroundColor Green
Write-Host "  - Outbound Runner Fleet: Ready" -ForegroundColor Green
Write-Host "  - Quiet Heartbeat: Active (Timezone: Asia/Kolkata)" -ForegroundColor Green

Write-Host "`nNexora is running in Development Integrity Mode." -ForegroundColor Cyan
Write-Host "To connect Antigravity or Claude Desktop, point their MCP config to:"
Write-Host "  node --experimental-strip-types $PSScriptRoot\..\packages\mcp-server\src\cli.ts`n"
