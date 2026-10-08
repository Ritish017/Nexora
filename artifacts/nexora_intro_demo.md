# [LOCAL DEMO] Introduction to Nexora

> **Mode**: Local Demo Mode  
> **Integrity**: Deterministic Local Output (Zero API Keys / No External Network Calls)

---

## What is Nexora?
**Nexora** is a sovereign, crash-resilient hybrid personal agent operating system designed for governed autonomous execution. It provides a complete, local-first platform for durable AI operations:

1. **Durable Task Ledger & Restart Recovery**:
   - SQLite WAL task storage with monotonic event sequence numbering.
   - Worker lease fencing and automated crash recovery across unexpected reboots.
   - Guarantees tasks resume seamlessly without executing duplicate side-effects.

2. **Revision-Checked Document Canvas**:
   - Version-tracked document store with optimistic concurrency control.
   - Automatically synchronizes agent artifacts into document pages without overwriting human edits.

3. **Governed Sandboxed Computers**:
   - Container isolation with persistent browser profiles and workspace volumes.
   - Cryptographically derived per-agent credentials ensuring sandboxes never see master secrets.

---

## Verified Security Invariants
- **Strict Free-Only Routing**: Paid endpoints and credit overages are blocked at the engine boundary.
- **Cryptographic Action Approval**: Mutating operations require human authorization bound to exact argument hashes.
- **Quiet Proactivity Protocol**: Heartbeats and scheduled jobs remain completely silent unless critical action is required.
- **Outbound-Only Runner Fleet**: Secure pairing of secondary nodes without opening inbound network ports.

---
*Generated deterministically by Nexora Demo Worker on localhost.*