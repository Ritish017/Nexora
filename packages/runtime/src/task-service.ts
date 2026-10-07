/**
 * Nexora Task Service & Run Lifecycle Coordinator
 * 
 * Implements durable task queuing, lease claims, monotonic event streams,
 * approval gating, cancellation, and restart recovery.
 */

import { createHash } from "node:crypto";
import { NexoraDatabase, generateId } from "./db.ts";
import type {
  TaskRecord,
  RunRecord,
  NormalizedEvent,
  ApprovalRecord,
  ArtifactRecord,
  RunStatus
} from "./types.ts";

export interface SubmitTaskInput {
  ownerId: string;
  projectId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  input?: Record<string, unknown>;
}

export class TaskService {
  readonly db: NexoraDatabase;

  constructor(db: NexoraDatabase) {
    this.db = db;
  }

  /**
   * Submits a task idempotently.
   * If a task with the given idempotencyKey exists, returns it without creating a duplicate.
   */
  submitTask(input: SubmitTaskInput): { task: TaskRecord; isNew: boolean } {
    const existing = this.db.getTaskByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { task: existing, isNew: false };
    }

    const now = Date.now();
    const task: TaskRecord = {
      id: generateId("task"),
      ownerId: input.ownerId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      description: input.description,
      input: input.input ?? {},
      status: "queued",
      activeRunId: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insertTask(task);
    return { task, isNew: true };
  }

  /**
   * Claims a queued task for execution by a worker.
   * If taskId is supplied, claims that specific task; otherwise claims the first queued task.
   * Assigns a lease with expiration.
   */
  claimTask(
    workerId: string,
    leaseDurationMs: number = 30000,
    taskId?: string
  ): { task: TaskRecord; run: RunRecord } | null {
    let task: TaskRecord | null = null;
    if (taskId) {
      const candidate = this.db.getTask(taskId);
      if (candidate && candidate.status === "queued") {
        task = candidate;
      }
    } else {
      const queuedTasks = this.db.listQueuedTasks();
      if (queuedTasks.length > 0) {
        task = queuedTasks[0];
      }
    }

    if (!task) return null;
    const now = Date.now();
    const runId = generateId("run");

    const run: RunRecord = {
      id: runId,
      taskId: task.id,
      agentId: workerId,
      status: "running",
      claimedBy: workerId,
      leaseExpiresAt: now + leaseDurationMs,
      sessionCursor: null,
      uncertainEffect: false,
      uncertainReason: null,
      startedAt: now,
      endedAt: null,
      output: null,
      error: null,
    };

    this.db.insertRun(run);

    task.status = "running";
    task.activeRunId = runId;
    this.db.updateTask(task);

    this.emitEvent(run.id, "status_change", {
      from: "queued",
      to: "running",
      workerId,
      leaseExpiresAt: run.leaseExpiresAt,
    });

    return { task, run };
  }

  /**
   * Renews worker lease before expiration.
   */
  renewLease(runId: string, workerId: string, durationMs: number = 30000): boolean {
    const run = this.db.getRun(runId);
    if (!run || run.status !== "running" || run.claimedBy !== workerId) {
      return false;
    }

    run.leaseExpiresAt = Date.now() + durationMs;
    this.db.updateRun(run);
    return true;
  }

  /**
   * Emits a normalized event with a strictly monotonic sequence number.
   */
  emitEvent(
    runId: string,
    type: NormalizedEvent["type"],
    payload: Record<string, unknown>
  ): NormalizedEvent {
    const seq = this.db.getNextEventSeq(runId);
    const event: NormalizedEvent = {
      id: generateId("evt"),
      runId,
      seq,
      type,
      payload,
      timestamp: Date.now(),
    };

    this.db.appendEvent(event);
    return event;
  }

  /**
   * Requests owner approval for a sensitive mutation.
   * Pauses the run in `waiting_for_approval`.
   */
  requestApproval(
    runId: string,
    action: string,
    args: Record<string, unknown>,
    resource: string,
    actor: string,
    policyVersion: string = "1.0",
    ttlMs: number = 60000
  ): ApprovalRecord {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const now = Date.now();

    const approval: ApprovalRecord = {
      id: generateId("appr"),
      runId,
      action,
      argumentsHash: argsHash,
      resource,
      actor,
      policyVersion,
      expiry: now + ttlMs,
      status: "pending",
      decisionBy: null,
      decisionAt: null,
    };

    this.db.insertApproval(approval);

    run.status = "waiting_for_approval";
    this.db.updateRun(run);

    this.emitEvent(runId, "approval_requested", {
      approvalId: approval.id,
      action,
      argumentsHash: argsHash,
      resource,
      expiry: approval.expiry,
    });

    return approval;
  }

