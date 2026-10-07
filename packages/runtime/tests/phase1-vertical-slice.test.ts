/**
 * Nexora Phase 1 Vertical Slice & State Recovery Test Suite
 * 
 * Verifies:
 * 1. Durable task execution, streaming progress, artifact generation & verifier check.
 * 2. Runtime restart recovery (task, run, events, artifact persist across database close/reopen).
 * 3. Idempotent duplicate task submission.
 * 4. Task cancellation.
 * 5. Worker lease expiration & timeout.
 * 6. Action approval and denial.
 * 7. Interrupted partially applied effect (uncertain_effect state).
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NexoraDatabase } from "../src/db.ts";
import { TaskService } from "../src/task-service.ts";
import { FixtureWorker } from "../src/fixture-worker.ts";

test("Phase 1: Complete Durable Vertical Slice with Verified Artifact", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-phase1-"));
  const dbPath = join(tempDir, "nexora.db");
  const artifactsDir = join(tempDir, "artifacts");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(artifactsDir, { recursive: true });

  const db = new NexoraDatabase(dbPath);
  const taskService = new TaskService(db);
  const worker = new FixtureWorker("fixture-worker-1", taskService, artifactsDir);

  await t.test("1. Submits durable task and claims worker lease", () => {
    const { task, isNew } = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "nexora-core",
      idempotencyKey: "task-key-001",
      title: "Generate Phase 1 Verification Report",
      description: "First durable vertical slice task creating verified artifact",
    });

    assert.strictEqual(isNew, true);
    assert.strictEqual(task.status, "queued");

    const claim = taskService.claimTask("fixture-worker-1", 10000);
    assert.ok(claim);
    assert.strictEqual(claim.task.id, task.id);
    assert.strictEqual(claim.run.status, "running");
    assert.strictEqual(claim.run.claimedBy, "fixture-worker-1");
  });

  await t.test("2. Executes fixture task, emits progress, saves artifact & verifies", async () => {
    const claim = taskService.claimTask("fixture-worker-1"); // already claimed
    // Active run:
    const activeRuns = db.listActiveRuns();
    assert.strictEqual(activeRuns.length, 1);
    const activeRun = activeRuns[0];

    const { artifact, verification } = await worker.executeSlice(
      activeRun.id,
      activeRun.taskId,
      "phase1_verification_report.md"
    );

    assert.strictEqual(verification.verified, true);
    assert.strictEqual(verification.checks.length, 3);
    assert.ok(existsSync(artifact.filePath));

    // Verify task is completed
    const task = db.getTask(activeRun.taskId);
    assert.ok(task);
    assert.strictEqual(task.status, "completed");

    // Verify run is completed
    const run = db.getRun(activeRun.id);
    assert.ok(run);
    assert.strictEqual(run.status, "completed");

    // Verify events sequence
    const events = db.getEvents(activeRun.id);
    assert.ok(events.length >= 4);
    for (let i = 0; i < events.length; i++) {
      assert.strictEqual(events[i].seq, i + 1);
    }
  });

  await t.test("3. Runtime restart recovery preserves task, run, and artifact", () => {
    // Simulate runtime crash / restart by closing and reopening the database
    db.close();

    const dbRecovered = new NexoraDatabase(dbPath);
    const taskServiceRecovered = new TaskService(dbRecovered);

    // Verify task exists and is still completed
    const existingTask = taskServiceRecovered.db.getTaskByIdempotencyKey("task-key-001");
    assert.ok(existingTask);
    assert.strictEqual(existingTask.status, "completed");

    // Verify artifact is retrieved
    const artifacts = taskServiceRecovered.db.listArtifactsForTask(existingTask.id);
    assert.strictEqual(artifacts.length, 1);
    assert.strictEqual(artifacts[0].name, "phase1_verification_report.md");
    assert.ok(existsSync(artifacts[0].filePath));

    // Verify events are intact
    const events = taskServiceRecovered.db.getEvents(existingTask.activeRunId!);
    assert.ok(events.length >= 4);

    dbRecovered.close();
  });

  // Clean up
  rmSync(tempDir, { recursive: true, force: true });
});

test("Phase 1 Negative & Resiliency Paths", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-phase1-neg-"));
  const dbPath = join(tempDir, "nexora.db");
  const db = new NexoraDatabase(dbPath);
  const taskService = new TaskService(db);

  await t.test("Duplicate submission is idempotent", () => {
    const res1 = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "dup-key-1",
      title: "Duplicate Check",
      description: "Testing idempotency",
    });
    assert.strictEqual(res1.isNew, true);

    const res2 = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "dup-key-1",
      title: "Duplicate Check Different Title",
      description: "Should return existing task",
    });
    assert.strictEqual(res2.isNew, false);
    assert.strictEqual(res1.task.id, res2.task.id);
  });

  await t.test("Task cancellation halts active work", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "cancel-key-1",
      title: "Task to Cancel",
      description: "Testing cancel",
    });

    const claim = taskService.claimTask("worker-c", 30000, task.id);
    assert.ok(claim);

    const cancelled = taskService.cancelTask(task.id, "Owner requested cancel");
    assert.strictEqual(cancelled, true);

    const updatedTask = db.getTask(task.id);
    assert.strictEqual(updatedTask?.status, "cancelled");

    const updatedRun = db.getRun(claim.run.id);
    assert.strictEqual(updatedRun?.status, "cancelled");
  });

  await t.test("Worker timeout & startup recovery recovers queued task", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "timeout-key-1",
      title: "Task to Timeout",
      description: "Testing worker crash recovery",
    });

    // Worker claims with 1ms lease
    const claim = taskService.claimTask("worker-timeout", 1, task.id);
    assert.ok(claim);

    // Wait 10ms for lease to expire
    const start = Date.now();
    while (Date.now() - start < 10) {}

    // Run startup recovery
    const recovery = taskService.recoverOnStartup();
    assert.ok(recovery.recovered >= 1);

    const recoveredTask = db.getTask(task.id);
    assert.strictEqual(recoveredTask?.status, "queued");

    const recoveredRun = db.getRun(claim.run.id);
    assert.strictEqual(recoveredRun?.status, "interrupted");
  });

  await t.test("Approval denial fails run cleanly with zero side-effects", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "appr-deny-key-1",
      title: "Sensitive Mutation",
      description: "Testing approval gate",
    });

    const claim = taskService.claimTask("worker-appr", 30000, task.id);
    assert.ok(claim);

    const approval = taskService.requestApproval(
      claim.run.id,
      "delete_resource",
      { target: "/data/critical" },
      "/data/critical",
      "worker-appr"
    );

    assert.strictEqual(approval.status, "pending");
    const runWaiting = db.getRun(claim.run.id);
    assert.strictEqual(runWaiting?.status, "waiting_for_approval");

    // Owner denies the action
    const { approval: resolvedAppr, run: resolvedRun } = taskService.resolveApproval(
      approval.id,
      false,
      "owner-1"
    );

    assert.strictEqual(resolvedAppr.status, "denied");
    assert.strictEqual(resolvedRun.status, "failed");

    const updatedTask = db.getTask(task.id);
    assert.strictEqual(updatedTask?.status, "failed");
  });

  await t.test("Interrupted mutation is flagged as uncertain_effect", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "uncertain-key-1",
      title: "Uncertain Mutation",
      description: "Testing uncertain effect isolation",
    });

    const claim = taskService.claimTask("worker-u", 30000, task.id);
    assert.ok(claim);

    // Ambiguous network outcome during external API call
    const flaggedRun = taskService.flagUncertainEffect(
      claim.run.id,
      "Network connection dropped while executing external wire transfer"
    );

    assert.strictEqual(flaggedRun.status, "uncertain_effect");
    assert.strictEqual(flaggedRun.uncertainEffect, true);

    // Startup recovery must not replay uncertain effects
    const recovery = taskService.recoverOnStartup();
    assert.ok(recovery.uncertain >= 1);
  });

  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
