/**
 * Nexora Budget Router, Reservation Manager & Backoff Scheduler Test Suite
 * 
 * Verifies:
 * 1. ModelRegistry default gemini-3.8-flash registration and capabilities.
 * 2. BudgetRouter free-only policy enforcement (rejecting paid models, unknown pricing, zero paid fallback).
 * 3. ReservationManager atomic lifecycle, double reservation/release/reconciliation prevention,
 *    and cancellation/timeout clean-up without leaks.
 * 4. BackoffScheduler 429 Retry-After parsing, bounded jittered exponential backoff,
 *    scheduled retry timestamps, and non-busy-wait sleep.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DisallowedPaidEndpointError,
  InsufficientBudgetError,
} from "../../contracts/src/budget.ts";
import type { ModelRegistration } from "../../contracts/src/provider.ts";

import {
  ModelRegistry,
  GEMINI_3_8_FLASH,
  BudgetRouter,
  ReservationManager,
  DoubleReservationError,
  DoubleReleaseError,
  DoubleReconciliationError,
  InvalidReservationStateError,
  ReservationNotFoundError,
  BackoffScheduler,
} from "../src/index.ts";

test("ModelRegistry: Verified Free Model Catalog", async (t) => {
  await t.test("contains gemini-3.8-flash with required specification", () => {
    const registry = new ModelRegistry();
    const model = registry.get("gemini-3.8-flash");

    assert.ok(model, "gemini-3.8-flash should be registered by default");
    assert.equal(model.id, "gemini-3.8-flash");
    assert.equal(model.priceClass, "free");
    assert.equal(model.entitlement, "verified_free");
    assert.equal(model.protocol, "gemini-rest");
    assert.equal(model.capabilities.functionCalling, true);
    assert.equal(model.capabilities.structuredOutput, true);
    assert.equal(model.capabilities.vision, true);
    assert.equal(model.capabilities.thinking, true);
    assert.equal(model.capabilities.maxInputTokens, 1048576);
    assert.equal(model.capabilities.maxOutputTokens, 65536);
  });

  await t.test("filters free models and capable models accurately", () => {
    const registry = new ModelRegistry();
    const paidModel: ModelRegistration = {
      id: "claude-3-5-sonnet",
      provider: "anthropic",
      displayName: "Claude 3.5 Sonnet",
      protocol: "openai-compatible",
      priceClass: "paid",
      entitlement: "paid_active",
      capabilities: {
        functionCalling: true,
        structuredOutput: true,
        vision: true,
        thinking: true,
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
      },
    };
    registry.register(paidModel);

    const freeModels = registry.listFree();
    assert.equal(freeModels.length, 1);
    assert.equal(freeModels[0].id, "gemini-3.8-flash");

    const capable = registry.findCapable({ maxInputTokens: 500000 });
    assert.equal(capable.length, 1);
    assert.equal(capable[0].id, "gemini-3.8-flash");
  });
});

test("BudgetRouter: Free-Only Enforcement & Zero Paid Fallback", async (t) => {
  const registry = new ModelRegistry();

  const paidModel: ModelRegistration = {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    protocol: "openai-compatible",
    priceClass: "paid",
    entitlement: "paid_active",
    capabilities: {
      functionCalling: true,
      structuredOutput: true,
      vision: true,
      thinking: false,
      maxInputTokens: 128000,
      maxOutputTokens: 4096,
    },
  };

  const unverifiedModel: ModelRegistration = {
    id: "experimental-free-unverified",
    provider: "google",
    displayName: "Experimental Free",
    protocol: "gemini-rest",
    priceClass: "free",
    entitlement: "unverified",
    capabilities: {
      functionCalling: false,
      structuredOutput: false,
      vision: false,
      thinking: false,
      maxInputTokens: 32000,
      maxOutputTokens: 2048,
    },
  };

  registry.register(paidModel);
  registry.register(unverifiedModel);

  const router = new BudgetRouter(registry);

  await t.test("enforces policy 'free-only'", () => {
    assert.equal(router.getPolicy(), "free-only");
  });

  await t.test("successfully routes to default verified free model", () => {
    const model = router.resolveModel();
    assert.equal(model.id, "gemini-3.8-flash");
    assert.equal(model.priceClass, "free");
    assert.equal(model.entitlement, "verified_free");
  });

  await t.test("rejects paid models with DisallowedPaidEndpointError", () => {
    assert.throws(
      () => router.resolveModel("gpt-4o"),
      (err: unknown) => {
        assert.ok(err instanceof DisallowedPaidEndpointError);
        assert.match(err.message, /gpt-4o/);
        assert.match(err.message, /paid/);
        return true;
      }
    );
  });

  await t.test("rejects unverified entitlement with DisallowedPaidEndpointError", () => {
    assert.throws(
      () => router.resolveModel("experimental-free-unverified"),
      (err: unknown) => {
        assert.ok(err instanceof DisallowedPaidEndpointError);
        return true;
      }
    );
  });

  await t.test("rejects unknown pricing / unregistered models with DisallowedPaidEndpointError", () => {
    assert.throws(
      () => router.resolveModel("completely-unknown-model"),
      (err: unknown) => {
        assert.ok(err instanceof DisallowedPaidEndpointError);
        assert.match(err.message, /completely-unknown-model/);
        assert.match(err.message, /unknown/);
        return true;
      }
    );
  });

  await t.test("enforces zero paid fallback when primary model is unavailable", () => {
    // A registry with only one free model cannot fallback to a paid model
    assert.throws(
      () => router.fallback("gemini-3.8-flash"),
      /Zero paid fallback violation/
    );

    // If an alternative verified-free model exists, fallback succeeds
    const altFree: ModelRegistration = {
      id: "gemini-2.5-flash-free",
      provider: "google",
      displayName: "Gemini 2.5 Flash Free",
      protocol: "gemini-rest",
      priceClass: "free",
      entitlement: "verified_free",
      capabilities: {
        functionCalling: true,
        structuredOutput: true,
        vision: true,
        thinking: false,
        maxInputTokens: 1048576,
        maxOutputTokens: 8192,
      },
    };
    registry.register(altFree);

    const fallbackModel = router.fallback("gemini-3.8-flash");
    assert.equal(fallbackModel.id, "gemini-2.5-flash-free");
    assert.equal(fallbackModel.priceClass, "free");
  });
});

test("ReservationManager: Atomic Reservation, Reconciliation & Release Lifecycle", async (t) => {
  await t.test("standard reservation, reconciliation, and token accounting lifecycle", () => {
    const manager = new ReservationManager({ maxConcurrentTokens: 50000 });

    assert.equal(manager.getActiveReservedTokens(), 0);
    assert.equal(manager.getTotalReconciledTokens(), 0);

    const reservation = manager.reserve({
      runId: "run-001",
      taskId: "task-001",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 500,
    });

    assert.equal(reservation.status, "reserved");
    assert.equal(reservation.reservedTokens, 1500);
    assert.equal(manager.getActiveReservedTokens(), 1500);

    // Reconcile with actual token usage
    const reconciled = manager.reconcile({
      reservationId: reservation.id,
      actualInputTokens: 950,
      actualOutputTokens: 420,
      totalTokens: 1370,
      durationMs: 350,
    });

    assert.equal(reconciled.status, "reconciled");
    assert.equal(manager.getActiveReservedTokens(), 0);
    assert.equal(manager.getTotalReconciledTokens(), 1370);
  });

  await t.test("release lifecycle frees reserved tokens", () => {
    const manager = new ReservationManager();

    const reservation = manager.reserve({
      runId: "run-002",
      taskId: "task-002",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 2000,
      estimatedOutputTokens: 1000,
    });

    assert.equal(manager.getActiveReservedTokens(), 3000);

    const released = manager.release(reservation.id, "turn cancelled by user");
    assert.equal(released.status, "released");
    assert.equal(manager.getActiveReservedTokens(), 0);
    assert.equal(manager.getTotalReconciledTokens(), 0);
  });

  await t.test("prevents double reservation for the same run/task", () => {
    const manager = new ReservationManager();

    manager.reserve({
      runId: "run-dup",
      taskId: "task-dup",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
    });

    assert.throws(
      () =>
        manager.reserve({
          runId: "run-dup",
          taskId: "task-dup",
          modelId: "gemini-3.8-flash",
          estimatedInputTokens: 200,
          estimatedOutputTokens: 200,
        }),
      (err: unknown) => {
        assert.ok(err instanceof DoubleReservationError);
        return true;
      }
    );
  });

  await t.test("prevents explicit reservationId collision", () => {
    const manager = new ReservationManager();

    manager.reserve(
      {
        runId: "run-a",
        taskId: "task-a",
        modelId: "gemini-3.8-flash",
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      },
      { reservationId: "res-fixed-id" }
    );

    assert.throws(
      () =>
        manager.reserve(
          {
            runId: "run-b",
            taskId: "task-b",
            modelId: "gemini-3.8-flash",
            estimatedInputTokens: 100,
            estimatedOutputTokens: 100,
          },
          { reservationId: "res-fixed-id" }
        ),
      (err: unknown) => {
        assert.ok(err instanceof DoubleReservationError);
        return true;
      }
    );
  });

  await t.test("prevents double reconciliation", () => {
    const manager = new ReservationManager();

    const res = manager.reserve({
      runId: "run-003",
      taskId: "task-003",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 500,
      estimatedOutputTokens: 500,
    });

    manager.reconcile({
      reservationId: res.id,
      actualInputTokens: 500,
      actualOutputTokens: 500,
      totalTokens: 1000,
      durationMs: 200,
    });

    assert.throws(
      () =>
        manager.reconcile({
          reservationId: res.id,
          actualInputTokens: 500,
          actualOutputTokens: 500,
          totalTokens: 1000,
          durationMs: 200,
        }),
      (err: unknown) => {
        assert.ok(err instanceof DoubleReconciliationError);
        return true;
      }
    );
  });

  await t.test("prevents double release", () => {
    const manager = new ReservationManager();

    const res = manager.reserve({
      runId: "run-004",
      taskId: "task-004",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 200,
      estimatedOutputTokens: 200,
    });

    manager.release(res.id);

    assert.throws(
      () => manager.release(res.id),
      (err: unknown) => {
        assert.ok(err instanceof DoubleReleaseError);
        return true;
      }
    );
  });

  await t.test("prevents reconciling a released reservation and releasing a reconciled reservation", () => {
    const manager = new ReservationManager();

    const res1 = manager.reserve({
      runId: "run-005",
      taskId: "task-005",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
    });
    manager.release(res1.id);

    assert.throws(
      () =>
        manager.reconcile({
          reservationId: res1.id,
          actualInputTokens: 100,
          actualOutputTokens: 100,
          totalTokens: 200,
          durationMs: 100,
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidReservationStateError);
        return true;
      }
    );

    const res2 = manager.reserve({
      runId: "run-006",
      taskId: "task-006",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
    });
    manager.reconcile({
      reservationId: res2.id,
      actualInputTokens: 100,
      actualOutputTokens: 100,
      totalTokens: 200,
      durationMs: 100,
    });

    assert.throws(
      () => manager.release(res2.id),
      (err: unknown) => {
        assert.ok(err instanceof InvalidReservationStateError);
        return true;
      }
    );
  });

  await t.test("rejects when token budget limit is exceeded", () => {
    const manager = new ReservationManager({ maxConcurrentTokens: 1000 });

    manager.reserve({
      runId: "run-lim-1",
      taskId: "task-lim-1",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 600,
      estimatedOutputTokens: 200, // 800 total
    });

    assert.throws(
      () =>
        manager.reserve({
          runId: "run-lim-2",
          taskId: "task-lim-2",
          modelId: "gemini-3.8-flash",
          estimatedInputTokens: 200,
          estimatedOutputTokens: 100, // 300 total -> 800+300 = 1100 > 1000
        }),
      (err: unknown) => {
        assert.ok(err instanceof InsufficientBudgetError);
        return true;
      }
    );
  });
});

test("ReservationManager: Cancellation & Timeout Clean Up Without Leaks", async (t) => {
  await t.test("cancellation cleans up reservation by runId and taskId", () => {
    const manager = new ReservationManager();

    manager.reserve({
      runId: "run-cancel",
      taskId: "task-cancel-1",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 1000,
    });

    assert.equal(manager.getActiveReservedTokens(), 2000);

    const cancelled = manager.cancel({ runId: "run-cancel" });
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].status, "released");
    assert.equal(manager.getActiveReservedTokens(), 0, "No leaked tokens after cancellation");
  });

  await t.test("cancellation by reservation ID cleans up cleanly", () => {
    const manager = new ReservationManager();

    const res = manager.reserve({
      runId: "run-cancel-single",
      taskId: "task-cancel-single",
      modelId: "gemini-3.8-flash",
      estimatedInputTokens: 500,
      estimatedOutputTokens: 500,
    });

    assert.equal(manager.getActiveReservedTokens(), 1000);

    const cancelled = manager.cancel(res.id);
    assert.equal(cancelled.length, 1);
    assert.equal(manager.getActiveReservedTokens(), 0);
  });

  await t.test("timeout expiration cleans up stale reservations without leaks", () => {
    const manager = new ReservationManager({ defaultTtlMs: 100 });
    const now = Date.now();

    const res = manager.reserve(
      {
        runId: "run-stale",
        taskId: "task-stale",
        modelId: "gemini-3.8-flash",
        estimatedInputTokens: 1500,
        estimatedOutputTokens: 500,
      },
      { ttlMs: 100 }
    );

    assert.equal(manager.getActiveReservedTokens(), 2000);

    // After expiration timestamp
    const expired = manager.expireStale(now + 200);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, res.id);
    assert.equal(expired[0].status, "expired");
    assert.equal(manager.getActiveReservedTokens(), 0, "No leaked tokens after timeout expiration");
  });
});

test("BackoffScheduler: 429 Retry-After Parsing & Bounded Jittered Backoff", async (t) => {
  const scheduler = new BackoffScheduler({
    initialDelayMs: 2000,
    maxDelayMs: 60000,
    multiplier: 2.0,
    jitterRatio: 0.25,
  });

  await t.test("parses numeric Retry-After header in seconds", () => {
    assert.equal(scheduler.parseRetryAfter("30"), 30000);
    assert.equal(scheduler.parseRetryAfter(45), 45000);
    assert.equal(scheduler.parseRetryAfter("2.5"), 2500);
  });

  await t.test("parses HTTP-date Retry-After header", () => {
    const fixedNow = 1760000000000;
    const futureDate = new Date(fixedNow + 15000).toUTCString();
    const parsed = scheduler.parseRetryAfter(futureDate, fixedNow);
    assert.equal(parsed, 15000);
  });

  await t.test("returns null for missing, empty or unparseable headers", () => {
    assert.equal(scheduler.parseRetryAfter(null), null);
    assert.equal(scheduler.parseRetryAfter(undefined), null);
    assert.equal(scheduler.parseRetryAfter(""), null);
    assert.equal(scheduler.parseRetryAfter("invalid-format"), null);
  });

  await t.test("calculates exponential delays with bounds", () => {
    // Attempt 0: 2000 * 2^0 = 2000
    assert.equal(scheduler.calculateExponentialDelay(0), 2000);
    // Attempt 1: 2000 * 2^1 = 4000
    assert.equal(scheduler.calculateExponentialDelay(1), 4000);
    // Attempt 2: 2000 * 2^2 = 8000
    assert.equal(scheduler.calculateExponentialDelay(2), 8000);
    // Attempt 3: 2000 * 2^3 = 16000
    assert.equal(scheduler.calculateExponentialDelay(3), 16000);
    // Attempt 10: 2000 * 2^10 = 2048000 -> clamped at maxDelayMs (60000)
    assert.equal(scheduler.calculateExponentialDelay(10), 60000);
  });

  await t.test("applies bounded jitter within ratio bounds", () => {
    const base = 4000;
    // With ratio 0.25, min = 3000, max = 5000
    const minExpected = 3000;
    const maxExpected = 5000;

    const jitteredMin = scheduler.applyJitter(base, 0.0);
    const jitteredMid = scheduler.applyJitter(base, 0.5);
    const jitteredMax = scheduler.applyJitter(base, 1.0);

    assert.equal(jitteredMin, minExpected);
    assert.equal(jitteredMid, 4000);
    assert.equal(jitteredMax, maxExpected);

    // Random jitter also falls strictly within [minExpected, maxExpected]
    for (let i = 0; i < 20; i++) {
      const val = scheduler.applyJitter(base);
      assert.ok(val >= minExpected && val <= maxExpected, `Jitter value ${val} out of bounds`);
    }
  });

  await t.test("computes scheduled retry timestamp correctly", () => {
    const fixedNow = 100000;
    const schedule = scheduler.computeBackoff({
      attempt: 1,
      retryAfterHeader: "10",
      now: fixedNow,
    });

    assert.equal(schedule.fromRetryAfter, true);
    assert.equal(schedule.delayMs, 10000);
    assert.equal(schedule.retryAt, fixedNow + 10000);
  });

  await t.test("records 429 and tracks rate limit state", () => {
    const fixedNow = 100000;
    const state = scheduler.record429("gemini-3.8-flash", "5", "google", fixedNow);

    assert.equal(state.isRateLimited, true);
    assert.equal(state.consecutive429s, 1);
    assert.equal(state.retryAfterMs, 5000);
    assert.equal(state.resetTime, fixedNow + 5000);

    assert.equal(scheduler.isRateLimited("gemini-3.8-flash", "google", fixedNow + 2000), true);
    assert.equal(scheduler.getRemainingWaitMs("gemini-3.8-flash", "google", fixedNow + 2000), 3000);

    // After resetTime has passed
    assert.equal(scheduler.isRateLimited("gemini-3.8-flash", "google", fixedNow + 6000), false);
    assert.equal(scheduler.getRemainingWaitMs("gemini-3.8-flash", "google", fixedNow + 6000), 0);
  });

  await t.test("sleep does not busy-wait and supports abort cancellation", async () => {
    const start = Date.now();
    await scheduler.sleep(15);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 10, "Should wait using event loop timer");

    const controller = new AbortController();
    const abortPromise = scheduler.sleep(1000, controller.signal);
    controller.abort();

    await assert.rejects(abortPromise, /Sleep aborted/);
  });
});