  /**
   * Resolves a pending approval with approved or denied decision.
   */
  resolveApproval(
    approvalId: string,
    approved: boolean,
    decidedBy: string
  ): { approval: ApprovalRecord; run: RunRecord } {
    const approval = this.db.getApproval(approvalId);
    if (!approval) throw new Error(`Approval ${approvalId} not found`);
    if (approval.status !== "pending") throw new Error(`Approval is already ${approval.status}`);

    const now = Date.now();
    if (now > approval.expiry) {
      approval.status = "expired";
      this.db.updateApproval(approval);
      throw new Error("Approval token expired");
    }

    approval.status = approved ? "approved" : "denied";
    approval.decisionBy = decidedBy;
    approval.decisionAt = now;
    this.db.updateApproval(approval);

    const run = this.db.getRun(approval.runId);
    if (!run) throw new Error(`Run ${approval.runId} not found`);

    if (approved) {
      run.status = "running";
    } else {
      run.status = "failed";
      run.error = `Action '${approval.action}' denied by ${decidedBy}`;
      run.endedAt = now;

      const task = this.db.getTask(run.taskId);
      if (task) {
        task.status = "failed";
        this.db.updateTask(task);
      }
    }
    this.db.updateRun(run);

    this.emitEvent(run.id, "approval_resolved", {
      approvalId,
      status: approval.status,
      decisionBy: decidedBy,
    });

    return { approval, run };
  }

  /**
   * Records a saved artifact associated with a run and task.
   */
  saveArtifact(
    runId: string,
    taskId: string,
    name: string,
    filePath: string,
    contentType: string,
    sha256: string,
    sizeBytes: number,
    metadata: Record<string, unknown> = {}
  ): ArtifactRecord {
    const artifact: ArtifactRecord = {
      id: generateId("art"),
      runId,
      taskId,
      name,
      filePath,
      contentType,
      sha256,
      sizeBytes,
      createdAt: Date.now(),
      metadata,
    };

    this.db.insertArtifact(artifact);
    this.emitEvent(runId, "artifact_saved", {
      artifactId: artifact.id,
      name: artifact.name,
      sha256: artifact.sha256,
      filePath: artifact.filePath,
    });

    return artifact;
  }

  /**
   * Completes a run and updates parent task status to completed.
   */
  completeRun(runId: string, output: Record<string, unknown> = {}): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const now = Date.now();
    run.status = "completed";
    run.endedAt = now;
    run.output = output;
    this.db.updateRun(run);

    const task = this.db.getTask(run.taskId);
    if (task) {
      task.status = "completed";
      this.db.updateTask(task);
    }

    this.emitEvent(runId, "status_change", { from: "running", to: "completed", output });
    return run;
  }

  /**
   * Fails a run and updates parent task status to failed.
   */
  failRun(runId: string, error: string): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const now = Date.now();
    run.status = "failed";
    run.endedAt = now;
    run.error = error;
    this.db.updateRun(run);

    const task = this.db.getTask(run.taskId);
    if (task) {
      task.status = "failed";
      this.db.updateTask(task);
    }

    this.emitEvent(runId, "status_change", { from: run.status, to: "failed", error });
    return run;
  }

  /**
   * Cancels a task and any active run.
   */
  cancelTask(taskId: string, reason: string = "User cancelled"): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;

    task.status = "cancelled";
    this.db.updateTask(task);

    if (task.activeRunId) {
      const run = this.db.getRun(task.activeRunId);
      if (run && (run.status === "running" || run.status === "waiting_for_approval")) {
        run.status = "cancelled";
        run.error = reason;
        run.endedAt = Date.now();
        this.db.updateRun(run);
        this.emitEvent(run.id, "status_change", { to: "cancelled", reason });
      }
    }

    return true;
  }

  /**
   * Flags an uncertain effect when a mutation status cannot be verified after interruption.
   */
  flagUncertainEffect(runId: string, reason: string): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    run.status = "uncertain_effect";
    run.uncertainEffect = true;
    run.uncertainReason = reason;
    this.db.updateRun(run);

    this.emitEvent(runId, "status_change", {
      to: "uncertain_effect",
      uncertainReason: reason,
    });

    return run;
  }

  /**
   * Startup Recovery:
   * Inspects active runs left in running/waiting states.
   * If lease expired or runtime abruptly terminated:
   * - Interrupted runs without uncertain mutations are safely set to 'interrupted' and task reset to 'queued'.
   * - Interrupted runs with potential unverified mutations are flagged as 'uncertain_effect'.
   */
  recoverOnStartup(): { recovered: number; uncertain: number } {
    const activeRuns = this.db.listActiveRuns();
    const now = Date.now();
    let recovered = 0;
    let uncertain = 0;

    for (const run of activeRuns) {
      if (run.uncertainEffect) {
        uncertain++;
        continue;
      }

      // If lease is expired or server restarted while running
      const isExpired = run.leaseExpiresAt !== null && run.leaseExpiresAt < now;
      if (isExpired || run.status === "running") {
        // Safe recovery: reset to interrupted and requeue task
        run.status = "interrupted";
        run.error = "Interrupted by runtime restart or worker lease expiration";
        run.endedAt = now;
        this.db.updateRun(run);

        const task = this.db.getTask(run.taskId);
        if (task && task.status === "running") {
          task.status = "queued";
          task.activeRunId = null;
          this.db.updateTask(task);
        }

        this.emitEvent(run.id, "status_change", {
          to: "interrupted",
          reason: run.error,
        });

        recovered++;
      }
    }

    return { recovered, uncertain };
  }
}
