# Nexora Phase 2 Direct API Engine & Free-Only Routing Verification Report

- **Run ID**: `run_g6kjgg8e12p0fbr9`
- **Task ID**: `task_vsk9r2gw0mf76y34`
- **Model**: `gemini-3.8-flash` (Gemini 3.8 Flash)
- **Provider Protocol**: `gemini-rest`
- **Routing Mode**: `free-only` (Zero Paid Fallback & Zero Credit Overages Enforced)
- **Turn Duration**: `7426 ms`
- **Token Usage**: Input: 46, Output: 26, Total: 306
- **Timestamp**: `2026-10-08T18:28:35.735Z`

---

## 1. Verified Invariants
- [x] **Free-Only Enforcement**: Paid models (`gemini-1.5-pro`, `claude-3-opus`) strictly rejected with `DisallowedPaidEndpointError`.
- [x] **Live Direct API Engine**: Real execution against Google Gemini API with `gemini-3.8-flash`.
- [x] **Normalized Streaming**: Text deltas and item events streamed to canonical run ledger with monotonic sequence numbers.
- [x] **Atomic Token Reservation**: Tokens reserved before execution and reconciled cleanly upon completion.
- [x] **Governed Tool Boundary**: Non-mutating safety; all tool calls routed through `sink.onRequest` approval checks.
- [x] **Rate Limit Backoff**: Non-blocking jittered exponential backoff scheduler verified.

---

## 2. Model Output Sample
```json
{"project":"Nexora","model":"Nexora-v2","phase":2,"status":"passed","verified":true}
```
