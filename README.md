# Nexora

> **The Sovereign, Governed Hybrid Personal Agent Operating System.**

Nexora is an open-source, resilient, self-governing personal agent architecture. It combines **Perry** (durable SQLite task ledger, opaque engine cursors, monotonic events), **OpenDots** (revision-checked document canvas, space profiles), and **OpenBot** (governed container computers, cryptographic HMAC credentials, action policy) into a single unified monorepo.

---

## 🌟 Key Features

- **Free-Only AI Engine Routing**: Hardened runtime strictly using Google Gemini 3.8 Flash (`gemini-3.8-flash`) under the free tier. Enforces **zero paid fallbacks** and **zero automatic credit overages**.
- **Crash-Resilient Task Ledger**: Powered by Node 24 native SQLite (`node:sqlite`) in WAL mode. Recovers tasks across unexpected restarts, server reboots, and power loss without duplicate side-effects.
- **Cryptographic Action Approval Boundary**: Mutating actions (executing commands, writing/deleting files, clicking elements) require explicit owner authorization. Approvals cryptographically bind `(action, argsHash, resource, actor, runId, expiry)` with single-use replay prevention.
- **Governed Sandboxed Computers**: OpenBot container supervisor integration with persistent browser profiles and workspace volumes. Container credentials are cryptographically derived via HMAC-SHA256 (`opendots-computer:<dotId>`), ensuring containers never see the master secret.
- **Revision-Checked Documents**: Optimistic concurrency control for notes and documents. Changes made during agent runs are synchronized into revision-checked pages without clobbering user edits.
- **Multi-Host MCP Server**: Model Context Protocol (MCP 2024-11-05) stdio server ready to plug directly into **Antigravity**, **Claude Desktop**, or **Codex**.
- **Outbound Runner Fleet**: Connect secondary laptops and worker nodes using short 8-character pairing codes (`rn_...`) via outbound-only connections—no inbound ports, port-forwarding, or firewalls to configure.
- **Quiet Proactivity & Schedules**: Recurring jobs in `Asia/Kolkata` timezone with idempotent slot deduplication. Built-in Heartbeat adheres to Perry's `QUIET = "NOTHING"` protocol, staying completely silent unless actionable alerts occur.
- **Channels & Mobile Experience**: Long-polling Telegram bot adapter supporting `/task`, `/approve`, `/status`, and delivery of verified artifacts.

---

## 🏗️ Architecture & Monorepo Packages

```
Nexora/
├── packages/
│   ├── contracts/          # Shared interfaces, schemas, and lifecycle types
│   ├── runtime/            # Core SQLite task ledger, lease fencing, monotonic sequencing
│   ├── provider-engine/    # Gemini 3.8 Flash direct engine implementing Perry contract
│   ├── budget-router/      # Strict free-only router, atomic reservations, 429 backoff
│   ├── verifier/           # Independent audit suites and lease fencing challenge tests
│   ├── workspace-adapter/  # OpenDots revision-checked page store and profile manager
│   ├── governance/         # OpenBot container bridge, HMAC token generator, policy engine
│   ├── mcp-server/         # Multi-host stdio MCP server for Antigravity, Claude, Codex
│   ├── runner-fleet/       # Outbound runner pairing, heartbeat, and lease fencing
│   ├── proactivity/        # Asia/Kolkata cron schedules, quiet heartbeat, bounded delegation
│   └── channels/           # Telegram bot adapter and human-readable approval cards
├── scripts/
│   ├── start.ps1           # Windows PowerShell startup orchestrator
│   ├── start.sh            # Linux / macOS POSIX startup orchestrator
│   └── run-phase2-slice.ts # Live Gemini 3.8 Flash vertical slice runner
├── docs/                   # Full architecture, operations, and phase ledger documentation
└── tests/                  # End-to-end integration test suites
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: v24.0.0+ (requires native `node:sqlite` and `--experimental-strip-types`)
- **Git**: Installed and configured
- **GEMINI_API_KEY**: Required for live model execution

### 1. Installation
Clone the repository:
```bash
git clone https://github.com/Ritish017/Nexora.git
cd Nexora
```

### 2. Run All Tests (146 Passing)
Verify the complete test suite across all 10 packages and the end-to-end integration test:
```bash
node --experimental-strip-types --test packages/*/tests/*.test.ts tests/*.test.ts
```

### 3. Launch the Orchestrator
On Windows (PowerShell):
```powershell
.\scripts\start.ps1
```

On Linux / macOS:
```bash
./scripts/start.sh
```

---

## 🔌 Model Context Protocol (MCP) Setup

Nexora includes configuration manifests for multiple IDEs and agents:

### Antigravity (`packages/mcp-server/manifests/antigravity-mcp.json`)
```json
{
  "name": "nexora-mcp",
  "command": "node",
  "args": ["--experimental-strip-types", "packages/mcp-server/src/cli.ts"],
  "env": {
    "NEXORA_DB_PATH": "data/nexora.db"
  }
}
```

### Claude Desktop (`packages/mcp-server/manifests/claude-desktop-config.json`)
Add under `mcpServers` in your Claude Desktop configuration:
```json
{
  "mcpServers": {
    "nexora": {
      "command": "node",
      "args": ["--experimental-strip-types", "C:\\AI-Projects\\Nexora\\packages\\mcp-server\\src\\cli.ts"],
      "env": {
        "NEXORA_DB_PATH": "C:\\AI-Projects\\Nexora\\data\\nexora.db"
      }
    }
  }
}
```

---

## 📜 Upstream Attribution & Licenses

Nexora reuses architectural components and patterns from the following open-source projects under Development Integrity Mode:
- **Perry** (`https://github.com/TheM1N9/perry.git`) - MIT License (c) TheM1N9.
- **OpenDots** (`https://github.com/CopilotKit/OpenDots.git`) - MIT License (c) Atai Barkai / CopilotKit.
- **OpenBot** (`https://github.com/CopilotKit/OpenBot.git`) - MIT License (c) CopilotKit. Pinned revision `b6932d31`.

See [`docs/UPSTREAM-LOCK.md`](docs/UPSTREAM-LOCK.md) and [`docs/REUSE-MAP.md`](docs/REUSE-MAP.md) for complete details.

---

## 🛡️ License

This project is licensed under the [MIT License](LICENSE).
