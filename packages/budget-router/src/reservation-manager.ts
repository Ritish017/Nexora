/**
 * Nexora Reservation Manager
 * 
 * Manages atomic token budget reservations before requests, enforces zero
 * double reservation, double release, and double reconciliation, reconciles
 * actual token usage, and cleanly handles cancellations and timeouts without leaks.
 */

import { randomUUID } from "node:crypto";
import {
  InsufficientBudgetError,
  type ReservationRequest,
  type ReservationRecord,
  type ReservationStatus,
  type UsageReconciliation,
} from "../../contracts/src/budget.ts";

export class DoubleReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoubleReservationError";
  }
}

export class DoubleReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoubleReleaseError";
  }
}

export class DoubleReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoubleReconciliationError";
  }
}

export class ReservationNotFoundError extends Error {
  constructor(reservationId: string) {
    super(`Reservation '${reservationId}' not found.`);
    this.name = "ReservationNotFoundError";
  }
}

export class InvalidReservationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReservationStateError";
  }
}

export interface ReservationManagerOptions {
  maxConcurrentTokens?: number;
  defaultTtlMs?: number;
}

export interface ReserveOptions {
  reservationId?: string;
  ttlMs?: number;
  allowConcurrentForRunTask?: boolean;
}

export class ReservationManager {
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly reconciliations = new Map<string, UsageReconciliation>();
  private readonly activeByRunTask = new Map<string, string>(); // "runId:taskId" -> reservationId
  private activeReservedTokens = 0;
  private totalReconciledTokens = 0;

  private readonly maxConcurrentTokens?: number;
  private readonly defaultTtlMs: number;

  constructor(options: ReservationManagerOptions = {}) {
    this.maxConcurrentTokens = options.maxConcurrentTokens;
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000; // default 60s
  }

  /**
   * Atomically reserve tokens before an execution turn.
   * Prevents double reservation for the same reservation ID or active run/task pair.
   */
  reserve(request: ReservationRequest, options: ReserveOptions = {}): ReservationRecord {
    // 1. Check explicit reservationId collision
    if (options.reservationId && this.reservations.has(options.reservationId)) {
      throw new DoubleReservationError(
        `Double reservation: reservation id '${options.reservationId}' already exists.`
      );
    }

    // 2. Check active reservation collision for this (runId, taskId)
    const runTaskKey = `${request.runId}:${request.taskId}`;
    if (!options.allowConcurrentForRunTask && this.activeByRunTask.has(runTaskKey)) {
      const existingId = this.activeByRunTask.get(runTaskKey)!;
      const existing = this.reservations.get(existingId);
      if (existing && existing.status === "reserved") {
        throw new DoubleReservationError(
          `Double reservation: active reservation '${existingId}' already held for run '${request.runId}' and task '${request.taskId}'.`
        );
      }
    }

    // 3. Calculate tokens needed
    const reservedTokens = request.estimatedInputTokens + request.estimatedOutputTokens;
    if (reservedTokens < 0) {
      throw new Error("Estimated tokens cannot be negative");
    }

    // 4. Check concurrency budget
    if (
      this.maxConcurrentTokens !== undefined &&
      this.activeReservedTokens + reservedTokens > this.maxConcurrentTokens
    ) {
      throw new InsufficientBudgetError(
        `Insufficient token budget: requested ${reservedTokens} tokens, but current active ${this.activeReservedTokens} + ${reservedTokens} exceeds maximum ${this.maxConcurrentTokens}.`
      );
    }

    // 5. Create reservation record
    const id = options.reservationId ?? randomUUID();
    const now = Date.now();
    const expiresAt = now + (options.ttlMs ?? this.defaultTtlMs);

    const record: ReservationRecord = {
      id,
      runId: request.runId,
      taskId: request.taskId,
      modelId: request.modelId,
      reservedTokens,
      status: "reserved",
      createdAt: now,
      expiresAt,
    };

    // 6. Atomic state commit
    this.reservations.set(id, record);
    this.activeReservedTokens += reservedTokens;
    this.activeByRunTask.set(runTaskKey, id);

    return { ...record };
  }

  /**
   * Reconcile actual token consumption upon turn completion.
   * Prevents double reconciliation, reconciling released/expired reservations.
   */
  reconcile(reconciliation: UsageReconciliation): ReservationRecord {
    const record = this.reservations.get(reconciliation.reservationId);
    if (!record) {
      throw new ReservationNotFoundError(reconciliation.reservationId);
    }

    if (record.status === "reconciled") {
      throw new DoubleReconciliationError(
        `Double reconciliation: reservation '${record.id}' has already been reconciled.`
      );
    }

    if (record.status === "released") {
      throw new InvalidReservationStateError(
        `Cannot reconcile released reservation '${record.id}'.`
      );
    }

    if (record.status === "expired") {
      throw new InvalidReservationStateError(
        `Cannot reconcile expired reservation '${record.id}'.`
      );
    }

    // Update state atomically
    record.status = "reconciled";
    this.activeReservedTokens = Math.max(0, this.activeReservedTokens - record.reservedTokens);
    this.totalReconciledTokens += reconciliation.totalTokens;

    const runTaskKey = `${record.runId}:${record.taskId}`;
    if (this.activeByRunTask.get(runTaskKey) === record.id) {
      this.activeByRunTask.delete(runTaskKey);
    }

    this.reconciliations.set(record.id, { ...reconciliation });
    return { ...record };
  }

