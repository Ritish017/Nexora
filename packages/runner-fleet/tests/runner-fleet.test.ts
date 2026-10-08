import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NexoraDatabase, TaskService } from "../../runtime/src/index.ts";
import { FleetManager, RunnerClient } from "../src/index.ts";

describe("Phase 6: Outbound Runner Pairing & Revocable Tokens", () => {
  const fleet = new FleetManager();

  it("mints short-lived pairing code and redeems it for runner token", () => {
    const pairing = fleet.mintPairingCode("macbook-worker", 60000);
    assert.ok(pairing.code);
    assert.equal(pairing.used, false);
    assert.equal(pairing.runnerName, "macbook-worker");

    const redeemed = fleet.redeemPairingCode(pairing.code, {
      platform: "darwin-arm64",
      hostname: "macbook-pro.local",
      policy: "supervised",
    });

    assert.ok(redeemed.token.startsWith("rn_"));
    assert.equal(redeemed.runner.name, "macbook-worker");
    assert.equal(redeemed.runner.platform, "darwin-arm64");
    assert.equal(redeemed.runner.revoked, false);

    // Cannot redeem twice
    assert.throws(
      () => fleet.redeemPairingCode(pairing.code),
      /already been redeemed/
    );
  });

  it("rejects expired pairing codes", () => {
    const pairing = fleet.mintPairingCode("expired-worker", -1000);
    assert.throws(
      () => fleet.redeemPairingCode(pairing.code),
      /has expired/
    );
  });

  it("authenticates valid runner token and tracks heartbeat check-in", () => {
    const pairing = fleet.mintPairingCode("linux-runner");
    const { runner, token } = fleet.redeemPairingCode(pairing.code, {
      platform: "linux-x64",
      hostname: "worker-node-1",
    });

    const authed = fleet.authenticate(token);
    assert.equal(authed.id, runner.id);

    const checkedIn = fleet.checkIn({ token, hostname: "worker-node-1-renamed" });
    assert.equal(checkedIn.hostname, "worker-node-1-renamed");
    assert.ok(checkedIn.lastSeenAt >= runner.lastSeenAt);
  });

  it("revokes runner token immediately and blocks subsequent authentication", () => {
    const pairing = fleet.mintPairingCode("revokable-runner");
    const { runner, token } = fleet.redeemPairingCode(pairing.code);

    assert.ok(fleet.authenticate(token));

    fleet.revokeRunner(runner.id);

    assert.throws(
      () => fleet.authenticate(token),
      /has been revoked/
    );
  });

  it("detects stale runners whose heartbeat has timed out", () => {
    const pairing = fleet.mintPairingCode("stale-runner");
    const { runner } = fleet.redeemPairingCode(pairing.code);
    runner.lastSeenAt = Date.now() - 120000; // 2 minutes ago

    const stale = fleet.getStaleRunners(60000); // 1 min threshold
    assert.ok(stale.some((r) => r.id === runner.id));
  });
});

describe("Phase 6: Outbound Task Execution & Lease Fencing Integrity", () => {
  let tempDir: string;
  let db: NexoraDatabase;
  let taskService: TaskService;
  let fleet: FleetManager;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-fleet-test-"));
    db = new NexoraDatabase(join(tempDir, "fleet.db"));
    taskService = new TaskService(db);
    fleet = new FleetManager();
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("paired runner claims task, reports progress, and completes execution", () => {
    const pairing = fleet.mintPairingCode("active-runner-1");
    const { runner, token } = fleet.redeemPairingCode(pairing.code);

    const client = new RunnerClient({
      runnerId: runner.id,
      token,
      fleetManager: fleet,
      taskService,
    });

    // Submit task to queue
    const { task } = taskService.submitTask({
      title: "Audio Transcription",
      description: "Transcribe meeting audio recording",
      ownerId: "owner-alice",
      projectId: "default",
      idempotencyKey: "audio-transcribe-1",
    });

    // Claim next task
    const claimed = client.claimNextTask(10000);
    assert.ok(claimed);
    assert.equal(claimed.task.id, task.id);
    assert.equal(claimed.run.claimedBy, runner.id);

    // Report progress
    client.reportProgress(50, "Transcribing segment 1 of 2...");
    const events = db.getEvents(claimed.run.id);
    const progressEvent = events.find((e) => e.type === "progress");
    assert.ok(progressEvent);
    assert.equal((progressEvent.payload as any).percent, 50);

    // Complete task
    client.completeTask({ transcript: "Hello world" });
    const completedRun = db.getRun(claimed.run.id);
    assert.equal(completedRun?.status, "completed");
  });

  it("revoked runner cannot claim any tasks", () => {
    const pairing = fleet.mintPairingCode("to-be-revoked");
    const { runner, token } = fleet.redeemPairingCode(pairing.code);

    taskService.submitTask({
      title: "Queued Task",
      description: "Should not be claimed by revoked runner",
      ownerId: "owner-alice",
      projectId: "default",
      idempotencyKey: "queued-task-revoked-test",
    });

    fleet.revokeRunner(runner.id);

    const client = new RunnerClient({
      runnerId: runner.id,
      token,
      fleetManager: fleet,
      taskService,
    });

    assert.throws(
      () => client.claimNextTask(10000),
      /has been revoked/
    );
  });

  it("enforces lease fencing when a worker's lease is lost or expired", () => {
    const pairingA = fleet.mintPairingCode("worker-a");
    const { runner: runnerA, token: tokenA } = fleet.redeemPairingCode(pairingA.code);

    const clientA = new RunnerClient({
      runnerId: runnerA.id,
      token: tokenA,
      fleetManager: fleet,
      taskService,
    });

    taskService.submitTask({
      title: "Fenced Task",
      description: "Task to test lease fencing race conditions",
      ownerId: "owner-alice",
      projectId: "default",
      idempotencyKey: "fenced-task-idem",
    });

    // Worker A claims task with short 100ms lease
    const claimed = clientA.claimNextTask(100);
    assert.ok(claimed);

    // Simulate Worker B stealing/reclaiming expired lease
    const run = db.getRun(claimed.run.id)!;
    run.claimedBy = "worker-b-thief"; // stolen by another worker
    db.updateRun(run);

    // Worker A tries to report progress -> MUST fail lease fencing!
    assert.throws(
      () => clientA.reportProgress(80, "Still working..."),
      /Lease fencing violation/
    );

    // Worker A tries to complete task -> MUST fail lease fencing!
    assert.throws(
      () => clientA.completeTask({ result: "done" }),
      /Lease fencing violation/
    );
  });
});
