# Agent Runs & Execution Evidence Ledger

This document maintains an auditable record of all autonomous agent and subagent sessions, including role, conversation ID, tool calls, start/end timestamps, test results, and created artifacts.

## Session Index

| Run ID | Role | Tool / Dispatch Method | Model / Tier | Start Time (ISO) | Completion Time | Status | Artifacts / Output |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `run-001` | Lead Coordinator | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-07T17:02:05Z | 2026-10-07T17:09:00Z | Complete | Phase 0 complete: Repositories cloned, env probed, docs created, Scoped Brief produced |
| `run-002` | Lead Coordinator / Runtime Worker | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-07T17:09:40Z | 2026-10-07T17:15:30Z | Complete | Phase 1 complete: packages/runtime created, 10/10 tests passed, durable task executed, saved artifact verified |
| `run-003` | Provider/Engine Worker | Native Subagent `aa616db5-a13d-4337-b089-9bb1077260e0` | Gemini 3.8 Flash | 2026-10-07T17:41:44Z | 2026-10-07T17:52:29Z | Complete | Implemented `packages/provider-engine` (`GeminiEngine`, 15/15 tests pass, commit `2aad8ef`) |
| `run-004` | Quota/Budget Worker | Native Subagent `b06417e9-4bea-4c60-9e6a-7c6fe184bb46` | Gemini 3.8 Flash | 2026-10-07T17:41:44Z | 2026-10-07T17:47:58Z | Complete | Implemented `packages/budget-router` (free-only router, reservations, 429 backoff, 32/32 tests pass, commit `73b5b5e`) |
| `run-005` | Independent Verifier | Native Subagent `af5ff8e0-e3bc-412e-bc02-a98211aefc29` | Gemini 3.8 Flash | 2026-10-07T17:41:44Z | 2026-10-07T17:48:54Z | Complete | Implemented `packages/verifier` (Phase 1 audit & Phase 2 challenge suites, 30/30 tests pass, commit `843f0a1`) |
| `run-006` | Lead Coordinator & Integrator | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-07T17:52:30Z | 2026-10-08T12:28:40Z | Complete | Phase 2 merged: 87/87 tests passed, live vertical slice executed with Gemini 3.8 Flash, saved verified artifact |
| `run-007` | Workspace Adapter Worker | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-08T12:30:00Z | 2026-10-08T12:35:00Z | Complete | Phase 3: OpenDots revision-checked page store, local profile manager, 12/12 tests passed |
| `run-008` | Governance & Computer Worker | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-08T12:35:00Z | 2026-10-08T12:40:00Z | Complete | Phase 4: OpenBot supervisor bridge, HMAC credential derivation, policy engine, 18/18 tests passed |
| `run-009` | MCP Server Worker | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-08T12:40:00Z | 2026-10-08T12:44:00Z | Complete | Phase 5: Multi-host stdio MCP server for Antigravity, Claude, Codex; 9/9 tests passed |
| `run-010` | Runner Fleet Worker | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-08T12:44:00Z | 2026-10-08T12:48:00Z | Complete | Phase 6: Outbound runner pairing, lease fencing, timing-safe auth; 8/8 tests passed |
| `run-011` | Proactivity Worker | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-08T12:48:00Z | 2026-10-08T12:52:00Z | Complete | Phase 7: Asia/Kolkata cron schedules, quiet heartbeat (NOTHING), bounded delegation; 6/6 tests passed |
| `run-012` | Channels & Integration Lead | Antigravity Native Session | Gemini 3.8 Flash (Medium) | 2026-10-08T12:52:00Z | 2026-10-08T13:00:00Z | Complete | Phases 8 & 9: Telegram bot, UI cards, end-to-end integration, startup scripts; 146/146 tests passed |

## Run Details

