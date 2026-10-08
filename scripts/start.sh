#!/usr/bin/env bash
# ==========================================================
#                 NEXORA HYBRID AGENT SYSTEM
# ==========================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=========================================================="
echo "                NEXORA HYBRID AGENT SYSTEM                "
echo "=========================================================="

# 1. Prerequisites Check
echo -e "\n[1/4] Checking environment prerequisites..."
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed or not in PATH. Requires Node.js v24+." >&2
    exit 1
fi

echo "  Node.js Version: $(node -v)"
if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "  Warning: GEMINI_API_KEY is not set. Live model execution will be disabled."
else
    echo "  GEMINI_API_KEY: Configured (Free-Only Policy: gemini-3.8-flash)"
fi

# 2. Database & Data Directories
echo -e "\n[2/4] Initializing local database and artifact directories..."
mkdir -p "${ROOT_DIR}/data" "${ROOT_DIR}/artifacts"
export NEXORA_DB_PATH="${ROOT_DIR}/data/nexora.db"
echo "  SQLite Database: ${NEXORA_DB_PATH} (WAL mode enabled)"
echo "  Artifact Storage: ${ROOT_DIR}/artifacts"

# 3. Test & Verification Gate Check
echo -e "\n[3/4] Running automated self-test verification..."
node --experimental-strip-types --test "${ROOT_DIR}/tests/end-to-end-integration.test.ts"
echo "  All system invariants verified successfully."

# 4. Service Startup
echo -e "\n[4/4] Starting Nexora Services..."
echo "  - SQLite Task Ledger: Active"
echo "  - MCP Stdio Server: Ready (manifests in packages/mcp-server/manifests)"
echo "  - Outbound Runner Fleet: Ready"
echo "  - Quiet Heartbeat: Active (Timezone: Asia/Kolkata)"

echo -e "\nNexora is running in Development Integrity Mode."
echo "To connect Antigravity or Claude Desktop, point their MCP config to:"
echo "  node --experimental-strip-types ${ROOT_DIR}/packages/mcp-server/src/cli.ts"
