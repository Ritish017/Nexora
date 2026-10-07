/**
 * Nexora Phase 2 Challenge Test Suite
 * 
 * Verifies Phase 2 Architectural Contracts & Negative Invariants:
 * 1. Free-Only routing policy: requesting a paid or unknown model fails immediately with DisallowedPaidEndpointError.
 * 2. 429 rate limit backoff: transitions into non-blocking RateLimitState with exponential backoff & jitter bounds.
 * 3. Governed tool approval denial: guarantees ZERO side effects upon rejection.
 * 4. Interrupted / ambiguous mutations: transition to 'uncertain_effect' and are quarantined from replay.
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NexoraDatabase } from "../../runtime/src/db.ts";
import { TaskService } from "../../runtime/src/task-service.ts";
import {
  DisallowedPaidEndpointError,
  InsufficientBudgetError,
  DEFAULT_BACKOFF_POLICY
} from "../../contracts/src/index.ts";
import type {
  ModelRegistration,
  ProviderConfig,
  RateLimitState,
  BackoffPolicy,
  ToolDefinition,
  GovernedToolCall
} from "../../contracts/src/index.ts";
import { ContractAuditor } from "../src/auditor.ts";

test("Phase 2 Challenge: Free-Only Routing Policy & Negative Path Enforcement", async (t) => {
  // Test Model Registrations
  const freeModelFlash: ModelRegistration = {
    id: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    protocol: "gemini-rest",
    priceClass: "free",
    entitlement: "verified_free",
    capabilities: {
      functionCalling: true,
      structuredOutput: true,
      vision: true,
      thinking: true,
      maxInputTokens: 1048576,
      maxOutputTokens: 8192,
    },
  };

  const freeModel38Flash: ModelRegistration = {
    id: "gemini-3.8-flash",
    provider: "google",
    displayName: "Gemini 3.8 Flash",
    protocol: "gemini-rest",
    priceClass: "free",
    entitlement: "verified_free",
    capabilities: {
      functionCalling: true,
      structuredOutput: true,
      vision: true,
      thinking: true,
      maxInputTokens: 1048576,
      maxOutputTokens: 8192,
    },
  };

  const paidModelPro: ModelRegistration = {
    id: "gemini-1.5-pro",
    provider: "google",
    displayName: "Gemini 1.5 Pro",
    protocol: "gemini-rest",
    priceClass: "paid",
    entitlement: "paid_active",
    capabilities: {
      functionCalling: true,
      structuredOutput: true,
      vision: true,
      thinking: true,
      maxInputTokens: 2097152,
      maxOutputTokens: 8192,
    },
  };

  const paidModelClaude: ModelRegistration = {
    id: "claude-3-opus",
    provider: "anthropic",
    displayName: "Claude 3 Opus",
    protocol: "openai-compatible",
    priceClass: "paid",
    entitlement: "paid_active",
    capabilities: {
      functionCalling: true,
      structuredOutput: true,
      vision: true,
      thinking: false,
      maxInputTokens: 200000,
      maxOutputTokens: 4096,
    },
  };

  const unclassifiedModel: ModelRegistration = {
    id: "custom-unverified-llm",
    provider: "community",
    displayName: "Custom Unverified",
    protocol: "openai-compatible",
    priceClass: "unknown",
    entitlement: "unverified",
    capabilities: {
      functionCalling: false,
      structuredOutput: false,
      vision: false,
      thinking: false,
      maxInputTokens: 8192,
      maxOutputTokens: 2048,
    },
  };

  await t.test("1.1 Free-only mode allows verified free models", () => {
    assert.doesNotThrow(() => {
      ContractAuditor.validateRoutingPolicy("free-only", freeModelFlash);
    });
    assert.doesNotThrow(() => {
      ContractAuditor.validateRoutingPolicy("free-only", freeModel38Flash);
    });
  });

  await t.test("1.2 Free-only mode immediately fails on paid model with DisallowedPaidEndpointError", () => {
    let networkCallMade = false;
    let tokensDeducted = 0;

    const requestPaidTurn = () => {
      // Pre-flight routing check must throw BEFORE any network or token reservation
      ContractAuditor.validateRoutingPolicy("free-only", paidModelPro);
      networkCallMade = true;
      tokensDeducted += 500;
    };

    assert.throws(
      () => requestPaidTurn(),
      (err: any) => {
        assert.ok(err instanceof DisallowedPaidEndpointError);
        assert.strictEqual(err.name, "DisallowedPaidEndpointError");
        assert.ok(err.message.includes("gemini-1.5-pro"));
        assert.ok(err.message.includes("paid"));
        assert.ok(err.message.includes("free-only routing"));
        return true;
      },
      "Requesting paid model under free-only must immediately throw DisallowedPaidEndpointError"
    );

    // Verify negative guarantee: zero network activity, zero token loss
    assert.strictEqual(networkCallMade, false, "Zero network calls permitted for disallowed paid endpoint");
    assert.strictEqual(tokensDeducted, 0, "Zero tokens must be deducted on rejected endpoint");
  });

  await t.test("1.3 Free-only mode rejects unknown price-class endpoints", () => {
    assert.throws(
      () => {
        ContractAuditor.validateRoutingPolicy("free-only", unclassifiedModel);
      },
      (err: any) => {
        assert.ok(err instanceof DisallowedPaidEndpointError);
        assert.ok(err.message.includes("unknown"));
        return true;
      },
      "Unknown price class must be rejected in free-only mode"
    );
  });

  await t.test("1.4 Provider configuration price-class whitelist enforcement", () => {
    const freeOnlyProviderConfig: ProviderConfig = {
      provider: "google",
      allowedPriceClasses: ["free"],
    };

    assert.doesNotThrow(() => {
      ContractAuditor.validateProviderPriceClass(freeOnlyProviderConfig, freeModelFlash);
    });

    assert.throws(
      () => {
        ContractAuditor.validateProviderPriceClass(freeOnlyProviderConfig, paidModelPro);
      },
      DisallowedPaidEndpointError,
      "Provider config restricting to free must reject paid models"
    );
  });
});

test("Phase 2 Challenge: 429 Rate Limits & Non-Blocking Backoff States", async (t) => {
  const provider = "google";
  const modelId = "gemini-2.5-flash";

  await t.test("2.1 Exponential backoff delay calculation conforms to policy", () => {
    const policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY;
    assert.strictEqual(policy.initialDelayMs, 2000);
    assert.strictEqual(policy.maxDelayMs, 60000);
    assert.strictEqual(policy.multiplier, 2.0);

    // consecutive 429 = 1 -> initialDelay = 2000ms
    const delay1 = ContractAuditor.computeBackoffDelay(1, policy, 0);
    assert.strictEqual(delay1, 2000);

    // consecutive 429 = 2 -> 2000 * 2^1 = 4000ms
    const delay2 = ContractAuditor.computeBackoffDelay(2, policy, 0);
    assert.strictEqual(delay2, 4000);

    // consecutive 429 = 3 -> 2000 * 2^2 = 8000ms
    const delay3 = ContractAuditor.computeBackoffDelay(3, policy, 0);
    assert.strictEqual(delay3, 8000);

    // consecutive 429 = 4 -> 2000 * 2^3 = 16000ms
    const delay4 = ContractAuditor.computeBackoffDelay(4, policy, 0);
    assert.strictEqual(delay4, 16000);

    // High consecutive count clamps to maxDelayMs (60000ms)
    const delay10 = ContractAuditor.computeBackoffDelay(10, policy, 0);
    assert.strictEqual(delay10, 60000);
  });

  await t.test("2.2 Jitter ratio bounds are strictly maintained", () => {
    const policy: BackoffPolicy = {
      initialDelayMs: 4000,
      maxDelayMs: 60000,
      multiplier: 2.0,
      jitterRatio: 0.25, // +/- 25%
    };

    // consecutive = 1, base = 4000ms
    // With max positive jitter (+0.25) -> 4000 + 1000 = 5000ms
    const delayMaxJitter = ContractAuditor.computeBackoffDelay(1, policy, 1.0);
    assert.strictEqual(delayMaxJitter, 5000);

    // With max negative jitter (-0.25) -> 4000 - 1000 = 3000ms
    const delayMinJitter = ContractAuditor.computeBackoffDelay(1, policy, -1.0);
    assert.strictEqual(delayMinJitter, 3000);

    assert.ok(delayMinJitter >= 3000 && delayMaxJitter <= 5000);
  });

  await t.test("2.3 RateLimitState transition and non-blocking availability query", () => {
    const initialTime = 1700000000000;
    let rateState: RateLimitState = {
      provider,
      modelId,
      isRateLimited: false,
      retryAfterMs: 0,
      resetTime: 0,
      consecutive429s: 0,
    };

    // Initially available
    assert.strictEqual(ContractAuditor.isEndpointAvailable(rateState, initialTime), true);

    // 429 encountered
    rateState = ContractAuditor.applyRateLimit429(rateState, DEFAULT_BACKOFF_POLICY, initialTime, 0);
    assert.strictEqual(rateState.isRateLimited, true);
    assert.strictEqual(rateState.consecutive429s, 1);
    assert.strictEqual(rateState.retryAfterMs, 2000);
    assert.strictEqual(rateState.resetTime, initialTime + 2000);

    // Check non-blocking evaluation: immediate O(1) query without thread sleep
    const isAvailDuringBackoff = ContractAuditor.isEndpointAvailable(rateState, initialTime + 500);
    assert.strictEqual(isAvailDuringBackoff, false, "Endpoint must be flagged unavailable during backoff window");

    // Once resetTime has passed:
    const isAvailAfterReset = ContractAuditor.isEndpointAvailable(rateState, initialTime + 2001);
    assert.strictEqual(isAvailAfterReset, true, "Endpoint must become available once resetTime elapses");
  });
});

test("Phase 2 Challenge: Approval Denial Results in Zero Side Effects", async (t) => {
  const db = new NexoraDatabase(":memory:");
  const taskService = new TaskService(db);

  const destructiveTool: ToolDefinition = {
    name: "purge_database_cluster",
    description: "Destructive mutation dropping production tables",
    parameters: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    isMutating: true, // Requires explicit approval
  };

  const toolCall: GovernedToolCall = {
    callId: "call-purge-001",
    name: "purge_database_cluster",
    arguments: { target: "prod_customer_data" },
  };

  await t.test("3.1 Denial halts mutation and executes zero side effects", async () => {
    let sideEffectExecutionCount = 0;
    let deletedRecordsCount = 0;

    const sideEffectCallback = () => {
      sideEffectExecutionCount++;
      deletedRecordsCount += 10000;
      return { purged: true };
    };

    const { task } = taskService.submitTask({
      ownerId: "admin-1",
      projectId: "security-ops",
      idempotencyKey: "purge-task-001",
      title: "Purge Database Request",
      description: "Requesting approval to purge",
    });

    const claim = taskService.claimTask("worker-danger", 30000, task.id)!;

    // Execute with DENIAL decision
    const result = await ContractAuditor.auditGovernedMutationExecution({
      tool: destructiveTool,
      call: toolCall,
      runId: claim.run.id,
      taskService,
      actor: "worker-danger",
      decision: "deny",
      reviewerId: "admin-1",
      sideEffectCallback,
    });

    // Zero side-effect guarantees
    assert.strictEqual(result.executed, false, "Mutation must NOT have executed");
    assert.strictEqual(sideEffectExecutionCount, 0, "Callback must be invoked exactly 0 times");
    assert.strictEqual(deletedRecordsCount, 0, "Zero records should have been deleted");

    // Run and Task state guarantees
    assert.strictEqual(result.approval.status, "denied");
    assert.strictEqual(result.runStatus, "failed");

    const updatedTask = db.getTask(task.id);
    assert.strictEqual(updatedTask?.status, "failed");

    const updatedRun = db.getRun(claim.run.id);
    assert.strictEqual(updatedRun?.status, "failed");
    assert.ok(updatedRun?.error?.includes("denied by admin-1"));

    // Event log guarantees
    const events = db.getEvents(claim.run.id);
    const resolvedEvent = events.find((e) => e.type === "approval_resolved");
    assert.ok(resolvedEvent);
    assert.strictEqual(resolvedEvent.payload.status, "denied");
    assert.strictEqual(resolvedEvent.payload.decisionBy, "admin-1");
  });

  await t.test("3.2 Approval permits side-effect execution exactly once", async () => {
    let sideEffectExecutionCount = 0;

    const { task } = taskService.submitTask({
      ownerId: "admin-1",
      projectId: "security-ops",
      idempotencyKey: "approved-task-002",
      title: "Authorized Mutation",
      description: "Approved operation",
    });

    const claim = taskService.claimTask("worker-authorized", 30000, task.id)!;

    const result = await ContractAuditor.auditGovernedMutationExecution({
      tool: destructiveTool,
      call: toolCall,
      runId: claim.run.id,
      taskService,
      actor: "worker-authorized",
      decision: "approve",
      reviewerId: "admin-1",
      sideEffectCallback: () => {
        sideEffectExecutionCount++;
        return { success: true };
      },
    });

    assert.strictEqual(result.executed, true);
    assert.strictEqual(sideEffectExecutionCount, 1);
    assert.strictEqual(result.approval.status, "approved");
    assert.strictEqual(result.runStatus, "running");
  });

  db.close();
});

test("Phase 2 Challenge: Interrupted Mutation Transitions to 'uncertain_effect'", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-audit-uncertain-"));
  const dbPath = join(tempDir, "uncertain.db");
  const db = new NexoraDatabase(dbPath);
  const taskService = new TaskService(db);

  await t.test("4.1 Ambiguous disruption transitions run to uncertain_effect", () => {
    const { task } = taskService.submitTask({
      ownerId: "bank-ops",
      projectId: "settlements",
      idempotencyKey: "settle-batch-009",
      title: "ACH Settlement Dispatch",
      description: "Batch settlement mutation",
    });

    const claim = taskService.claimTask("worker-bank-1", 30000, task.id)!;
    assert.strictEqual(claim.run.status, "running");
    assert.strictEqual(claim.run.uncertainEffect, false);

    // Socket abruptly severed while HTTP request payload was in-flight to central clearing house
    const failureReason = "TCP connection reset by peer during ACH settlement POST; response unreceived";
    const flaggedRun = taskService.flagUncertainEffect(claim.run.id, failureReason);

    assert.strictEqual(flaggedRun.status, "uncertain_effect");
    assert.strictEqual(flaggedRun.uncertainEffect, true);
    assert.strictEqual(flaggedRun.uncertainReason, failureReason);

    // Verify event stream records uncertain_effect transition
    const events = db.getEvents(claim.run.id);
    const uncertainEvent = events.find(
      (e) => e.type === "status_change" && e.payload.to === "uncertain_effect"
    );
    assert.ok(uncertainEvent);
    assert.strictEqual(uncertainEvent.payload.uncertainReason, failureReason);
  });

  await t.test("4.2 Engine recovery quarantines uncertain_effect and refuses automated retry", () => {
    // Simulate database shutdown and restart
    db.close();

    const dbRecovered = new NexoraDatabase(dbPath);
    const taskServiceRecovered = new TaskService(dbRecovered);

    // Startup recovery executes
    const recovery = taskServiceRecovered.recoverOnStartup();
    assert.strictEqual(recovery.uncertain, 1, "Must detect exactly 1 uncertain mutation");
    assert.strictEqual(recovery.recovered, 0, "Must NOT recover/requeue the uncertain task");

    // Task must remain quarantined (not queued, not running)
    const task = taskServiceRecovered.db.getTaskByIdempotencyKey("settle-batch-009");
    assert.ok(task);
    assert.notStrictEqual(task.status, "queued");

    // Worker poll returns nothing available
    const nextClaim = taskServiceRecovered.claimTask("worker-bank-2");
    assert.strictEqual(nextClaim, null, "Quarantined task cannot be claimed by any worker");

    dbRecovered.close();
  });

  rmSync(tempDir, { recursive: true, force: true });
});
