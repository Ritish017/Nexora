import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { NexoraDatabase, TaskService } from "../packages/runtime/src/index.ts";
import { BudgetRouter, ReservationManager } from "../packages/budget-router/src/index.ts";
import { PageStore, UIEventAdapter } from "../packages/workspace-adapter/src/index.ts";
import {
  deriveComputerToken,
  PolicyEngine,
  ApprovalBridge,
  SupervisorBridge,
} from "../packages/governance/src/index.ts";
import { NexoraMcpServer } from "../packages/mcp-server/src/index.ts";
import { FleetManager, RunnerClient } from "../packages/runner-fleet/src/index.ts";
import { HeartbeatMonitor, QUIET } from "../packages/proactivity/src/index.ts";
import { TelegramBotAdapter, UiCardPresenter } from "../packages/channels/src/index.ts";

describe("Phase 9: End-to-End Integrated Lifecycle Verification", () => {
  let tempDir: string;
  let dbPath: string;
  let db: NexoraDatabase;
  let taskService: TaskService;
  let budgetRouter: BudgetRouter;
  let reservationMgr: ReservationManager;
  let pageStore: PageStore;
  let eventAdapter: UIEventAdapter;
  let policyEngine: PolicyEngine;
  let approvalBridge: ApprovalBridge;
  let supervisorBridge: SupervisorBridge;
  let fleetManager: FleetManager;
  let mcpServer: NexoraMcpServer;
  let telegramBot: TelegramBotAdapter;
  let heartbeat: HeartbeatMonitor;

  const masterComputerToken = "master-secret-key-at-least-24-characters-long";
  const approvalSecret = "approval-secret-at-least-16-chars";

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-e2e-"));
    dbPath = join(tempDir, "e2e.db");
    db = new NexoraDatabase(dbPath);
    taskService = new TaskService(db);
    budgetRouter = new BudgetRouter();
    reservationMgr = new ReservationManager();
    pageStore = new PageStore(db.db);
    eventAdapter = new UIEventAdapter(pageStore);
    policyEngine = new PolicyEngine({ mode: "supervised" });
    approvalBridge = new ApprovalBridge(approvalSecret);
    supervisorBridge = new SupervisorBridge({
      supervisorUrl: "http://127.0.0.1:4312",
      supervisorToken: "sup-token-test",
      computerToken: masterComputerToken,
      namespace: "nexora",
    });
    fleetManager = new FleetManager();
    mcpServer = new NexoraMcpServer({ taskService, db, pageStore });
    telegramBot = new TelegramBotAdapter({
      chatId: "987654321",
      taskService,
    });
    heartbeat = new HeartbeatMonitor();
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("executes the full end-to-end lifecycle across all subsystems", async () => {
    // -------------------------------------------------------------
    // Step 1: Remote Task Submission via Telegram Channel
    // -------------------------------------------------------------
    const tgUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: "987654321" },
        from: { id: 100, first_name: "LeadDeveloper" },
        text: "/task Generate system architecture overview",
      },
    };

    const tgReply = await telegramBot.handleUpdate(tgUpdate);
    assert.ok(tgReply);
    assert.match(tgReply, /Task submitted/);

    const queuedTasks = db.listQueuedTasks();
    assert.equal(queuedTasks.length, 1);
    const task = queuedTasks[0];
    assert.equal(task.title, "Generate system architecture overview");

    // -------------------------------------------------------------
    // Step 2: Runner Fleet Pairing & Lease Claim
    // -------------------------------------------------------------
    const pairing = fleetManager.mintPairingCode("dedicated-runner-01");
    const { runner, token } = fleetManager.redeemPairingCode(pairing.code, {
      platform: "win32-x64",
      hostname: "host-workstation",
    });

    const runnerClient = new RunnerClient({
      runnerId: runner.id,
      token,
      fleetManager,
      taskService,
    });

    const claim = runnerClient.claimNextTask(30000);
    assert.ok(claim);
    assert.equal(claim.task.id, task.id);
    const runId = claim.run.id;

    // -------------------------------------------------------------
    // Step 3: Free-Only Model Routing & Budget Token Reservation
    // -------------------------------------------------------------
    const model = budgetRouter.route();
    assert.equal(model.id, "gemini-3.8-flash");
    assert.equal(model.priceClass, "free");

    const reservation = reservationMgr.reserve({
      runId,
      taskId: task.id,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 2000,
    });
    assert.equal(reservation.status, "reserved");

    // -------------------------------------------------------------
    // Step 4: Governed Computer Isolation & Credential Derivation
    // -------------------------------------------------------------
    const containerToken = supervisorBridge.getContainerToken("specialist-arch");
    const expectedContainerToken = deriveComputerToken(masterComputerToken, "specialist-arch");
    assert.equal(containerToken, expectedContainerToken);

    const spec = supervisorBridge.getContainerSpec("specialist-arch");
    assert.equal(spec.containerName, "nexora-computer-specialist-arch");
    assert.equal(spec.workspaceVolume, "nexora-computer-specialist-arch-workspace");

    // -------------------------------------------------------------
    // Step 5: Policy Evaluation & Mutating Action Approval Gating
    // -------------------------------------------------------------
    const proposedAction = "files_write";
    const proposedArgs = {
      path: "workspace/architecture.md",
      content: "# Architecture Overview\nValidated end-to-end.",
    };

    const evaluation = policyEngine.evaluateAction(proposedAction, proposedArgs, "agent");
    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.requiresApproval, true); // Mutating action in supervised mode

    // -------------------------------------------------------------
    // Step 6: Approval Request & Cryptographic Binding
    // -------------------------------------------------------------
    const approvalReq = approvalBridge.createRequest({
      id: "appr-e2e-01",
      runId,
      action: proposedAction,
      args: proposedArgs,
      resource: "workspace://files/architecture.md",
      actor: runner.id,
      policyVersion: "1.0.0",
      ttlMs: 60000,
    });

    const approvalCard = UiCardPresenter.renderApprovalCard(
      {
        id: approvalReq.id,
        runId,
        action: proposedAction,
        argumentsHash: approvalReq.argumentsHash,
        resource: approvalReq.resource,
        actor: runner.id,
        policyVersion: "1.0.0",
        expiry: approvalReq.expiry,
        status: "pending",
        decisionBy: null,
        decisionAt: null,
      },
      proposedArgs
    );
    assert.equal(approvalCard.humanReadableTitle, "File Modification");
    assert.match(approvalCard.humanReadableDescription, /workspace\/architecture\.md/);

    // -------------------------------------------------------------
    // Step 7: Owner Grants Approval
    // -------------------------------------------------------------
    approvalBridge.resolveRequest(approvalReq.id, true, "owner-lead");
    const authDecision = approvalBridge.authorizeExecution({
      approvalId: approvalReq.id,
      runId,
      proposedArgs,
      actor: runner.id,
    });
    assert.equal(authDecision.authorized, true);

    // Replay attempt must fail
    const replayCheck = approvalBridge.authorizeExecution({
      approvalId: approvalReq.id,
      runId,
      proposedArgs,
      actor: runner.id,
    });
    assert.equal(replayCheck.authorized, false);
    assert.match(replayCheck.reason!, /already been consumed/);

    // -------------------------------------------------------------
    // Step 8: Execution, Normalized Monotonic Events & Progress
    // -------------------------------------------------------------
    runnerClient.reportProgress(50, "Generating architecture artifact...");
    runnerClient.reportProgress(100, "Artifact generated and verified.");

    // -------------------------------------------------------------
    // Step 9: Artifact Creation & Verification
    // -------------------------------------------------------------
    const artifactContent = "# Architecture Overview\nValidated end-to-end.";
    const artifactPath = join(tempDir, "architecture.md");
    writeFileSync(artifactPath, artifactContent, "utf8");
    const sha256 = createHash("sha256").update(artifactContent).digest("hex");

    db.insertArtifact({
      id: "art-e2e-01",
      runId,
      taskId: task.id,
      name: "architecture.md",
      filePath: artifactPath,
      contentType: "text/markdown",
      sha256,
      sizeBytes: Buffer.byteLength(artifactContent),
      createdAt: Date.now(),
    });

    // -------------------------------------------------------------
    // Step 10: Usage Reconciliation & Task Completion
    // -------------------------------------------------------------
    const reconciled = reservationMgr.reconcile({
      reservationId: reservation.id,
      actualInputTokens: 420,
      actualOutputTokens: 110,
      totalTokens: 530,
    });
    assert.equal(reconciled.status, "reconciled");

    runnerClient.completeTask({
      summary: "Architecture document generated and verified",
      artifactId: "art-e2e-01",
    });

    const finishedRun = db.getRun(runId);
    assert.equal(finishedRun?.status, "completed");

    // -------------------------------------------------------------
    // Step 11: Document Workspace Page Creation upon Approval
    // -------------------------------------------------------------
    const space = pageStore.createSpace("system", "Architecture Space");
    const page = pageStore.createPage({
      spaceId: space.id,
      ownerId: "system",
      title: "System Architecture Overview",
      content: artifactContent,
      sourceRunId: runId,
    });
    assert.equal(page.revision, 1);

    // Update with optimistic revision check
    const updatedPage = pageStore.updatePage({
      id: page.id,
      ownerId: "system",
      expectedRevision: 1,
      content: artifactContent + "\nAppended verification proof.",
    });
    assert.equal(updatedPage.revision, 2);

    // -------------------------------------------------------------
    // Step 12: Telegram Completion Notification
    // -------------------------------------------------------------
    const posted = await telegramBot.postTaskCompletion(
      "987654321",
      task.id,
      {
        name: "architecture.md",
        sha256,
        filePath: artifactPath,
      }
    );
    assert.equal(posted, true);

    // -------------------------------------------------------------
    // Step 13: Quiet Heartbeat Evaluation
    // -------------------------------------------------------------
    const heartbeatEval1 = heartbeat.evaluate({
      tasks: [db.getTask(task.id)!],
      goals: [],
    });
    assert.equal(heartbeatEval1.deliver, true);

    // Second evaluation with identical state -> Quiet
    const heartbeatEval2 = heartbeat.evaluate({
      tasks: [db.getTask(task.id)!],
      goals: [],
    });
    assert.equal(heartbeatEval2.deliver, false);
    assert.equal(heartbeatEval2.message, QUIET);

    // -------------------------------------------------------------
    // Step 14: Restart Recovery Verification
    // -------------------------------------------------------------
    db.close();

    // Reopen database
    const reopenedDb = new NexoraDatabase(dbPath);
    try {
      const persistedTask = reopenedDb.getTask(task.id);
      assert.ok(persistedTask);
      assert.equal(persistedTask.status, "completed");

      const persistedRun = reopenedDb.getRun(runId);
      assert.ok(persistedRun);
      assert.equal(persistedRun.status, "completed");

      const persistedArtifact = reopenedDb.getArtifact("art-e2e-01");
      assert.ok(persistedArtifact);
      assert.equal(persistedArtifact.sha256, sha256);

      const events = reopenedDb.getEvents(runId);
      assert.ok(events.length >= 3);
      // Strictly monotonic seq
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].seq, i + 1);
      }
    } finally {
      reopenedDb.close();
    }
  });
});
