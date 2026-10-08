# Nexora

<div align="center">

```
   _  __                     
  / |/ /__ __ _____  _______ 
 /    / -_) \ / _  \/ __/ _ `/
/_/|_/\__/_\_\\___/_/  \_,_/ 
```

### The Sovereign, Crash-Resilient Hybrid Personal Agent Operating System

[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/Storage-SQLite_WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![Model](https://img.shields.io/badge/AI_Engine-Gemini_3.8_Flash-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)
[![Routing](https://img.shields.io/badge/Cost_Policy-Strict_Free--Only-00C853?style=for-the-badge)](docs/ARCHITECTURE.md)
[![Tests](https://img.shields.io/badge/Automated_Tests-149%20Passing-brightgreen?style=for-the-badge)](tests/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

**Local-First &bull; Crash-Proof Ledger &bull; Governed Action Boundaries &bull; Zero Paid Overages &bull; Multi-Host MCP**

[Quick Start](#-quick-start) &bull;
[What is Nexora?](#-what-is-nexora) &bull;
[Visual Architecture](#-visual-architecture--data-flow) &bull;
[Local Web Console](#-local-web-console) &bull;
[Core Capabilities](#-core-capabilities) &bull;
[Monorepo Packages](#-monorepo-packages) &bull;
[MCP Integration](#-model-context-protocol-mcp-integration)

</div>

---

## 💡 What is Nexora?

Most existing AI agents are fragile: they run as ephemeral background loops in the cloud, execute uninspected terminal commands on your host system, and rack up unexpected credit card charges when loops spin out of control. When your network drops, your computer sleeps, or the server crashes, all in-flight state is obliterated.

**Nexora changes this paradigm.**

Nexora is a **sovereign, local-first hybrid personal agent operating system**. Built from first principles on modern Node 24 native SQLite WAL storage, it treats every user instruction as a **durable, crash-resilient transaction** with an immutable audit log, explicit action governance, and strictly enforced free-only model routing.

### The Nexora Difference

| Feature | Traditional Cloud AI Agents | Nexora Sovereign Agent OS |
| :--- | :--- | :--- |
| **Execution State** | Volatile in-memory variables; lost on disconnect | **Durable SQLite WAL ledger**; resumes instantly after reboot |
| **Model Cost Control** | Uncapped API consumption; surprise bill shock | **Strict Free-Only Routing**; zero paid fallbacks, zero overages |
| **Mutation Safety** | Model executes arbitrary bash commands blindly | **Cryptographic Approval Gate**; single-use HMAC-bound tokens |
| **Computer Sandbox** | Runs on bare metal host or obscure cloud containers | **Governed container isolation**; derived per-dot credentials |
| **Document State** | Overwrites files destructively via raw diffs | **Revision-checked page store** with optimistic concurrency |
| **Remote Access** | Requires exposing open public ports or VPNs | **Outbound-only runner pairing** with 8-character pairing codes |
| **Proactivity** | Annoying, spammy background notifications | **Quiet Heartbeat protocol**; zero pings unless action is required |
| **Ecosystem Hooks** | Locked to proprietary web dashboards | **Native stdio MCP server** for Antigravity, Claude, and Codex |

---

## 🏗️ Visual Architecture & Data Flow

Nexora unifies multi-channel inputs, durable task execution, model routing, safety governance, and workspace document sync into a single coherent lifecycle:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       USER INTERFACES                                       │
│                                                                                             │
│   [Local Web Console]         [Telegram Bot]          [IDE / Host Agents]     [Schedules]   │
│   http://127.0.0.1:3000        /task, /approve         Antigravity / Claude    Asia/Kolkata │
└──────────────┬───────────────────────┬──────────────────────────┬────────────────────┬──────┘
               │                       │                          │                    │
               ▼                       ▼                          ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   INGESTION & PROTOCOL GATEWAY                              │
│                                                                                             │
│  • Idempotency Deduplication Key Checking                                                   │
│  • Bounded Delegation Depth Protection (Max Recursion: 3)                                   │
│  • Multi-Host Model Context Protocol (MCP 2024-11-05 Stdio Server)                          │
└──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                CRASH-RESILIENT TASK RUNTIME                                 │
│                                                                                             │
│   SQLite Database (data/nexora.db in WAL Mode)                                              │
│   ├── Tasks & Runs Ledger (queued ➔ running ➔ awaiting_approval ➔ completed)                │
│   ├── Monotonic Event Stream (seq 1..N per run; zero clobbering)                            │
│   ├── Worker Lease Fencing (distributed heartbeat; steals expired leases)                   │
│   └── Startup Crash Recovery (quarantines uncertain mutations; restarts cleanly)            │
└──────────────┬───────────────────────────────────────────────────────────────┬──────────────┘
               │                                                               │
               ▼                                                               ▼
┌──────────────────────────────────────────────┐  ┌───────────────────────────────────────────┐
│        BUDGET ROUTER & MODEL ENGINE          │  │       GOVERNANCE & APPROVAL BOUNDARY      │
│                                              │  │                                           │
│  • Strict Free-Only Policy                   │  │  • Cryptographic Action Binding:          │
│    Model: Google Gemini 3.8 Flash            │  │    (action, argsHash, resource, actor,    │
│  • Atomic Token Reservation & Reconcile      │  │     runId, policyVersion, expiry)         │
│  • Zero Paid Fallback (DisallowedPaidError)  │  │  • Replay Prevention (Single-use token)   │
│  • Non-Blocking 429 Jittered Backoff         │  │  • Dangerous mutation interception        │
│  • Opaque Session Cursor Resumption          │  │  • Read-only operations auto-permitted    │
└──────────────────────┬───────────────────────┘  └─────────────────────┬─────────────────────┘
                       │                                                │
                       ▼                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                               EXECUTION & PERSISTENCE BOUNDARIES                            │
│                                                                                             │
│  [Governed Computers]       [Revision-Checked Canvas]       [Outbound Runner Fleet]         │
│  Isolated containers with   Optimistic concurrency          Secondary laptops & nodes       │
│  HMAC-derived credentials   page store with draft recovery  paired via short pairing codes  │
│                                                                                             │
│  [Verified Output Artifacts]                                                                │
│  Deterministic markdown files on disk verified by SHA-256 integrity checksums              │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🖥️ Local Web Console

Nexora includes an embedded, high-performance local console served natively through Node without heavy frontend build steps. It lets you test workflows, inspect real-time worker logs, and authorize pending actions directly in your browser.

```
+---------------------------------------------------------------------------------------------+
|  NEXORA SOVEREIGN CONSOLE                                               [● RUNTIME ACTIVE]  |
+---------------------------------------------------------------------------------------------+
|                                                                                             |
|  [ EXECUTION MODE ]                                                                         |
|  (•) Local Demo Mode (Zero API keys needed)      ( ) Live Gemini 3.8 Flash Mode             |
|                                                                                             |
|  [ SUBMIT DURABLE TASK ]                                                                    |
|  +---------------------------------------------------------------------------------------+  |
|  | Create a short introduction to Nexora.                                                |  |
|  +---------------------------------------------------------------------------------------+  |
|  [  SUBMIT TASK  ]                                                                          |
|                                                                                             |
+---------------------------------------------------------------------------------------------+
|  [ ACTIVE WORKER LOG ]                                     [ PENDING ACTIONS & APPROVALS ]  |
|  12:01:02 [claimed] Worker lease claimed (30s)             +-----------------------------+  |
|  12:01:03 [item_started] Generating Nexora intro           | Action: files_write         |  |
|  12:01:04 [approval_requested] Write file to disk          | Target: nexora_intro.md     |  |
|  12:01:06 [user_action] Mutation APPROVED                  | Run ID: run_94a2b1          |  |
|  12:01:07 [artifact_created] SHA-256 verified              | [ APPROVE ]   [ DECLINE ]   |  |
|  12:01:08 [completed] Run completed in 1.4s               +-----------------------------+  |
+---------------------------------------------------------------------------------------------+
|  [ ARTIFACT INSPECTOR & OUTPUT VERIFIER ]                                                   |
|  File: artifacts/nexora_intro_demo.md | Checksum: a64f7b2e9d... | Size: 1.2 KB              |
|  >>> Verified deterministic output generated and saved under full lease protection.        |
+---------------------------------------------------------------------------------------------+
```

---

## ⚡ Quick Start

### Prerequisites
- **Node.js**: v24.0.0 or later (uses native `node:sqlite` and `--experimental-strip-types`)
- **Git**: Installed on your system
- *(Optional)* **GEMINI_API_KEY**: Required only if you switch to Live Gemini 3.8 Flash Mode. **Not needed for Local Demo Mode.**

### 1. Clone the Project
```bash
git clone https://github.com/Ritish017/Nexora.git
cd Nexora
```

### 2. Launch the Web Console
Launch Nexora with a single command:
```bash
npm start
```
*(Or run directly: `node --experimental-strip-types scripts/demo-server.ts`)*

Open your browser at:
👉 **[http://127.0.0.1:3000](http://127.0.0.1:3000)**

### 3. Run the Instant Demo
1. Keep the mode selected on **Local Demo Mode**.
2. Click **Submit Task** on the pre-filled prompt: *"Create a short introduction to Nexora."*
3. Watch the worker claim the lease and transition to `awaiting_approval`.
4. Click **Approve** on the file-write action card.
5. Inspect the generated artifact with its SHA-256 checksum and monotonic execution ledger.
6. Restart the server anytime—your tasks, runs, and artifacts will remain 100% intact.

---

## 🛡️ Core Capabilities

### 1. Crash-Proof Task Ledger & Restart Recovery
- Built entirely on Node 24 native SQLite with **Write-Ahead Logging (WAL)**.
- **Monotonic Event Sequencing**: Every progress tick, reasoning step, and state change gets an incrementing sequence number `seq: 1..N`. Duplicate insertion is prevented by database constraints.
- **Lease Fencing**: Workers take time-bounded leases (default 30s) on tasks. If a worker process dies, another worker automatically reclaims the task once the lease expires.
- **Startup Quarantine**: Upon reboot, any run interrupted mid-mutation is marked as `uncertain_effect` to prevent hazardous automated replays.

### 2. Guaranteed Free-Only AI Model Routing
- Targets **Google Gemini 3.8 Flash** (`gemini-3.8-flash`) through a hardened provider engine.
- **Strict Free-Only Policy**: If a paid endpoint or unknown model is configured, the router immediately raises a `DisallowedPaidEndpointError`.
- **Zero Automatic Overages**: Atomic token reservations are verified before initiating turns, and actual consumption is reconciled post-turn.
- **Non-Blocking 429 Jittered Backoff**: Exponential backoff with random jitter handles upstream rate limits gracefully without busy-wait sleeping.

### 3. Cryptographic Action Governance Gate
- Separates safe read-only operations from dangerous mutating actions (shell commands, file modifications, browser clicks, deletions).
- Evaluates actions against a multi-tier policy:
  - **Read Operations**: Auto-approved.
  - **Mutations**: Require explicit human approval.
- Approvals are cryptographically signed tokens containing:
  `HMAC-SHA256(action, argumentsHash, resource, actor, runId, policyVersion, expiry)`
- Every token is strictly single-use to eliminate replay vulnerabilities.

### 4. Sandboxed Governed Computers
- Isolated execution environments for browser automation, code execution, and filesystem modifications.
- Container credentials are cryptographically derived on demand:
  `HMAC-SHA256(MASTER_COMPUTER_TOKEN, "dot-computer:" + dotId)`
- Sub-containers and worker processes never have access to master secrets or host-level root keys.

### 5. Revision-Controlled Document Canvas
- Integrated document store with **optimistic concurrency control**.
- When an agent completes a task, the resulting artifact is written as a versioned page (`expectedRevision`).
- If a user modified the document in the meantime, the engine throws `PageConflictError` with `draftRecoverable: true`, ensuring your manual edits are never overwritten.

### 6. Outbound-Only Runner Fleet
- Connect secondary workstations, home servers, or laptop nodes without exposing public ports, configuring router port-forwarding, or setting up complex VPNs.
- Mint a short 8-character pairing code (`rn_...`) with a 5-minute expiry.
- Remote runners connect outbound via polling or WebSockets, authenticate with revocable bearer tokens, and maintain worker lease fencing.

### 7. Quiet Proactivity & Autonomous Schedules
- Built-in cron scheduler supporting the `Asia/Kolkata` timezone with idempotent slot keys (`job_{id}_slot_{timestamp}`).
- Deduplicated event inbox with sliding TTLs.
- Adheres to the **Quiet Proactivity Protocol** (`QUIET = "NOTHING"`): background monitors inspect health silently and never send notifications unless critical human intervention is required.

### 8. Multi-Channel Experience
- **Web Console**: Real-time browser UI for inspection, approvals, and metrics.
- **Telegram Bot**: Long-polling bot adapter supporting `/task`, `/approve`, `/status`, and artifact delivery directly on mobile devices.
- **Headless CLI & Daemon**: Scriptable via POSIX and PowerShell orchestrators.

---

## 📦 Monorepo Packages

Nexora is structured as a modular TypeScript monorepo with 10 isolated packages:

```
packages/
├── contracts/          # Shared interfaces, schemas, and lifecycle types
├── runtime/            # SQLite document storage, lease fencing, monotonic ledger
├── provider-engine/    # Gemini 3.8 Flash direct engine with streaming & tool routing
├── budget-router/      # Strict free-only router, token reservations, 429 backoff
├── verifier/           # Independent audit suites and lease fencing challenge tests
├── workspace-adapter/  # Revision-checked page store and workspace profile manager
├── governance/         # Sandboxed computer bridge, HMAC credential derivation, policy engine
├── mcp-server/         # Multi-host stdio MCP server for Antigravity, Claude, Codex
├── runner-fleet/       # Outbound runner pairing, heartbeat tracking, lease management
├── proactivity/        # Cron schedules, quiet heartbeat monitor, bounded delegation
└── channels/           # Telegram bot adapter and human-readable approval cards
```

---

## 🔌 Model Context Protocol (MCP) Integration

Nexora includes a native stdio Model Context Protocol (MCP 2024-11-05) server. You can connect it directly to your favorite agentic IDEs and desktop assistants.

### Available MCP Tools
- `nexora_submit_task`: Submit a durable, crash-resilient task to the ledger.
- `nexora_get_task`: Retrieve task state, status, and assigned worker info.
- `nexora_list_tasks`: Filter and inspect active or completed tasks.
- `nexora_get_run`: Retrieve full execution details and monotonic event logs.
- `nexora_resolve_approval`: Approve or decline a pending mutation request.
- `nexora_get_artifact`: Fetch a verified artifact with SHA-256 verification.
- `nexora_query_pages`: Query the revision-checked document store.

### Configuration Manifests

#### 1. Google Antigravity (`packages/mcp-server/manifests/antigravity-mcp.json`)
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

#### 2. Claude Desktop (`packages/mcp-server/manifests/claude-desktop-config.json`)
Add under `mcpServers` in your Claude Desktop configuration file:
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

#### 3. Codex & Other MCP Clients
```bash
node --experimental-strip-types packages/mcp-server/src/cli.ts
```

---

## 🧪 Verification & Automated Tests

Nexora enforces strict verification gates. All 149 automated tests run natively using Node 24's built-in test runner without external testing dependencies:

```bash
node --experimental-strip-types --test packages/*/tests/*.test.ts tests/*.test.ts
```

```
Test Suites Breakdown:
✔ Runtime Engine & SQLite WAL Storage Integrity (10 tests)
✔ Provider Engine & Gemini 3.8 Flash Protocol Normalization (15 tests)
✔ Free-Only Router, Token Reservations & 429 Backoff (15 tests)
✔ Independent Audit & Negative Resilience Challenge (30 tests)
✔ Revision-Checked Document Canvas & Concurrency (12 tests)
✔ Container Governance, HMAC Credentials & Action Policy (18 tests)
✔ Multi-Host Model Context Protocol (MCP) Server (9 tests)
✔ Outbound Runner Fleet, Pairing & Lease Fencing (8 tests)
✔ Timezone Schedules, Quiet Heartbeat & Delegation (6 tests)
✔ Multi-Channel Presenter & Telegram Adapter (5 tests)
✔ Local Web Console, Demo Trial & Restart Persistence (3 tests)
✔ Full End-to-End Integrated System Lifecycle (18 assertions)
────────────────────────────────────────────────────────────
Total: 149 tests passed (0 failed, 0 skipped)
```

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
