# Nexora Implementation Phases & Gates

This document defines the 10 execution phases (Phases 0–9) for building the Nexora hybrid personal agent, specifying required outcomes, gate criteria, and verification tests.

---

### Phase 0: Audit, Repositories & Foundations
- **Scope**: Resolve `PROJECT_ROOT`, clone upstream repositories (`perry`, `opendots`, `openbot`), preserve histories/licenses, probe runtime environment (Node, npm, Docker, agy, Gemini key), lock versions, establish architecture, reuse map, and team structure.
- **Gate 0 Verification**:
  - Clones exist in `repos/` with full Git history and untouched licenses.
  - Pinned commit SHAs recorded in `docs/UPSTREAM-LOCK.md`.
  - Upstream reuse map recorded in `docs/REUSE-MAP.md`.
  - Tool probe results logged without exposing secrets.
  - Scoped brief presented to the user for initial execution approval.

---

### Phase 1: Establish Perry Runtime & Durable Tasks
- **Scope**: Local Perry server & SQLite storage layer (`server/db.ts`), canonical task/run state machine, durable leases, idempotent submission, progress event streaming, cancellation, and artifact generation.
- **Gate 1 Verification**:
  - Executable vertical slice: one durable task executes, writes progress events, saves a markdown artifact to disk, and verifies acceptance.
  - State recovery test: simulate runtime restart; verify task and saved artifact persist without loss or duplication.
  - Lifecycle negative tests: duplicate submission rejected/idempotent, cancellation halts work, worker timeout triggers recovery.

---

### Phase 2: Direct API Engine, Free-Only Routing & Budgets
- **Scope**: Implement Direct API Engine for `gemini-3.8-flash` using official Gemini SDK / API keys. Implement capability registry, cost reservation, zero-paid-fallback policy, and HTTP 429 backoff queue.
- **Gate 2 Verification**:
  - Direct API turn succeeds with Gemini 3.8 Flash using free tier.
  - Zero-paid guard: blocked requests to paid endpoints with zero-balance configuration.
  - Budget reservation atomicity and tool turn caps verified.

---

### Phase 3: OpenDots Workspace & Local Conversation Adapter
- **Scope**: Adapt OpenDots workspace UI (Spaces, page canvas, review cards) to talk directly to Perry's task/run API via a local profile adapter, eliminating cloud CopilotKit Intelligence dependency.
- **Gate 3 Verification**:
  - Browser UI renders task list, active runs, and document canvas.
  - Streamed progress from a running task appears live.
  - Document edit saves with optimistic revision check; stale revision rejected cleanly.

---

### Phase 4: Governed OpenBot Computers & Action Policy
- **Scope**: Integrate compatible OpenBot computer supervisor (`b6932d31` pin) with HMAC-derived per-Dot credentials. Bridge action policies and owner approvals to canonical run events.
- **Gate 4 Verification**:
  - Policy denial prevents unauthorized filesystem/network actions.
  - Action approval token requires exact arguments, actor, and run ID; mutated arguments require re-approval.
  - Isolated browser/workspace volumes persist across container restarts (when Docker daemon is active).

---

### Phase 5: Engine Adapters & Multi-Host MCP Server
- **Scope**: Package unified MCP server supporting Antigravity, Codex, and Claude with host manifest wrappers. Expose tools for task submission, run inspection, memory retrieval, and artifact access.
- **Gate 5 Verification**:
  - MCP stdio server passes schema verification and tool calls.
  - Antigravity / CLI loads MCP tools without permission leaks.
  - Headless engine turns handle approval states gracefully.

---

### Phase 6: Remote Access Fleet & Runner Leases
- **Scope**: Outbound runner pairing with scoped revocable tokens. Lease fencing, heartbeat timeout, and task requeuing when runners disconnect.
- **Gate 6 Verification**:
  - Paired runner accepts work and reports status outbound.
  - Revoked pairing token rejects subsequent claims immediately.
  - Interrupted lease fencing prevents stale workers from committing side-effects.

---

### Phase 7: Goals, Events, Quiet Proactivity & Delegation
- **Scope**: Ongoing goals with criteria and budgets; cron/schedule runner with Asia/Kolkata default; deduplicated event inbox; bounded sub-agent delegation with depth and recursion limits.
- **Gate 7 Verification**:
  - Cron trigger submits task idempotently without duplicate runs.
  - Sub-agent delegation tree propagates status and cancellation cleanly.
  - Heartbeat remains quiet when state is unchanged.

---

### Phase 8: Channels, Desktop Integration & UX Polish
- **Scope**: Telegram bot adapter; mobile-responsive web layouts; human-readable states for quota exhaustion, waiting approval, and offline runners.
- **Gate 8 Verification**:
  - Telegram task trigger posts status and artifact link.
  - UI approval cards display exact proposed actions clearly.

---

### Phase 9: End-to-End Verification & Production Packaging
- **Scope**: Full integration test suite; startup scripts (`scripts/start.ps1`, `scripts/start.sh`); operations guide; verification documentation.
- **Gate 9 Verification**:
  - Complete end-to-end flow: remote submission -> task execution -> artifact creation -> approval check -> page update -> clean shutdown.
  - Truthful report in `docs/CONTINUATION.md` distinguishing live integrations from optional/pending items.
