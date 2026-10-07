/**
 * Nexora Phase 1 Independent Audit Test Suite
 * 
 * Conducts independent verification of:
 * 1. SQLite Document Engine persistence, schema integrity, and document fidelity.
 * 2. Monotonic sequence numbering per run and constraint fencing.
 * 3. Worker lease claims, renewal fencing, and concurrency isolation.
 * 4. Runtime restart recovery, restoring queued tasks, and isolating uncertain mutations.
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NexoraDatabase, generateId } from "../../runtime/src/db.ts";
import { TaskService } from "../../runtime/src/task-service.ts";
import { DatabaseAuditor } from "../src/auditor.ts";
import type { TaskRecord, RunRecord, NormalizedEvent } from "../../runtime/src/types.ts";

test("Phase 1 Audit: SQLite Document Engine Persistence & Schema Integrity", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-audit-p1-db-"));
  const dbPath = join(tempDir, "audit.db");
  const db = new NexoraDatabase(dbPath);
  const auditor = new DatabaseAuditor(db);

  await t.test("1.1 Schema structure, WAL mode, and indices validation", () => {
    const report = auditor.auditSchema();
    assert.strictEqual(report.allValid, true, "All tables and indexes must be present and valid");
    assert.strictEqual(report.tables.tasks, true);
    assert.strictEqual(report.tables.runs, true);
    assert.strictEqual(report.tables.events, true);
    assert.strictEqual(report.tables.approvals, true);
    assert.strictEqual(report.tables.artifacts, true);
    assert.strictEqual(report.journalMode, "wal", "Database must run in WAL journal mode");
    assert.strictEqual(report.foreignKeysValid, true, "Foreign keys must have zero violations");
  });

  await t.test("1.2 Document fidelity and cross-restart persistence", () => {
    const taskService = new TaskService(db);
    const { task } = taskService.submitTask({
      ownerId: "audit-user-1",
      projectId: "audit-project-alpha",
      idempotencyKey: "idemp-audit-101",
      title: "Persistence Audit Task",
      description: "Testing document roundtrip and restart survival",
      input: { nested: { flag: true, count: 42, tags: ["prod", "secure"] } },
    });

    const claim = taskService.claimTask("audit-worker-1", 15000, task.id);
    assert.ok(claim);

    // Save an artifact
    taskService.saveArtifact(
      claim.run.id,
      task.id,
      "audit-evidence.json",
      join(tempDir, "evidence.json"),
      "application/json",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      1024,
      { author: "auditor", verified: true }
    );

    // Close database to simulate complete engine shutdown
    db.close();

    // Reopen database connection
    const dbRecovered = new NexoraDatabase(dbPath);
    const taskRecovered = dbRecovered.getTask(task.id);
    assert.ok(taskRecovered);
    assert.strictEqual(taskRecovered.id, task.id);
    assert.strictEqual(taskRecovered.ownerId, "audit-user-1");
    assert.deepStrictEqual(taskRecovered.input, {
      nested: { flag: true, count: 42, tags: ["prod", "secure"] },
    });

    const runRecovered = dbRecovered.getRun(claim.run.id);
    assert.ok(runRecovered);
    assert.strictEqual(runRecovered.claimedBy, "audit-worker-1");
    assert.strictEqual(runRecovered.status, "running");

    const artifacts = dbRecovered.listArtifactsForTask(task.id);
    assert.strictEqual(artifacts.length, 1);
    assert.strictEqual(artifacts[0].name, "audit-evidence.json");
    assert.strictEqual(artifacts[0].sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    dbRecovered.close();
  });

  await t.test("1.3 Unique constraint protections prevent duplicate corruption", () => {
    const dbTest = new NexoraDatabase(dbPath);
    const task: TaskRecord = {
      id: generateId("task"),
      ownerId: "user-dup",
      projectId: "proj-dup",
      idempotencyKey: "unique-key-999",
      title: "First",
      description: "First",
      input: {},
      status: "queued",
      activeRunId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    dbTest.insertTask(task);

    // Attempting direct raw insertion with duplicate idempotencyKey must throw
    const duplicateTask: TaskRecord = {
      ...task,
      id: generateId("task"),
      title: "Duplicate attempting overwrite",
    };

    assert.throws(
      () => {
        dbTest.insertTask(duplicateTask);
      },
      /UNIQUE constraint failed/,
      "Direct duplicate insert must be rejected by SQLite UNIQUE constraint"
    );

    dbTest.close();
  });

  rmSync(tempDir, { recursive: true, force: true });
});

test("Phase 1 Audit: Monotonic Sequence Numbering and Event Continuity", async (t) => {
  const db = new NexoraDatabase(":memory:");
  const taskService = new TaskService(db);

  await t.test("2.1 Strict monotonic sequence generation per run", () => {
    const { task } = taskService.submitTask({
      ownerId: "user-seq",
      projectId: "proj-seq",
      idempotencyKey: "seq-key-1",
      title: "Monotonic Sequence Test",
      description: "Verifies 1..N sequence without gaps",
    });

    const claim = taskService.claimTask("worker-seq-1", 30000, task.id);
    assert.ok(claim);

    // Initial claim generates event seq: 1 (status_change: queued -> running)
    const runId = claim.run.id;
    for (let i = 2; i <= 20; i++) {
      taskService.emitEvent(runId, "progress", { step: i, progressPct: i * 5 });
    }

    const events = db.getEvents(runId);
    assert.strictEqual(events.length, 20);

    const audit = DatabaseAuditor.auditEventMonotonicity(events);
    assert.strictEqual(audit.valid, true);
    assert.strictEqual(audit.gaps.length, 0);
    assert.strictEqual(audit.duplicateSeq.length, 0);
    assert.strictEqual(events[0].seq, 1);
    assert.strictEqual(events[19].seq, 20);
  });

  await t.test("2.2 Independent monotonic sequences across concurrent runs", () => {
    const { task: taskA } = taskService.submitTask({
      ownerId: "user-seq",
      projectId: "proj-seq",
      idempotencyKey: "seq-key-2a",
      title: "Run A",
      description: "Run A",
    });

    const { task: taskB } = taskService.submitTask({
      ownerId: "user-seq",
      projectId: "proj-seq",
      idempotencyKey: "seq-key-2b",
      title: "Run B",
      description: "Run B",
    });

    const claimA = taskService.claimTask("worker-a", 30000, taskA.id)!;
    const claimB = taskService.claimTask("worker-b", 30000, taskB.id)!;

    taskService.emitEvent(claimA.run.id, "log", { message: "msg A-2" });
    taskService.emitEvent(claimA.run.id, "log", { message: "msg A-3" });

    taskService.emitEvent(claimB.run.id, "log", { message: "msg B-2" });

    const eventsA = db.getEvents(claimA.run.id);
    const eventsB = db.getEvents(claimB.run.id);

    assert.strictEqual(eventsA.length, 3);
    assert.strictEqual(eventsB.length, 2);

    assert.strictEqual(DatabaseAuditor.auditEventMonotonicity(eventsA).valid, true);
    assert.strictEqual(DatabaseAuditor.auditEventMonotonicity(eventsB).valid, true);

    // Verify run B started at 1 and incremented to 2, independent of run A reaching 3
    assert.strictEqual(eventsB[0].seq, 1);
    assert.strictEqual(eventsB[1].seq, 2);
  });

  await t.test("2.3 SQL UNIQUE(runId, seq) constraint prevents manual clobbering", () => {
    const { task } = taskService.submitTask({
      ownerId: "user-seq",
      projectId: "proj-seq",
      idempotencyKey: "seq-key-3",
      title: "Collision Test",
      description: "Collision Test",
    });

    const claim = taskService.claimTask("worker-seq", 30000, task.id)!;
    const runId = claim.run.id;

    // Duplicate event seq insert
    const duplicateEvent: NormalizedEvent = {
      id: generateId("evt"),
      runId,
      seq: 1, // Already used by claim
      type: "log",
      payload: { collision: true },
      timestamp: Date.now(),
    };

    assert.throws(
      () => {
        db.appendEvent(duplicateEvent);
      },
      /UNIQUE constraint failed/,
      "Database must enforce UNIQUE(runId, seq)"
    );
  });

  db.close();
});

test("Phase 1 Audit: Worker Lease Fencing & Concurrency Isolation", async (t) => {
  const db = new NexoraDatabase(":memory:");
  const taskService = new TaskService(db);

  await t.test("3.1 Worker claims task, sets lease expiration, and renews successfully", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-lease",
      projectId: "proj-lease",
      idempotencyKey: "lease-key-1",
      title: "Lease Test Task",
      description: "Testing lease claims and renewal",
    });

    const claim = taskService.claimTask("worker-alpha", 10000, task.id);
    assert.ok(claim);
    assert.strictEqual(claim.run.claimedBy, "worker-alpha");
    assert.ok(claim.run.leaseExpiresAt! > Date.now());

    // Worker alpha renews its lease
    const renewed = taskService.renewLease(claim.run.id, "worker-alpha", 25000);
    assert.strictEqual(renewed, true);

    const runAfterRenew = db.getRun(claim.run.id);
    assert.ok(runAfterRenew!.leaseExpiresAt! > Date.now() + 20000);
  });

  await t.test("3.2 Lease fencing prevents unauthorized renewal by non-holder worker", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-lease",
      projectId: "proj-lease",
      idempotencyKey: "lease-key-2",
      title: "Fencing Test Task",
      description: "Testing unauthorized renewal rejection",
    });

    const claim = taskService.claimTask("worker-alpha", 10000, task.id)!;

    // Impostor worker beta attempts to renew worker alpha's lease
    const renewalByBeta = taskService.renewLease(claim.run.id, "impostor-worker-beta", 30000);
    assert.strictEqual(renewalByBeta, false, "Non-holder renewal must be rejected");

    // Auditor confirms fencing breach rejection
    const fenceAudit = DatabaseAuditor.auditLeaseFencing(
      db.getRun(claim.run.id)!,
      "impostor-worker-beta"
    );
    assert.strictEqual(fenceAudit.canRenew, false);
    assert.strictEqual(fenceAudit.isHolder, false);
    assert.ok(fenceAudit.reason?.includes("not the lease holder"));
  });

  await t.test("3.3 Task in-flight cannot be concurrently claimed by another worker", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-lease",
      projectId: "proj-lease",
      idempotencyKey: "lease-key-3",
      title: "Concurrent Claim Task",
      description: "Testing single active claim invariant",
    });

    const claim1 = taskService.claimTask("worker-1", 10000, task.id);
    assert.ok(claim1);

    // Second worker attempts to claim the same task
    const claim2 = taskService.claimTask("worker-2", 10000, task.id);
    assert.strictEqual(claim2, null, "Already claimed running task cannot be claimed again");
  });

  db.close();
});

test("Phase 1 Audit: Restart Recovery, Queue Restoration, and Uncertain Mutation Quarantine", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-audit-restart-"));
  const dbPath = join(tempDir, "restart.db");

  await t.test("4.1 Startup recovery restores expired/interrupted tasks to queued status", () => {
    const db1 = new NexoraDatabase(dbPath);
    const ts1 = new TaskService(db1);

    // Create and claim a task with an expired lease
    const { task } = ts1.submitTask({
      ownerId: "owner-rec",
      projectId: "proj-rec",
      idempotencyKey: "rec-key-1",
      title: "Interrupted Task",
      description: "Should be recovered to queued",
    });

    const claim = ts1.claimTask("worker-doomed", 1, task.id);
    assert.ok(claim);

    // Simulate clock advancing past lease expiration
    const start = Date.now();
    while (Date.now() - start < 10) {}

    // Simulate sudden process kill (close db without completing run)
    db1.close();

    // System restarts
    const db2 = new NexoraDatabase(dbPath);
    const ts2 = new TaskService(db2);

    const recoveryResult = ts2.recoverOnStartup();
    assert.strictEqual(recoveryResult.recovered, 1);
    assert.strictEqual(recoveryResult.uncertain, 0);

    // Verify task is now queued again and unassigned
    const recoveredTask = db2.getTask(task.id);
    assert.strictEqual(recoveredTask?.status, "queued");
    assert.strictEqual(recoveredTask?.activeRunId, null);

    // Verify interrupted run is marked interrupted
    const interruptedRun = db2.getRun(claim.run.id);
    assert.strictEqual(interruptedRun?.status, "interrupted");
    assert.ok(interruptedRun?.error?.includes("Interrupted by runtime restart"));

    // Verify recovered task can now be successfully picked up and completed by healthy worker
    const claim2 = ts2.claimTask("worker-healthy", 10000, task.id);
    assert.ok(claim2);
    assert.strictEqual(claim2.task.id, task.id);

    ts2.completeRun(claim2.run.id, { recoverySuccess: true });
    assert.strictEqual(db2.getTask(task.id)?.status, "completed");

    db2.close();
  });

  await t.test("4.2 Startup recovery quarantines uncertain mutations and prevents re-execution", () => {
    const db1 = new NexoraDatabase(dbPath);
    const ts1 = new TaskService(db1);

    const { task } = ts1.submitTask({
      ownerId: "owner-rec",
      projectId: "proj-rec",
      idempotencyKey: "rec-uncertain-1",
      title: "Dangerous External Wire Transfer",
      description: "Mutation outcome is ambiguous",
    });

    const claim = ts1.claimTask("worker-financial", 15000, task.id)!;

    // Worker drops connection during mutation and flags uncertain effect
    ts1.flagUncertainEffect(
      claim.run.id,
      "Gateway timeout during external transaction dispatch; status ambiguous"
    );

    // Verify run is immediately uncertain
    const flaggedRun = db1.getRun(claim.run.id)!;
    assert.strictEqual(flaggedRun.status, "uncertain_effect");
    assert.strictEqual(flaggedRun.uncertainEffect, true);

    // Simulate crash / restart
    db1.close();

    const db2 = new NexoraDatabase(dbPath);
    const ts2 = new TaskService(db2);

    // Startup recovery must NOT touch uncertain run and must NOT requeue task
    const recoveryResult = ts2.recoverOnStartup();
    assert.strictEqual(recoveryResult.uncertain, 1);
    assert.strictEqual(recoveryResult.recovered, 0);

    const preservedTask = db2.getTask(task.id);
    // Task must NOT be queued
    assert.notStrictEqual(preservedTask?.status, "queued");

    const preservedRun = db2.getRun(claim.run.id);
    assert.strictEqual(preservedRun?.status, "uncertain_effect");
    assert.strictEqual(preservedRun?.uncertainEffect, true);

    // No worker can claim it without explicit operator intervention
    const newClaim = ts2.claimTask("worker-other");
    assert.strictEqual(newClaim, null, "Quarantined task must never be automatically requeued");

    db2.close();
  });

  rmSync(tempDir, { recursive: true, force: true });
});
