import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NexoraDatabase, TaskService } from "../packages/runtime/src/index.ts";
import { GeminiEngine } from "../packages/provider-engine/src/index.ts";
import { BudgetRouter } from "../packages/budget-router/src/index.ts";

describe("Demo Flow Verification: Submission, Approvals, Output & Restart Persistence", () => {
  let tempDir: string;
  let dbPath: string;
  let db: NexoraDatabase;
  let taskService: TaskService;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-demo-test-"));
    dbPath = join(tempDir, "demo.db");
    db = new NexoraDatabase(dbPath);
    taskService = new TaskService(db);
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("submits demo task, triggers approval request, resolves approval, and verifies deterministic demo artifact", () => {
    // 1. Submit demo task
    const submission = taskService.submitTask({
      title: "Create a short introduction to Nexora.",
      description: "Demonstrate local demo mode without API keys",
      ownerId: "local-owner",
      projectId: "demo-test",
      idempotencyKey: "demo-intro-key",
      input: { mode: "demo", requireApproval: true },
    });

    assert.equal(submission.task.status, "queued");
    assert.equal(submission.isNew, true);

    // 2. Claim task by demo worker
    const claim = taskService.claimTask("worker-local-demo", 60000, submission.task.id);
    assert.ok(claim);
    const runId = claim.run.id;

    // 3. Emit item started and progress
    taskService.emitEvent(runId, "item_started", {
      item: "demo_turn",
      label: "Starting Local Demo execution...",
    });
    taskService.emitEvent(runId, "progress", {
      percent: 30,
      message: "Compiling deterministic introduction content...",
    });

    // 4. Worker requests approval before mutating artifact file
    const approval = taskService.requestApproval(
      runId,
      "files_write",
      { path: "artifacts/nexora_intro_demo.md" },
      "workspace://artifacts/nexora_intro_demo.md",
      "worker-local-demo",
      "1.0.0",
      60000
    );

    const runWaiting = db.getRun(runId);
    assert.equal(runWaiting?.status, "waiting_for_approval");

    // 5. Owner resolves approval
    const resolved = taskService.resolveApproval(approval.id, true, "owner-tester");
    assert.equal(resolved.approval.status, "approved");
    assert.equal(resolved.run.status, "running");

    // 6. Complete task with deterministic demo output
    const demoContent = "# [LOCAL DEMO] Introduction to Nexora\nDeterministic output.";
    const art = taskService.saveArtifact(
      runId,
      submission.task.id,
      "nexora_intro_demo.md",
      join(tempDir, "nexora_intro_demo.md"),
      "text/markdown",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      Buffer.byteLength(demoContent)
    );

    taskService.completeRun(runId, {
      mode: "local-demo",
      artifactId: art.id,
      summary: "Created deterministic introduction to Nexora",
    });

    const runCompleted = db.getRun(runId);
    assert.equal(runCompleted?.status, "completed");

    const taskCompleted = db.getTask(submission.task.id);
    assert.equal(taskCompleted?.status, "completed");
  });

  it("verifies persistence after database restart", () => {
    // Close original connection to simulate server shutdown
    db.close();

    // Reopen database from disk to simulate server boot
    const reopenedDb = new NexoraDatabase(dbPath);
    try {
      const tasks = reopenedDb.listTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].title, "Create a short introduction to Nexora.");
      assert.equal(tasks[0].status, "completed");

      const runId = tasks[0].activeRunId!;
      const run = reopenedDb.getRun(runId);
      assert.ok(run);
      assert.equal(run.status, "completed");

      const events = reopenedDb.getEvents(runId);
      assert.ok(events.length >= 4);
      // Strictly monotonic sequencing verified across restart
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].seq, i + 1);
      }

      const artifacts = reopenedDb.listArtifactsForTask(tasks[0].id);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].name, "nexora_intro_demo.md");
    } finally {
      reopenedDb.close();
    }
  });

  it("strictly isolates real AI mode and never substitutes demo output on failure", async () => {
    // Engine without API key should never fall back to fake or demo text
    const unauthenticatedEngine = new GeminiEngine({ apiKey: "" });
    const status = await unauthenticatedEngine.status();
    assert.equal(status.signedIn, false);

    const outcome = await unauthenticatedEngine.runTurn(
      {
        prompt: "Create a short introduction to Nexora.",
        instructions: "You are Nexora.",
        cwd: process.cwd(),
        access: "workspace",
      },
      {
        onSession: () => {},
        onEvent: () => {},
        onRequest: async () => "decline",
      }
    );

    assert.equal(outcome.outcome, "failed");
    assert.match(outcome.error!, /GEMINI_API_KEY/);
    // Explicit check: never returns demo introduction text when real AI mode is invoked
    assert.ok(!outcome.text.includes("Nexora is an autonomous sovereign personal agent"));
  });
});
