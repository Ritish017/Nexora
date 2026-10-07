# Upstream Reuse Map

This document maps every capability required by the Nexora hybrid agent to its upstream source component, commit SHA, reuse boundary, test status, and necessary adapter work.

## Capability Reuse Matrix

| Capability | Authority / Provider | Upstream Source Path & Commit | Reuse Status | Adapter / Integration Seam | Required External Services |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Durable Task Ledger & Runs** | Perry | `repos/perry/server/db.ts` (`0a9ad789`), `repos/perry/runner/engine.ts` | Reuse direct | SQLite-backed document store with schema indexes; run lifecycle states; task submission API | Local SQLite (built into Node 24) |
| **Scheduler & Jobs Engine** | Perry | `repos/perry/convex/jobs.ts`, `repos/perry/convex/schedules.ts` | Reuse direct | Disable duplicate schedulers from OpenDots/OpenBot; Perry owns single recurring cron and event triggers | Local Node.js timer loop |
| **Engine Contract & Headless Runners** | Perry | `repos/perry/runner/engine.ts`, `repos/perry/runner/engines/*` | Reuse & extend | Extends `Engine` contract with Direct API Engine (Gemini 3.8 Flash, Groq, OpenRouter) | Direct Gemini API Key (or local server) |
| **Workspace & Document UI** | OpenDots | `repos/opendots/src/client/pages/`, `repos/opendots/src/client/components/` (`625452e0`) | Adapt | Connect to Perry's task/chat/event stream via local profile adapter instead of requiring cloud CopilotKit Intelligence | Local browser / Hono server |
| **Revision-Checked Page Store** | OpenDots / Perry | `repos/opendots/src/server/storage/`, `repos/perry/convex/notes.ts` | Reuse direct | Optimistic concurrency control (`version` counter), Tiptap markdown sync | Local SQLite |
| **Governed Computers & Isolation** | OpenBot | `repos/openbot/server/supervisor/`, `repos/openbot/agent-computer/` (Pin: `b6932d31`) | Adapt & reuse | Container supervisor, persistent workspace/profile volumes, HMAC-derived per-dot credentials | Docker Engine / WSL2 (when running containerized) |
| **Action Policy & Audit Trail** | OpenBot | `repos/openbot/server/policy/`, `repos/openbot/server/audit/` | Reuse logic | Bridge policy evaluations and human approvals into Perry's canonical run events ledger | Local database |
| **Multi-Host MCP Server** | Perry / Nexora | `repos/perry/runner/mcp-bridge.ts` + New package | Build | Provide unified stdio MCP server for Antigravity, Codex, and Claude with host manifest wrappers | Native host environment |
| **Remote Access & Pairing** | Perry | `repos/perry/runner/pair.ts`, `repos/perry/scripts/connect.ts` | Reuse direct | Outbound WebSocket runner connection with scoped revocable tokens and lease fencing | Local network / Tailscale / Private VPN |
| **Messaging Channels** | Perry | `repos/perry/runner/channels/telegram.ts` | Reuse direct | Canonical task dispatch and notification deduplication over Telegram bot API | Telegram Bot Token (optional) |

## Duplicate Responsibilities Resolution

1. **Scheduling**: OpenDots background threads and OpenBot routine workers are disabled in the hybrid profile. Perry is the sole authority for cron schedules, goal heartbeats, and time-triggered tasks.
2. **Conversation / Agent State**: Perry owns personal memory, run logs, and task definitions. OpenDots is the presentation layer for documents and chats.
3. **Execution Sandboxing**: OpenBot governs container environments (Chromium, Linux shell). Native Windows tasks execute under Perry's runner with explicit permission gates.
