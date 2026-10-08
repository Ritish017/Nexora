/**
 * Nexora Quiet Heartbeat Monitor
 * 
 * Reuses Perry's quiet proactivity protocol (QUIET = "NOTHING"):
 * When state is unchanged, delivers NOTHING and emits zero notification spam.
 * When alert conditions occur (failed tasks, urgent goals), surfaces actionable notices.
 */

import { createHash } from "node:crypto";
import { QUIET, type GoalRecord } from "./types.ts";
import type { TaskRecord } from "../../runtime/src/index.ts";

export interface HeartbeatState {
  tasks: TaskRecord[];
  goals: GoalRecord[];
}

export interface HeartbeatResult {
  deliver: boolean;
  message: string;
  stateHash: string;
}

export class HeartbeatMonitor {
  private lastStateHash: string | null = null;

  /**
   * Computes a deterministic hash of current system state.
   */
  computeStateHash(state: HeartbeatState): string {
    const summary = {
      taskStatuses: state.tasks.map((t) => `${t.id}:${t.status}`).sort(),
      goalStatuses: state.goals.map((g) => `${g.id}:${g.status}`).sort(),
    };
    return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
  }

  /**
   * Evaluates system state. Remains quiet (QUIET = "NOTHING") if state has not changed.
   */
  evaluate(state: HeartbeatState): HeartbeatResult {
    const currentHash = this.computeStateHash(state);

    // Check for critical failures or urgent attention items
    const failedTasks = state.tasks.filter((t) => t.status === "failed");
    const activeGoals = state.goals.filter((g) => g.status === "active");

    if (failedTasks.length > 0) {
      this.lastStateHash = currentHash;
      return {
        deliver: true,
        message: `Heartbeat Alert: ${failedTasks.length} task(s) failed and need review.`,
        stateHash: currentHash,
      };
    }

    // If state is identical to previous evaluation, stay completely quiet
    if (this.lastStateHash === currentHash) {
      return {
        deliver: false,
        message: QUIET,
        stateHash: currentHash,
      };
    }

    // State changed but is normal
    this.lastStateHash = currentHash;
    return {
      deliver: true,
      message: `System healthy: ${state.tasks.length} tasks registered, ${activeGoals.length} active goals.`,
      stateHash: currentHash,
    };
  }
}
