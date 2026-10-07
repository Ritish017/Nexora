# Nexora Team Structure & Parallel Workstream Plan

## 1. Principles of Parallel Agent Execution

To prevent hallucinated concurrency and code collisions, the following rules govern all parallel workstreams:

1. **Coordinator Authority**: One coordinator owns architecture contracts, root package manifests, database schema migrations, and branch integrations. Workers never edit shared contracts directly.
2. **Non-Overlapping Edit Scopes**: Each worker is assigned a strict, non-overlapping directory and file scope. Edits outside the assigned scope are prohibited and rejected at integration.
3. **Genuine Worktrees**: When parallel subagents or background workers are dispatched, they operate in isolated Git worktrees (`.worktrees/*`) or separated package subdirectories.
4. **Worker Contract & Context**: Every worker receives a complete standalone brief containing upstream commit pins, required interfaces, forbidden paths, and specific acceptance tests.
5. **No Simulated Teams**: Multiple roles are never role-played inside a single prompt thread. Genuine delegation is dispatched via Antigravity native subagents (`invoke_subagent`), or executed sequentially with explicit reporting.

## 2. Defined Roles & Scopes

| Role | Initial Concurrency | Target Paths & Scopes | Primary Deliverables | Prohibited Paths |
| :--- | :--- | :--- | :--- | :--- |
| **Coordinator / Integrator** | 1 (Primary) | `docs/*`, `packages/contracts/*`, root manifests, `scripts/*` | System architecture, canonical schemas, integration tests, lockfiles | None |
| **Runtime Worker** | Max 1 | `packages/runtime/*`, `repos/perry/` integration | Task queue, SQLite ledger, state machine, leases, engine runners | `packages/ui/*`, `packages/governance/*` |
| **Workspace Worker** | Max 1 | `packages/workspace-adapter/*`, `repos/opendots/` integration | OpenDots local conversation adapter, page sync, event streaming | `packages/runtime/db/*`, `packages/governance/*` |
| **Computer Worker** | Max 1 | `packages/governance/*`, `repos/openbot/` integration | OpenBot supervisor adapter, HMAC credentials, action policy gates | `packages/runtime/*`, `packages/workspace-adapter/*` |
| **Verifier / Security Auditor** | Max 1 (between waves) | `tests/*`, audit suites | Independent verification of phase gates, negative tests, policy enforcement | Production application code |

## 3. Worker Concurrency Limit & Dispatch Policy

- **Initial Concurrency**: At most **three (3)** concurrent implementation workers may be dispatched during parallel waves.
- **Verification of Dispatch**: The coordinator verifies actual subagent process dispatch using `manage_subagents` rather than assuming concurrency.
- **Sequential Fallback**: If subagent slots or system limits prevent concurrent dispatch, tasks execute strictly sequentially with explicit logging in `docs/AGENT-RUNS.md`.