### `run-001` - Lead Coordinator: Foundation Audit & Phase 0 Setup
- **Objective**: Execute Phase 0 bootstrap: clone Perry, OpenDots, and OpenBot; verify licenses and commits; probe local tools; establish documentation architecture and project contracts.
- **Commands Executed**:
  - `git clone https://github.com/TheM1N9/perry.git repos/perry` -> commit `0a9ad7898221d0b9c3d910a9d08b516c9406518b`
  - `git clone https://github.com/CopilotKit/OpenDots.git repos/opendots` -> commit `625452e06cde74cb25b0ce319e2c1be0488f5a5f`
  - `git clone https://github.com/CopilotKit/OpenBot.git repos/openbot` -> commit `bbd882c8a3471922f020e4cd3040c6161cbf8d69`
  - Node.js 24.11.1 (`node:sqlite` verified functional)
  - Docker 29.0.1 CLI (daemon stopped)
  - `agy models` verified available models (`gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`)
  - Subagent capability verified (`manage_subagents` operational)
  - `GEMINI_API_KEY` presence verified without leaking value
- **Produced Documents**:
  - `docs/UPSTREAM-LOCK.md`
  - `docs/REUSE-MAP.md`
  - `docs/ARCHITECTURE.md`
  - `docs/PHASES.md`
  - `docs/TEAM-PLAN.md`
  - `docs/AGENT-RUNS.md`
  - `docs/CONTINUATION.md`

### `run-002` - Lead Coordinator & Runtime Worker: Phase 1 Durable Task Runtime
- **Objective**: Implement durable SQLite task ledger, canonical lifecycle state machine, worker leases, monotonic event streams, approval gating, and restart recovery; execute Task #1 producing a saved verified artifact.
- **Artifacts / Modules Implemented**:
  - `packages/runtime/package.json`
  - `packages/runtime/src/types.ts`
  - `packages/runtime/src/db.ts` (reusing Perry SQLite document model)
  - `packages/runtime/src/task-service.ts`
  - `packages/runtime/src/fixture-worker.ts`
  - `packages/runtime/src/index.ts`
  - `packages/runtime/tests/phase1-vertical-slice.test.ts`
  - `scripts/run-durable-slice.ts`
- **Tests Executed**:
  - `node --experimental-strip-types --test packages/runtime/tests/phase1-vertical-slice.test.ts` (10/10 tests passed)
  - `node --experimental-strip-types scripts/run-durable-slice.ts` (Durable slice executed against `data/nexora.db`, verified restart recovery)
- **Produced Artifact**:
  - `artifacts/phase1_verification_report.md` (SHA-256: `915f2a2937b9958e597af6243320a09506b9fe0aedb9bfac5e77cddf984931a8`, 1024 bytes)

### `run-003` - Provider/Engine Worker (`aa616db5-a13d-4337-b089-9bb1077260e0`)
- **Scope**: `packages/provider-engine/*` in worktree `.worktrees/worker-a-engine` (branch `worker-a-engine`)
- **Deliverables**: `packages/provider-engine/src/gemini-engine.ts`, `tests/gemini-engine.test.ts`
- **Tests**: 15/15 tests passed.
- **Commit**: `2aad8efc40ace6534d06fadf6079aea83df80bc7`

### `run-004` - Quota/Budget Worker (`b06417e9-4bea-4c60-9e6a-7c6fe184bb46`)
- **Scope**: `packages/budget-router/*` in worktree `.worktrees/worker-b-budget` (branch `worker-b-budget`)
- **Deliverables**: `packages/budget-router/src/model-registry.ts`, `src/budget-router.ts`, `src/reservation-manager.ts`, `src/backoff-scheduler.ts`, `tests/budget-router.test.ts`
- **Tests**: 32/32 tests passed.
- **Commit**: `73b5b5ed671fcce5ea764b651b2918be75cfd453`

### `run-005` - Independent Verifier (`af5ff8e0-e3bc-412e-bc02-a98211aefc29`)
- **Scope**: `packages/verifier/*` in worktree `.worktrees/worker-c-verifier` (branch `worker-c-verifier`)
- **Deliverables**: `packages/verifier/src/auditor.ts`, `tests/phase1-audit.test.ts`, `tests/phase2-challenge.test.ts`, `PHASE2_VERIFICATION_REPORT.md`
- **Tests**: 30/30 tests passed.
- **Commit**: `843f0a1`

