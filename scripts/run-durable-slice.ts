/**
 * Nexora Phase 1 Durable Task Execution Script
 * 
 * Runs Task #1 against data/nexora.db, saves the verified artifact to
 * artifacts/phase1_verification_report.md, and confirms state recovery on restart.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NexoraDatabase } from "../packages/runtime/src/db.ts";
import { TaskService } from "../packages/runtime/src/task-service.ts";
import { FixtureWorker } from "../packages/runtime/src/fixture-worker.ts";

const dbPath = resolve(process.cwd(), "data", "nexora.db");
const artifactsDir = resolve(process.cwd(), "artifacts");

console.log("=== Nexora Phase 1 Durable Task Execution ===");
console.log(`Database: ${dbPath}`);
console.log(`Artifacts: ${artifactsDir}\n`);

// 1. Initialize DB and Service
const db = new NexoraDatabase(dbPath);
const taskService = new TaskService(db);
const worker = new FixtureWorker("nexora-local-worker", taskService, artifactsDir);

// 2. Submit Task #1
const idempotencyKey = "nexora-milestone-phase1-durable-task";
const { task, isNew } = taskService.submitTask({
  ownerId: "owner-primary",
  projectId: "nexora-default",
  idempotencyKey,
  title: "Phase 1 Durable Baseline Execution & Artifact Verification",
  description: "Durable vertical slice execution validating Perry-backed SQLite task queue, lease fencing, and artifact persistence",
  input: {
    phase: 1,
    environment: "localhost",
    storage: "node:sqlite",
  },
});

console.log(`Task ${task.id} (${isNew ? "NEW" : "EXISTING"}): Status = ${task.status}`);

// 3. Claim Task
let claim = taskService.claimTask("nexora-local-worker", 60000, task.id);
if (!claim && task.status === "completed") {
  console.log("Task already completed in previous run. Re-verifying stored state.");
} else if (!claim) {
  console.error("Failed to claim task!");
  process.exit(1);
} else {
  console.log(`Claimed Run ${claim.run.id} by ${claim.run.claimedBy} with lease expires at ${new Date(claim.run.leaseExpiresAt!).toISOString()}`);

  // 4. Execute Slice
  const { artifact, verification } = await worker.executeSlice(
    claim.run.id,
    claim.task.id,
    "phase1_verification_report.md"
  );

  console.log("\n--- Execution Outcome ---");
  console.log(`Artifact ID: ${artifact.id}`);
  console.log(`Artifact Path: ${artifact.filePath}`);
  console.log(`Artifact SHA-256: ${artifact.sha256}`);
  console.log(`Artifact Size: ${artifact.sizeBytes} bytes`);
  console.log(`Verification: ${verification.verified ? "PASSED" : "FAILED"}`);
  for (const c of verification.checks) {
    console.log(`  [${c.passed ? "✓" : "✗"}] ${c.name}: ${c.message}`);
  }
}

// 5. Close DB and re-open to test restart recovery
db.close();
console.log("\nSimulating runtime shutdown and restart...");

const db2 = new NexoraDatabase(dbPath);
const taskService2 = new TaskService(db2);
const recoveredTask = taskService2.db.getTaskByIdempotencyKey(idempotencyKey);

if (!recoveredTask || recoveredTask.status !== "completed") {
  console.error("Restart recovery failed!");
  process.exit(1);
}

const artifacts = taskService2.db.listArtifactsForTask(recoveredTask.id);
const events = taskService2.db.getEvents(recoveredTask.activeRunId!);

console.log(`Restart Recovery Successful!`);
console.log(`  Recovered Task ID: ${recoveredTask.id} (Status: ${recoveredTask.status})`);
console.log(`  Recovered Artifacts: ${artifacts.length} registered`);
console.log(`  Recovered Monotonic Events: ${events.length} events sequenced`);

db2.close();
console.log("\n=== Phase 1 Milestone Verification Complete ===");
