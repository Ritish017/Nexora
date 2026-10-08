/**
 * Nexora Schedule Runner
 * 
 * Manages recurring jobs and one-shot reminders with Asia/Kolkata timezone default.
 * Enforces idempotent task submission to prevent duplicate execution across ticks.
 */

import type { ScheduledJob } from "./types.ts";
import type { TaskService, TaskRecord } from "../../runtime/src/index.ts";

export class ScheduleRunner {
  readonly taskService: TaskService;
  readonly defaultTimezone: string;
  private readonly jobs: Map<string, ScheduledJob> = new Map();

  constructor(taskService: TaskService, defaultTimezone: string = "Asia/Kolkata") {
    this.taskService = taskService;
    this.defaultTimezone = defaultTimezone;
  }

  /**
   * Registers a scheduled job.
   */
  registerJob(job: Omit<ScheduledJob, "timezone"> & { timezone?: string }): ScheduledJob {
    const fullJob: ScheduledJob = {
      ...job,
      timezone: job.timezone ?? this.defaultTimezone,
    };
    this.jobs.set(fullJob.id, fullJob);
    return fullJob;
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Computes deterministic slot timestamp (e.g. rounded to minute) for idempotency key.
   */
  computeSlotTimestamp(timestamp: number, intervalMs: number = 60000): number {
    return Math.floor(timestamp / intervalMs) * intervalMs;
  }

  /**
   * Triggers a job execution for the given time slot.
   * Uses idempotent task submission: job_{jobId}_{slotTimestamp}.
   */
  triggerJob(
    jobId: string,
    now: number = Date.now()
  ): { task: TaskRecord; isNew: boolean } | null {
    const job = this.jobs.get(jobId);
    if (!job || !job.enabled) return null;

    const slot = this.computeSlotTimestamp(now, job.intervalMs ?? 60000);
    const idempotencyKey = `job_${job.id}_slot_${slot}`;

    const submission = this.taskService.submitTask({
      title: `Scheduled: ${job.name}`,
      description: job.prompt,
      ownerId: "system",
      projectId: "scheduled-jobs",
      idempotencyKey,
      input: {
        jobId: job.id,
        scheduledAt: slot,
        timezone: job.timezone,
      },
    });

    job.lastRunAt = now;
    return submission;
  }
}