  /**
   * Release reserved tokens without consumption (e.g. failure, skip).
   * Prevents double release, releasing already reconciled/expired reservations.
   */
  release(reservationId: string, reason?: string): ReservationRecord {
    const record = this.reservations.get(reservationId);
    if (!record) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (record.status === "released") {
      throw new DoubleReleaseError(
        `Double release: reservation '${record.id}' has already been released.`
      );
    }

    if (record.status === "reconciled") {
      throw new InvalidReservationStateError(
        `Cannot release already reconciled reservation '${record.id}'.`
      );
    }

    if (record.status === "expired") {
      throw new InvalidReservationStateError(
        `Cannot release expired reservation '${record.id}'.`
      );
    }

    // Update state atomically
    record.status = "released";
    this.activeReservedTokens = Math.max(0, this.activeReservedTokens - record.reservedTokens);

    const runTaskKey = `${record.runId}:${record.taskId}`;
    if (this.activeByRunTask.get(runTaskKey) === record.id) {
      this.activeByRunTask.delete(runTaskKey);
    }

    return { ...record };
  }

  /**
   * Cancel reservations for a specific reservation ID or runId/taskId scope.
   * Handles cancellation cleanly without leaving leaked reservations or token counts.
   */
  cancel(target: string | { runId?: string; taskId?: string }): ReservationRecord[] {
    const cancelled: ReservationRecord[] = [];

    if (typeof target === "string") {
      // First check if target matches a reservationId directly
      const record = this.reservations.get(target);
      if (record) {
        if (record.status === "reserved") {
          record.status = "released";
          this.activeReservedTokens = Math.max(0, this.activeReservedTokens - record.reservedTokens);
          const runTaskKey = `${record.runId}:${record.taskId}`;
          if (this.activeByRunTask.get(runTaskKey) === record.id) {
            this.activeByRunTask.delete(runTaskKey);
          }
          cancelled.push({ ...record });
        }
        return cancelled;
      }

      // Otherwise treat string as runId or taskId search
      for (const rec of this.reservations.values()) {
        if ((rec.runId === target || rec.taskId === target) && rec.status === "reserved") {
          rec.status = "released";
          this.activeReservedTokens = Math.max(0, this.activeReservedTokens - rec.reservedTokens);
          const runTaskKey = `${rec.runId}:${rec.taskId}`;
          if (this.activeByRunTask.get(runTaskKey) === rec.id) {
            this.activeByRunTask.delete(runTaskKey);
          }
          cancelled.push({ ...rec });
        }
      }
      return cancelled;
    }

    // Target is { runId?, taskId? }
    for (const rec of this.reservations.values()) {
      if (rec.status !== "reserved") continue;

      const runMatch = target.runId ? rec.runId === target.runId : true;
      const taskMatch = target.taskId ? rec.taskId === target.taskId : true;

      if (runMatch && taskMatch) {
        rec.status = "released";
        this.activeReservedTokens = Math.max(0, this.activeReservedTokens - rec.reservedTokens);
        const runTaskKey = `${rec.runId}:${rec.taskId}`;
        if (this.activeByRunTask.get(runTaskKey) === rec.id) {
          this.activeByRunTask.delete(runTaskKey);
        }
        cancelled.push({ ...rec });
      }
    }

    return cancelled;
  }

  /**
   * Scan and expire stale reservations that passed their expiresAt timestamp.
   * Cleanly decrements active reserved tokens so expired reservations don't leak.
   */
  expireStale(now = Date.now()): ReservationRecord[] {
    const expired: ReservationRecord[] = [];

    for (const record of this.reservations.values()) {
      if (record.status === "reserved" && record.expiresAt <= now) {
        record.status = "expired";
        this.activeReservedTokens = Math.max(0, this.activeReservedTokens - record.reservedTokens);
        const runTaskKey = `${record.runId}:${record.taskId}`;
        if (this.activeByRunTask.get(runTaskKey) === record.id) {
          this.activeByRunTask.delete(runTaskKey);
        }
        expired.push({ ...record });
      }
    }

    return expired;
  }

  /**
   * Retrieve a reservation record, checking timeout dynamically.
   */
  getReservation(reservationId: string): ReservationRecord | undefined {
    const record = this.reservations.get(reservationId);
    if (!record) return undefined;

    if (record.status === "reserved" && record.expiresAt <= Date.now()) {
      record.status = "expired";
      this.activeReservedTokens = Math.max(0, this.activeReservedTokens - record.reservedTokens);
      const runTaskKey = `${record.runId}:${record.taskId}`;
      if (this.activeByRunTask.get(runTaskKey) === record.id) {
        this.activeByRunTask.delete(runTaskKey);
      }
    }

    return { ...record };
  }

  /**
   * Retrieve stored reconciliation for a reservation.
   */
  getReconciliation(reservationId: string): UsageReconciliation | undefined {
    const rec = this.reconciliations.get(reservationId);
    return rec ? { ...rec } : undefined;
  }

  /**
   * Current number of actively reserved tokens.
   */
  getActiveReservedTokens(): number {
    return this.activeReservedTokens;
  }

  /**
   * Cumulative number of actual reconciled tokens consumed.
   */
  getTotalReconciledTokens(): number {
    return this.totalReconciledTokens;
  }

  /**
   * List all reservations matching status filter.
   */
  listReservations(status?: ReservationStatus): ReservationRecord[] {
    const all = Array.from(this.reservations.values()).map((r) => ({ ...r }));
    return status ? all.filter((r) => r.status === status) : all;
  }
}
