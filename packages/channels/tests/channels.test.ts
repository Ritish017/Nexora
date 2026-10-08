import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NexoraDatabase, TaskService } from "../../runtime/src/index.ts";
import {
  TelegramBotAdapter,
  UiCardPresenter,
} from "../src/index.ts";

describe("Phase 8: Telegram Bot Adapter & Task Triggering", () => {
  let tempDir: string;
  let db: NexoraDatabase;
  let taskService: TaskService;
  let bot: TelegramBotAdapter;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-channels-test-"));
    db = new NexoraDatabase(join(tempDir, "channels.db"));
    taskService = new TaskService(db);
    bot = new TelegramBotAdapter({
      chatId: "12345678",
      taskService,
    });
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("submits task via Telegram /task command", async () => {
    const update = {
      update_id: 101,
      message: {
        message_id: 501,
        chat: { id: "12345678" },
        from: { id: 9999, first_name: "Alice" },
        text: "/task Audit smart contract vulnerabilities",
      },
    };

    const reply = await bot.handleUpdate(update);
    assert.ok(reply);
    assert.match(reply, /Task submitted/);

    const queued = db.listQueuedTasks();
    assert.equal(queued.length, 1);
    assert.match(queued[0].title, /Audit smart contract/);
    assert.equal(queued[0].ownerId, "telegram:9999");
  });

  it("posts task completion notice with artifact link", async () => {
    const task = db.listQueuedTasks()[0];
    task.status = "completed";
    db.updateTask(task);

    const success = await bot.postTaskCompletion("12345678", task.id, {
      name: "audit_report.md",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      filePath: "artifacts/audit_report.md",
    });

    assert.equal(success, true);
    assert.ok(bot.outboundLog.length >= 2);
    const lastMsg = bot.outboundLog[bot.outboundLog.length - 1];
    assert.match(lastMsg.body.text, /Task Completed/);
    assert.match(lastMsg.body.text, /audit_report\.md/);
    assert.match(lastMsg.body.text, /e3b0c44298fc1c14/);
  });

  it("approves pending action via Telegram /approve command", async () => {
    // 1. Submit task and claim run
    const { task } = taskService.submitTask({
      title: "Mutating Action Task",
      description: "Needs approval",
      ownerId: "owner-alice",
      projectId: "default",
      idempotencyKey: "tg-approve-test",
    });
    const claim = taskService.claimTask("worker-1");
    assert.ok(claim);

    // 2. Request approval
    const approval = taskService.requestApproval(
      claim.run.id,
      "exec",
      { command: "npm run deploy" },
      "shell://local",
      "worker-1",
      "1.0.0",
      60000
    );

    // 3. Resolve approval via Telegram
    const update = {
      update_id: 102,
      message: {
        message_id: 502,
        chat: { id: "12345678" },
        from: { id: 9999 },
        text: `/approve ${approval.id}`,
      },
    };

    const reply = await bot.handleUpdate(update);
    assert.ok(reply);
    assert.match(reply, /Approval granted/);

    const updatedApproval = db.getApproval(approval.id);
    assert.equal(updatedApproval?.status, "approved");
  });
});

describe("Phase 8: UI Approval Cards & Human-Readable System UX", () => {
  it("renders exact proposed actions and risk classification in approval cards", () => {
    const approvalRecord = {
      id: "appr-card-1",
      runId: "run-99",
      action: "exec",
      argumentsHash: "dummy-hash",
      resource: "shell://container-1",
      actor: "agent-coder",
      policyVersion: "1.0.0",
      expiry: Date.now() + 60000,
      status: "pending" as const,
      decisionBy: null,
      decisionAt: null,
    };

    const card = UiCardPresenter.renderApprovalCard(approvalRecord, {
      command: "rm -rf build/",
    });

    assert.equal(card.approvalId, "appr-card-1");
    assert.equal(card.humanReadableTitle, "Terminal Command Execution");
    assert.match(card.humanReadableDescription, /rm -rf build\//);
    assert.equal(card.riskLevel, "high"); // dangerous rm command flagged as high risk
  });

  it("formats comprehensive system dashboard summary text", () => {
    const summary = UiCardPresenter.formatDashboardSummary({
      quota: {
        status: "healthy",
        message: "Free-only tier (Gemini 3.8 Flash) active. 0 paid overages.",
      },
      approvals: {
        pendingCount: 1,
        pendingCards: [
          {
            approvalId: "appr-01",
            action: "files_write",
            arguments: { path: "src/index.ts" },
            resource: "workspace://files",
            actor: "agent-builder",
            runId: "run-1",
            status: "pending",
            humanReadableTitle: "File Modification",
            humanReadableDescription: "Write file at `src/index.ts`",
            riskLevel: "medium",
          },
        ],
      },
      runners: {
        onlineCount: 2,
        offlineCount: 1,
        list: [
          { id: "r1", name: "Worker-Local", status: "online" },
          { id: "r2", name: "Worker-MacBook", status: "online" },
          { id: "r3", name: "Worker-Cloud", status: "offline" },
        ],
      },
    });

    assert.match(summary, /NEXORA SYSTEM OVERVIEW/);
    assert.match(summary, /Free-only tier/);
    assert.match(summary, /1 pending/);
    assert.match(summary, /Worker-Local \(online\)/);
    assert.match(summary, /Worker-Cloud \(offline\)/);
  });
});
