/**
 * Nexora Outbound Runner Client
 * 
 * Pairs with coordinator, claims durable tasks under lease fencing,
 * reports progress outbound, and handles lease loss / revocation.
 */

import type { FleetManager } from "./fleet-manager.ts";
import type { TaskService, TaskRecord, RunRecord } from "../../runtime/src/index.ts";

export class RunnerClient {
  readonly runnerId: string;
  readonly token: string;
  readonly fleetManager: FleetManager;
  readonly taskService: TaskService;
  private activeRunId: string | null = null;

  constructor(options: {
    runnerId: string;
    token: string;
    fleetManager: FleetManager;
    taskService: TaskService;
  }) {
    this.runnerId = options.runnerId;
    this.token = options.token;
    this.fleetManager = options.fleetManager;
    this.taskService = options.taskService;
  }

  /**
   * Heartbeat check-in with fleet manager.
   */
  heartbeat(): boolean {
    try {
      this.fleetManager.checkIn({ token: this.token });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attempts to claim the next eligible queued task under worker lease.
   */
  claimNextTask(leaseDurationMs: number = 30000): { task: TaskRecord; run: RunRecord } | null {
    // 1. Authenticate runner token before accepting work
    this.fleetManager.authenticate(this.token);

    // 2. Claim task from durable task service
    const claim = this.taskService.claimTask(this.runnerId, leaseDurationMs);
    if (!claim) return null;

    this.activeRunId = claim.run.id;
    return claim;
  }

  /**
   * Renews current lease. Returns false if lease expired or was stolen by another worker.
   */
  renewActiveLease(durationMs: number = 30000): boolean {
    if (!this.activeRunId) return false;

    // Verify token validity
    try {
      this.fleetManager.authenticate(this.token);
    } catch {
      return false;
    }

    return this.taskService.renewLease(this.activeRunId, this.runnerId, durationMs);
  }

  /**
   * Reports execution progress event.
   * Enforces lease fencing: if lease was lost, throws error and prevents event commitment.
   */
  reportProgress(percent: number, message: string): void {
    if (!this.activeRunId) throw new Error("No active run to report progress for.");

    // Fencing check: verify runner is still lease holder
    const run = this.taskService.db.getRun(this.activeRunId);
    if (!run || run.claimedBy !== this.runnerId) {
      throw new Error(`Lease fencing violation: worker '${this.runnerId}' is not the current lease holder.`);
    }

    if (run.leaseExpiresAt && Date.now() > run.leaseExpiresAt) {
      throw new Error(`Lease expired for run '${this.activeRunId}'; worker is fenced out.`);
    }

    this.taskService.emitEvent(this.activeRunId, "progress", {
      percent,
      message,
      workerId: this.runnerId,
    });
  }

  /**
   * Completes the active run and saves final output.
   * Enforces lease fencing: rejects if lease was lost.
   */
  completeTask(output: Record<string, unknown>): void {
    if (!this.activeRunId) throw new Error("No active run to complete.");

    // Fencing check
    const run = this.taskService.db.getRun(this.activeRunId);
    if (!run || run.claimedBy !== this.runnerId) {
      throw new Error(`Lease fencing violation: worker '${this.runnerId}' cannot complete run claimed by another worker.`);
    }

    if (run.leaseExpiresAt && Date.now() > run.leaseExpiresAt) {
      throw new Error(`Lease expired for run '${this.activeRunId}'; cannot commit side-effects.`);
    }

    this.taskService.completeRun(this.activeRunId, output);
    this.activeRunId = null;
  }
}
