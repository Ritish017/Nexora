# Nexora Operations & Deployment Guide

This guide provides operational instructions, configuration specifications, and security policies for running the **Nexora** hybrid personal agent.

---

## 1. System Overview & Package Architecture

Nexora is built as a modular monorepo leveraging native Node 24 ESM and SQLite in WAL mode:

| Package | Path | Purpose |
| :--- | :--- | :--- |
| `@nexora/contracts` | `packages/contracts` | Shared TypeScript contracts, lifecycle types, and engine interfaces. |
| `@nexora/runtime` | `packages/runtime` | Core SQLite task ledger (`NexoraDatabase`), lease fencing, monotonic sequencing, and restart recovery. |
| `@nexora/provider-engine` | `packages/provider-engine` | Direct API Gemini engine (`gemini-3.8-flash`) implementing the Perry `Engine` contract with streaming events. |
| `@nexora/budget-router` | `packages/budget-router` | Strict `free-only` model routing, atomic token reservations, and non-blocking 429 jittered backoff. |
| `@nexora/verifier` | `packages/verifier` | Independent invariant audits, lease fencing challenge tests, and negative-path suites. |
| `@nexora/workspace-adapter`| `packages/workspace-adapter` | OpenDots revision-checked page store with optimistic concurrency control and local profile manager. |
| `@nexora/governance` | `packages/governance` | OpenBot computer supervisor bridge, HMAC per-Dot credential derivation, and action policy engine. |
| `@nexora/mcp-server` | `packages/mcp-server` | Multi-host Model Context Protocol (MCP) server for Antigravity, Claude Desktop, and Codex. |
| `@nexora/runner-fleet` | `packages/runner-fleet` | Outbound revocable runner pairing, heartbeat tracking, and lease fencing. |
| `@nexora/proactivity` | `packages/proactivity` | Scheduled cron jobs (`Asia/Kolkata` default), deduplicated event inbox, quiet heartbeat (`NOTHING`), and bounded delegation. |
| `@nexora/channels` | `packages/channels` | Telegram long-polling bot adapter and human-readable approval/status cards. |

---

## 2. Prerequisites & Environment Configuration

### Required Environment
- **Node.js**: `v24.0.0+` (verified on Node `v24.11.1` with native `node:sqlite`).
- **Operating System**: Windows 11 (PowerShell), macOS, or Linux.
- **Docker** (Optional for container computers): If Docker daemon is stopped, container supervisor gracefully falls back to offline status without crashing.

### Environment Variables
Configure the following in your environment or PowerShell profile:

```env
# Google Gemini API Key (Required for live turns)
GEMINI_API_KEY=your_gemini_api_key_here

# Local Database Location (Optional, defaults to data/nexora.db)
NEXORA_DB_PATH=data/nexora.db

# OpenBot Computer Secrets (Optional, for container computers)
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=random_secret_at_least_24_chars
COMPUTER_TOKEN=master_random_secret_at_least_24_chars
COMPUTER_NAMESPACE=nexora

# Telegram Bot (Optional, for mobile messaging channel)
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

---

## 3. Security & Governance Invariants

1. **Free-Only Routing Policy**:
   - Runtime model routing is strictly restricted to `gemini-3.8-flash` under the free tier.
   - Any request for a paid endpoint, unverified entitlement, or unknown pricing throws `DisallowedPaidEndpointError` immediately.
   - Zero paid fallback and zero credit overages.

2. **Action Approval Binding**:
   - Mutating actions (`exec`, `files_write`, `files_delete`, `browser_click`) in `supervised` mode require human owner authorization.
   - Approval signatures bind cryptographically:
     `HMAC(action:argumentsHash:resource:actor:runId:policyVersion:expiry)`.
   - Any mutation to argument values requires re-approval.
   - Approved tokens are consumed exactly once (replay attacks prevented).

3. **Isolated Computer Credentials**:
   - Containers never receive the master `COMPUTER_TOKEN`.
   - Each Dot/Agent receives a cryptographically derived isolated token:
     `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)`.

4. **Network Boundaries**:
   - Internal development endpoints bind strictly to `127.0.0.1`.
   - Remote workers connect **outbound** with short-lived pairing tokens.
   - SQLite databases are never shared or mounted across network file systems.

---

## 4. MCP Integration with Antigravity, Claude, and Codex

### Antigravity (`packages/mcp-server/manifests/antigravity-mcp.json`)
Add to your Antigravity MCP settings:
```json
{
  "name": "nexora-mcp",
  "command": "node",
  "args": ["--experimental-strip-types", "C:\\AI-Projects\\Nexora\\packages\\mcp-server\\src\\cli.ts"],
  "env": {
    "NEXORA_DB_PATH": "C:\\AI-Projects\\Nexora\\data\\nexora.db"
  }
}
```

### Claude Desktop (`packages/mcp-server/manifests/claude-desktop-config.json`)
Add under `mcpServers` in Claude Desktop configuration:
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

## 5. Startup & Verification Commands

### Launching Nexora
On Windows PowerShell:
```powershell
.\scripts\start.ps1
```

On Linux / macOS:
```bash
./scripts/start.sh
```

### Running the Test Suite
Run all unit, integration, and end-to-end tests:
```bash
node --experimental-strip-types --test packages/*/tests/*.test.ts tests/*.test.ts
```

### Running Live Model Vertical Slice
Execute a live turn against Gemini 3.8 Flash using your `GEMINI_API_KEY`:
```bash
node --experimental-strip-types scripts/run-phase2-slice.ts
```