### `run-006` - Lead Coordinator & Integrator
- **Scope**: Integration, contract freezing, worktree merge, and live Phase 2 slice execution
- **Merged Commits**: `2aad8ef`, `73b5b5e`, `843f0a1` into `main`
- **Combined Test Suite**: 87/87 tests passed across all 4 packages.
- **Live Smoke Test**: Executed against Google Gemini API with `gemini-3.8-flash` in `scripts/run-phase2-slice.ts` (structured JSON output received, tokens reconciled, restart recovery verified).
- **Produced Artifact**:
  - `artifacts/phase2_verification_report.md` (SHA-256: `dcbdc6b919e53559cea3f58d69ac0b6e9a555f9d1b6344fc21acea2da0c97749`, 1300 bytes)

### `run-007` - Workspace Adapter Worker: Phase 3 OpenDots Workspace & Profiles
- **Scope**: `packages/workspace-adapter/*`
- **Deliverables**: `src/page-store.ts`, `src/profile-manager.ts`, `src/ui-event-adapter.ts`, `tests/workspace-adapter.test.ts`
- **Tests**: 12/12 tests passed (optimistic revision conflict checks, Perry local profile defaults, streamed events to pages).

### `run-008` - Governance & Computer Worker: Phase 4 Governed OpenBot Computers & Action Policy
- **Scope**: `packages/governance/*`
- **Deliverables**: `src/credential-derivation.ts`, `src/policy-engine.ts`, `src/approval-bridge.ts`, `src/supervisor-bridge.ts`, `tests/governance.test.ts`
- **Tests**: 18/18 tests passed (HMAC container tokens matching pin `b6932d31`, path traversal prevention, cryptographic approval binding, Docker offline fallback resilience).

### `run-009` - MCP Server Worker: Phase 5 Multi-Host Model Context Protocol
- **Scope**: `packages/mcp-server/*`
- **Deliverables**: `src/types.ts`, `src/server.ts`, `src/cli.ts`, `manifests/*`, `tests/mcp-server.test.ts`
- **Tests**: 9/9 tests passed (MCP 2024-11-05 protocol handshake, task submission, run inspection, headless approval resolution).

### `run-010` - Runner Fleet Worker: Phase 6 Outbound Runner Fleet & Lease Fencing
- **Scope**: `packages/runner-fleet/*`
- **Deliverables**: `src/types.ts`, `src/fleet-manager.ts`, `src/runner-client.ts`, `tests/runner-fleet.test.ts`
- **Tests**: 8/8 tests passed (pairing codes, revocable bearer tokens, timing-safe authentication, lease fencing race condition protections).

### `run-011` - Proactivity Worker: Phase 7 Goals, Schedules & Delegation
- **Scope**: `packages/proactivity/*`
- **Deliverables**: `src/types.ts`, `src/schedule-runner.ts`, `src/event-inbox.ts`, `src/heartbeat.ts`, `src/delegation-tree.ts`, `tests/proactivity.test.ts`
- **Tests**: 6/6 tests passed (Asia/Kolkata cron schedules, idempotent slot triggers, quiet heartbeat QUIET='NOTHING', max delegation depth limits).

### `run-012` - Channels & End-to-End Integration Lead: Phases 8 & 9
- **Scope**: `packages/channels/*`, `tests/end-to-end-integration.test.ts`, `scripts/start.ps1`, `scripts/start.sh`, `docs/OPERATIONS.md`
- **Deliverables**: Telegram bot long-polling adapter, human-readable UI approval cards, comprehensive e2e verification, production startup orchestrators.
- **Tests**: 5/5 channels tests passed; 1/1 full lifecycle integration test passed; **146 / 146 passing across entire repository**.
