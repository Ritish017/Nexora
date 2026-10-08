# Nexora Phase 2 Direct API Engine & Free-Only Routing Verification Report

- **Run ID**: `run_g6kjgg8e12p0fbr9`
- **Task ID**: `task_vsk9r2gw0mf76y34`
- **Model**: `gemini-3.8-flash` (Gemini 3.8 Flash)
- **Provider Protocol**: `gemini-rest`
- **Routing Mode**: `free-only` (Zero Paid Fallback & Zero Credit Overages Enforced)
- **Turn Duration**: `7411 ms`
- **Token Usage**: Input: 46, Output: 23, Total: 69
- **Timestamp**: `2026-10-08T12:28:20.441Z`

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
{"project":"Nexora","model":"Direct API","phase":2,"status":"completed","verified":true}
```
