import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NexoraDatabase, TaskService } from "../../runtime/src/index.ts";
import {
  ScheduleRunner,
  EventInbox,
  HeartbeatMonitor,
  DelegationManager,
  MaxDelegationDepthExceededError,
  QUIET,
} from "../src/index.ts";

describe("Phase 7: Schedule Runner & Idempotent Cron Triggers", () => {
  let tempDir: string;
  let db: NexoraDatabase;
  let taskService: TaskService;
  let runner: ScheduleRunner;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-proactivity-test-"));
    db = new NexoraDatabase(join(tempDir, "proactivity.db"));
    taskService = new TaskService(db);
    runner = new ScheduleRunner(taskService, "Asia/Kolkata");
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("registers job with Asia/Kolkata timezone default", () => {
    const job = runner.registerJob({
      id: "job-morning-summary",
      name: "Morning Digest",
      prompt: "Summarize pending PRs and open threads",
      enabled: true,
      intervalMs: 60000,
    });

    assert.equal(job.timezone, "Asia/Kolkata");
    assert.equal(job.id, "job-morning-summary");
  });

  it("submits task idempotently without duplicate runs for the same slot", () => {
    const fixedTime = 1760000000000;

    // First trigger for this minute slot
    const run1 = runner.triggerJob("job-morning-summary", fixedTime);
    assert.ok(run1);
    assert.equal(run1.isNew, true);
    assert.equal(run1.task.status, "queued");

    // Second trigger within same slot -> Must be idempotent, no duplicate task!
    const run2 = runner.triggerJob("job-morning-summary", fixedTime + 10000);
    assert.ok(run2);
    assert.equal(run2.isNew, false);
    assert.equal(run2.task.id, run1.task.id);

    // Next minute slot -> Creates a new run
    const nextSlotTime = fixedTime + 60000;
    const run3 = runner.triggerJob("job-morning-summary", nextSlotTime);
    assert.ok(run3);
    assert.equal(run3.isNew, true);
    assert.notEqual(run3.task.id, run1.task.id);
  });
});

describe("Phase 7: Deduplicated Event Inbox", () => {
  it("ingests unique events and discards duplicates", async () => {
    const inbox = new EventInbox(60000);
    const received: string[] = [];

    inbox.subscribe("github.push", (e) => {
      received.push(e.eventId);
    });

    const eventA = {
      source: "github-webhook",
      eventId: "evt-001",
      topic: "github.push",
      payload: { ref: "refs/heads/main" },
      timestamp: Date.now(),
    };

    // First ingestion -> Accepted
    const res1 = await inbox.ingest(eventA);
    assert.equal(res1.accepted, true);
    assert.equal(received.length, 1);

    // Duplicate ingestion -> Discarded
    const res2 = await inbox.ingest(eventA);
    assert.equal(res2.accepted, false);
    assert.match(res2.reason!, /Duplicate event/);
    assert.equal(received.length, 1); // Handler not called again
  });
});

describe("Phase 7: Quiet Heartbeat Protocol", () => {
  it("remains quiet (NOTHING) when system state is unchanged", () => {
    const monitor = new HeartbeatMonitor();

    const initialState = {
      tasks: [
        {
          id: "t1",
          status: "completed" as const,
          ownerId: "o1",
          projectId: "p1",
          idempotencyKey: "k1",
          title: "Task 1",
          description: "",
          input: {},
          activeRunId: null,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      goals: [
        {
          id: "g1",
          title: "Goal 1",
          criteria: [],
          status: "active" as const,
          budgetTokens: 1000,
          consumedTokens: 100,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    };

    // First evaluation: reports system healthy
    const eval1 = monitor.evaluate(initialState);
    assert.equal(eval1.deliver, true);
    assert.match(eval1.message, /System healthy/);

    // Second evaluation with identical state: returns NOTHING and suppresses notification
    const eval2 = monitor.evaluate(initialState);
    assert.equal(eval2.deliver, false);
    assert.equal(eval2.message, QUIET);

    // State changes: a task fails
    const failedState = {
      ...initialState,
      tasks: [
        {
          ...initialState.tasks[0],
          status: "failed" as const,
        },
      ],
    };

    const eval3 = monitor.evaluate(failedState);
    assert.equal(eval3.deliver, true);
    assert.match(eval3.message, /Heartbeat Alert: 1 task\(s\) failed/);
  });
});

describe("Phase 7: Bounded Sub-Agent Delegation Hierarchy", () => {
  it("spawns child agents within depth limit and rejects exceeding depth", () => {
    const mgr = new DelegationManager(2); // Max depth 2

    // Root agent: depth 0
    const root = mgr.spawnAgent({ agentId: "agent-root", taskId: "task-0" });
    assert.equal(root.depth, 0);

    // Child agent: depth 1
    const child1 = mgr.spawnAgent({ agentId: "agent-child-1", parentId: "agent-root", taskId: "task-1" });
    assert.equal(child1.depth, 1);

    // Grandchild agent: depth 2
    const grandchild = mgr.spawnAgent({ agentId: "agent-grandchild", parentId: "agent-child-1", taskId: "task-2" });
    assert.equal(grandchild.depth, 2);

    // Great-grandchild: depth 3 -> Exceeds max depth 2!
    assert.throws(
      () => mgr.spawnAgent({ agentId: "agent-too-deep", parentId: "agent-grandchild", taskId: "task-3" }),
      (err: any) => err instanceof MaxDelegationDepthExceededError && err.message.includes("depth limit exceeded")
    );
  });

  it("cascades cancellation down the sub-agent hierarchy", () => {
    const mgr = new DelegationManager(3);

    mgr.spawnAgent({ agentId: "lead", taskId: "task-lead" });
    mgr.spawnAgent({ agentId: "sub-1", parentId: "lead", taskId: "task-sub-1" });
    mgr.spawnAgent({ agentId: "sub-2", parentId: "lead", taskId: "task-sub-2" });
    mgr.spawnAgent({ agentId: "worker-1a", parentId: "sub-1", taskId: "task-worker-1a" });

    // Cancel lead agent -> must cancel lead, sub-1, sub-2, and worker-1a
    const cancelled = mgr.cancelAgentHierarchy("lead");
    assert.equal(cancelled.length, 4);
    assert.ok(cancelled.includes("lead"));
    assert.ok(cancelled.includes("sub-1"));
    assert.ok(cancelled.includes("sub-2"));
    assert.ok(cancelled.includes("worker-1a"));

    assert.equal(mgr.getNode("worker-1a")?.status, "cancelled");
    assert.equal(mgr.getNode("sub-2")?.status, "cancelled");
  });
});
