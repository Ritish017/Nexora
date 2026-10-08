/**
 * Nexora Local Interactive Console & Demo Server
 * 
 * Provides an easy-to-use local web interface for trying Nexora:
 * - Local demo mode (requires zero API keys, deterministic output)
 * - Separate Live AI mode (Gemini 3.8 Flash, verified free-only entitlement)
 * - Task submission, live worker progress, approval cards, and event history
 * - Backed by persistent SQLite WAL database
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { NexoraDatabase, TaskService } from "../packages/runtime/src/index.ts";
import { GeminiEngine } from "../packages/provider-engine/src/index.ts";
import { BudgetRouter, ReservationManager } from "../packages/budget-router/src/index.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = resolve("data");
const ARTIFACTS_DIR = resolve("artifacts");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true });

const dbPath = process.env.NEXORA_DB_PATH ?? join(DATA_DIR, "nexora.db");
const db = new NexoraDatabase(dbPath);
const taskService = new TaskService(db);
const budgetRouter = new BudgetRouter();
const reservationMgr = new ReservationManager();

const hasApiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
const geminiEngine = new GeminiEngine({ apiKey: process.env.GEMINI_API_KEY });

const DEMO_INTRO_TEXT = `# [LOCAL DEMO] Introduction to Nexora

> **Mode**: Local Demo Mode  
> **Integrity**: Deterministic Local Output (Zero API Keys / No External Network Calls)

---

## What is Nexora?
**Nexora** is a sovereign, crash-resilient hybrid personal agent operating system designed for governed autonomous execution. It provides a complete, local-first platform for durable AI operations:

1. **Durable Task Ledger & Restart Recovery**:
   - SQLite WAL task storage with monotonic event sequence numbering.
   - Worker lease fencing and automated crash recovery across unexpected reboots.
   - Guarantees tasks resume seamlessly without executing duplicate side-effects.

2. **Revision-Checked Document Canvas**:
   - Version-tracked document store with optimistic concurrency control.
   - Automatically synchronizes agent artifacts into document pages without overwriting human edits.

3. **Governed Sandboxed Computers**:
   - Container isolation with persistent browser profiles and workspace volumes.
   - Cryptographically derived per-agent credentials ensuring sandboxes never see master secrets.

---

## Verified Security Invariants
- **Strict Free-Only Routing**: Paid endpoints and credit overages are blocked at the engine boundary.
- **Cryptographic Action Approval**: Mutating operations require human authorization bound to exact argument hashes.
- **Quiet Proactivity Protocol**: Heartbeats and scheduled jobs remain completely silent unless critical action is required.
- **Outbound-Only Runner Fleet**: Secure pairing of secondary nodes without opening inbound network ports.

---
*Generated deterministically by Nexora Demo Worker on localhost.*`;

// Asynchronous worker loop
async function processTask(taskId: string, mode: "demo" | "live", requireApproval: boolean) {
  const claim = taskService.claimTask("worker-local-console", 60000, taskId);
  if (!claim) return;

  const runId = claim.run.id;

  try {
    if (mode === "demo") {
      // 1. Initialized
      taskService.emitEvent(runId, "item_started", {
        item: "demo_turn",
        label: "Starting Local Demo execution...",
        timestamp: Date.now(),
      });

      taskService.emitEvent(runId, "progress", {
        percent: 30,
        message: "Compiling deterministic introduction content...",
      });

      // 2. Gated approval check if requested
      if (requireApproval) {
        taskService.requestApproval(
          runId,
          "files_write",
          {
            path: "artifacts/nexora_intro_demo.md",
            description: "Save generated Nexora Introduction artifact to disk",
          },
          "workspace://artifacts/nexora_intro_demo.md",
          "worker-local-console",
          "1.0.0",
          300000
        );
        // Task remains in waiting_for_approval until user resolves it
        return;
      }

      // 3. Complete demo execution
      await finishDemoExecution(runId, taskId);
    } else {
      // Live Mode execution
      if (!hasApiKey) {
        taskService.failRun(runId, "Live AI mode requires GEMINI_API_KEY to be set in environment.");
        return;
      }

      // Free-only route validation
      const model = budgetRouter.route();
      const reservation = reservationMgr.reserve({
        runId,
        taskId,
        estimatedInputTokens: 500,
        estimatedOutputTokens: 1000,
      });

      taskService.emitEvent(runId, "item_started", {
        item: "gemini_turn",
        label: `Calling Google Gemini API (${model.id})...`,
        timestamp: Date.now(),
      });

      const outcome = await geminiEngine.runTurn({
        prompt: claim.task.description || claim.task.title,
        systemInstruction: "You are Nexora, a sovereign hybrid personal agent. Provide a concise, clear introduction to your capabilities.",
        sink: {
          onEvent: (event) => {
            if (event.type === "chunk" && typeof event.data === "string") {
              taskService.emitEvent(runId, "progress", { message: event.data.slice(0, 50) });
            }
          },
          onRequest: async () => ({ status: "declined", error: "mutations disabled during console turn" }),
        },
      });

      reservationMgr.reconcile({
        reservationId: reservation.id,
        actualInputTokens: outcome.usage?.inputTokens ?? 200,
        actualOutputTokens: outcome.usage?.outputTokens ?? 300,
        totalTokens: (outcome.usage?.inputTokens ?? 200) + (outcome.usage?.outputTokens ?? 300),
      });

      if (outcome.outcome === "completed") {
        const artifactPath = resolve(ARTIFACTS_DIR, "nexora_live_output.md");
        const liveContent = `# Nexora Live Output\n\n${outcome.text ?? ""}\n\n---\n*Generated by ${model.id} via official API.*`;
        writeFileSync(artifactPath, liveContent, "utf8");
        const sha256 = createHash("sha256").update(liveContent).digest("hex");

        const art = taskService.saveArtifact(
          runId,
          taskId,
          "nexora_live_output.md",
          artifactPath,
          "text/markdown",
          sha256,
          Buffer.byteLength(liveContent)
        );

        taskService.completeRun(runId, {
          output: outcome.text,
          artifactId: art.id,
          tokensUsed: outcome.usage,
        });
      } else {
        taskService.failRun(runId, outcome.error ?? "Gemini engine turn failed.");
      }
    }
  } catch (err: any) {
    taskService.failRun(runId, `Execution error: ${err.message ?? err}`);
  }
}

async function finishDemoExecution(runId: string, taskId: string) {
  const artifactPath = resolve(ARTIFACTS_DIR, "nexora_intro_demo.md");
  writeFileSync(artifactPath, DEMO_INTRO_TEXT, "utf8");
  const sha256 = createHash("sha256").update(DEMO_INTRO_TEXT).digest("hex");

  taskService.emitEvent(runId, "progress", {
    percent: 80,
    message: `Artifact written to disk (SHA-256: ${sha256.slice(0, 16)}...)`,
  });

  const artifact = taskService.saveArtifact(
    runId,
    taskId,
    "nexora_intro_demo.md",
    artifactPath,
    "text/markdown",
    sha256,
    Buffer.byteLength(DEMO_INTRO_TEXT)
  );

  taskService.emitEvent(runId, "item_completed", {
    item: "demo_turn",
    artifactId: artifact.id,
    timestamp: Date.now(),
  });

  taskService.completeRun(runId, {
    mode: "local-demo",
    summary: "Created deterministic introduction to Nexora",
    artifactId: artifact.id,
  });
}

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // --- HTML UI ---
  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderHtml());
  }

  // --- API: Status ---
  if (method === "GET" && url.pathname === "/api/status") {
    const queued = db.listQueuedTasks().length;
    const active = db.listActiveRuns().length;
    const total = db.listTasks().length;
    return sendJson(res, 200, {
      hasApiKey,
      dbPath,
      queuedTasks: queued,
      activeRuns: active,
      totalTasks: total,
    });
  }

  // --- API: List Tasks ---
  if (method === "GET" && url.pathname === "/api/tasks") {
    const tasks = db.listTasks();
    return sendJson(res, 200, { tasks });
  }

  // --- API: Get Task Details ---
  if (method === "GET" && url.pathname.startsWith("/api/tasks/")) {
    const taskId = url.pathname.replace("/api/tasks/", "");
    const task = db.getTask(taskId);
    if (!task) return sendJson(res, 404, { error: "Task not found" });

    const run = task.activeRunId ? db.getRun(task.activeRunId) : null;
    const events = run ? db.getEvents(run.id) : [];
    const artifacts = db.listArtifactsForTask(taskId);

    let pendingApproval = null;
    if (run && run.status === "waiting_for_approval") {
      const activeRuns = db.listActiveRuns();
      // find approval in DB
      const stmt = db.db.prepare("SELECT doc FROM approvals WHERE runId = ? AND status = 'pending'");
      const row = stmt.get(run.id) as { doc: string } | undefined;
      if (row) pendingApproval = JSON.parse(row.doc);
    }

    let artifactContent = null;
    if (artifacts.length > 0 && existsSync(artifacts[0].filePath)) {
      try {
        artifactContent = readFileSync(artifacts[0].filePath, "utf8");
      } catch {}
    }

    return sendJson(res, 200, {
      task,
      run,
      events,
      artifacts,
      artifactContent,
      pendingApproval,
    });
  }

  // --- API: Submit Task ---
  if (method === "POST" && url.pathname === "/api/tasks") {
    try {
      const body = await parseJsonBody(req);
      const title = String(body.title ?? "Create a short introduction to Nexora.");
      const description = String(body.description ?? title);
      const mode = body.mode === "live" ? "live" : "demo";
      const requireApproval = Boolean(body.requireApproval ?? true);

      const submission = taskService.submitTask({
        title,
        description,
        ownerId: "local-user",
        projectId: "nexora-console",
        idempotencyKey: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        input: { mode, requireApproval },
      });

      // Trigger background processing asynchronously
      setImmediate(() => {
        processTask(submission.task.id, mode, requireApproval);
      });

      return sendJson(res, 201, { task: submission.task });
    } catch (e: any) {
      return sendJson(res, 400, { error: e.message ?? String(e) });
    }
  }

  // --- API: Resolve Approval ---
  if (method === "POST" && url.pathname.startsWith("/api/approvals/")) {
    try {
      const approvalId = url.pathname.replace("/api/approvals/", "");
      const body = await parseJsonBody(req);
      const approved = Boolean(body.approved);
      const decidedBy = String(body.decidedBy ?? "local-owner");

      const resApproval = taskService.resolveApproval(approvalId, approved, decidedBy);

      // If approved, resume execution
      if (approved && resApproval.run.status === "running") {
        setImmediate(async () => {
          await finishDemoExecution(resApproval.run.id, resApproval.run.taskId);
        });
      }

      return sendJson(res, 200, {
        approval: resApproval.approval,
        run: resApproval.run,
      });
    } catch (e: any) {
      return sendJson(res, 400, { error: e.message ?? String(e) });
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n==========================================================`);
  console.log(`         NEXORA LOCAL INTERACTIVE CONSOLE READY          `);
  console.log(`==========================================================`);
  console.log(`  Local Browser URL : http://127.0.0.1:${PORT}`);
  console.log(`  Default Mode      : Local Demo Mode (Zero API Key Required)`);
  console.log(`  Live AI Mode      : ${hasApiKey ? "Available (GEMINI_API_KEY detected)" : "Disabled (No GEMINI_API_KEY in environment)"}`);
  console.log(`  Database Storage  : ${dbPath} (WAL Mode Enabled)`);
  console.log(`==========================================================\n`);
});

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexora Local Console</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --text: #f3f4f6;
      --text-muted: #94a3b8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
    }
    .logo-group h1 { font-size: 24px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .logo-group p { font-size: 13px; color: var(--text-muted); }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .badge-demo { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-live { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-db { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid #334155; }
    
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
    
    .mode-selector {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      background: #0b1120;
      padding: 4px;
      border-radius: 8px;
      border: 1px solid #1e293b;
    }
    .mode-tab {
      flex: 1;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      text-align: center;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--text-muted);
      transition: all 0.2s;
    }
    .mode-tab.active { background: #1e293b; color: #fff; font-weight: 600; }
    
    textarea {
      width: 100%;
      height: 90px;
      background: #0b1120;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      color: #fff;
      font-size: 14px;
      resize: vertical;
      margin-bottom: 12px;
      outline: none;
    }
    textarea:focus { border-color: var(--accent); }
    
    .quick-pill {
      display: inline-block;
      font-size: 12px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 16px;
      border: 1px dashed rgba(56, 189, 248, 0.4);
    }
    .quick-pill:hover { background: rgba(56, 189, 248, 0.2); }
    
    .form-options {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      font-size: 13px;
      color: var(--text-muted);
    }
    
    button.btn-submit {
      width: 100%;
      padding: 10px 16px;
      background: var(--accent);
      color: #0b1120;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    button.btn-submit:hover { background: var(--accent-hover); }
    button.btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
    
    /* Approval Card */
    .approval-alert {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { border-color: rgba(245, 158, 11, 0.4); }
      50% { border-color: rgba(245, 158, 11, 0.8); }
    }
    .approval-alert h3 { font-size: 14px; color: var(--warning); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .approval-meta { font-family: var(--mono); font-size: 12px; color: #cbd5e1; margin-bottom: 12px; }
    .approval-actions { display: flex; gap: 8px; }
    .btn-approve { background: var(--success); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; }
    .btn-deny { background: var(--danger); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; }
    
    /* Event Stream */
    .event-stream { max-height: 250px; overflow-y: auto; font-family: var(--mono); font-size: 12px; }
    .event-row { padding: 6px 8px; border-bottom: 1px solid #1e293b; display: flex; gap: 10px; }
    .event-seq { color: var(--accent); font-weight: 600; min-width: 45px; }
    .event-type { color: #f59e0b; min-width: 130px; }
    .event-msg { color: var(--text-muted); word-break: break-all; }
    
    /* Artifact View */
    .artifact-view {
      background: #0b1120;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 16px;
      font-size: 13px;
      max-height: 380px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-family: var(--mono);
    }
    
    .task-list { max-height: 180px; overflow-y: auto; }
    .task-item {
      padding: 8px 12px;
      border-bottom: 1px solid #1e293b;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-size: 13px;
    }
    .task-item:hover { background: #162032; }
    .task-item.active { background: #1e293b; border-left: 3px solid var(--accent); }
    
    .status-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
    }
    .status-queued { background: #334155; color: #cbd5e1; }
    .status-running { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .status-waiting_for_approval { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .status-completed { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .status-failed { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-group">
        <h1><span>⚡</span> Nexora Local Console</h1>
        <p>Sovereign Hybrid Personal Agent • Durable Perry Runtime + Governed OpenBot Computers</p>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <span id="modeBadge" class="badge badge-demo">● LOCAL DEMO MODE</span>
        <span class="badge badge-db">SQLite WAL: data/nexora.db</span>
      </div>
    </header>

    <div class="grid">
      <!-- LEFT COLUMN: Input & Tasks -->
      <div>
        <div class="card" style="margin-bottom: 24px;">
          <h2>1. Submit New Task</h2>
          
          <div class="mode-selector">
            <button id="tabDemo" class="mode-tab active" onclick="setMode('demo')">Local Demo (Zero API Key)</button>
            <button id="tabLive" class="mode-tab" onclick="setMode('live')">Live Gemini 3.8 Flash</button>
          </div>
          
          <div id="liveWarning" style="display:none; margin-bottom: 12px; font-size: 12px; color: var(--warning); padding: 8px; background: rgba(245, 158, 11, 0.1); border-radius: 6px;">
            ⚠️ Live AI mode requires GEMINI_API_KEY. Free-only routing strictly enforced.
          </div>

          <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 6px;">Task Prompt:</label>
          <textarea id="taskPrompt" placeholder="What should Nexora do?">Create a short introduction to Nexora.</textarea>
          
          <div class="quick-pill" onclick="setPrompt('Create a short introduction to Nexora.')">
            🎯 Demo Quick-Prompt: "Create a short introduction to Nexora."
          </div>

          <div class="form-options">
            <input type="checkbox" id="chkApproval" checked>
            <label for="chkApproval">Require human owner authorization before saving artifact</label>
          </div>

          <button id="btnSubmit" class="btn-submit" onclick="submitTask()">Submit Durable Task</button>
        </div>

        <div class="card">
          <h2>2. Persisted Task History <span style="font-size: 12px; color: var(--text-muted); font-weight: normal;">(Survives Restart)</span></h2>
          <div id="taskList" class="task-list">Loading tasks...</div>
        </div>
      </div>

      <!-- RIGHT COLUMN: Active Task, Approvals & Result -->
      <div>
        <!-- Approval Alert (Hidden by default) -->
        <div id="approvalCard" class="approval-alert" style="display: none;">
          <h3>⚠️ Action Authorization Required</h3>
          <p style="font-size: 12px; margin-bottom: 6px;">Worker paused: mutating action requires owner approval under supervised policy.</p>
          <div id="approvalMeta" class="approval-meta"></div>
          <div class="approval-actions">
            <button class="btn-approve" onclick="resolveApproval(true)">✅ Approve Action</button>
            <button class="btn-deny" onclick="resolveApproval(false)">❌ Deny Action</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 24px;">
          <h2>
            <span>Active Worker Activity</span>
            <span id="activeStatusPill" class="status-pill status-queued">QUEUED</span>
          </h2>
          
          <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
            <div><strong>Task:</strong> <span id="activeTitle">-</span></div>
            <div><strong>Active Run:</strong> <span id="activeRunId" style="font-family: var(--mono);">-</span></div>
          </div>

          <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px;">Monotonic Sequence Events:</div>
          <div id="eventStream" class="event-stream">
            <div style="color: var(--text-muted); padding: 8px;">No active task executing.</div>
          </div>
        </div>

        <div class="card">
          <h2>
            <span>Saved Result & Artifact</span>
            <span id="artifactBadge" style="font-size: 11px; color: var(--accent); font-weight: normal;"></span>
          </h2>
          <div id="artifactView" class="artifact-view">No artifact generated yet. Submit a task to view output.</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentMode = 'demo';
    let activeTaskId = null;
    let pendingApprovalId = null;
    let pollInterval = null;

    function setMode(mode) {
      currentMode = mode;
      document.getElementById('tabDemo').className = 'mode-tab' + (mode === 'demo' ? ' active' : '');
      document.getElementById('tabLive').className = 'mode-tab' + (mode === 'live' ? ' active' : '');
      const badge = document.getElementById('modeBadge');
      if (mode === 'demo') {
        badge.className = 'badge badge-demo';
        badge.innerText = '● LOCAL DEMO MODE';
        document.getElementById('liveWarning').style.display = 'none';
      } else {
        badge.className = 'badge badge-live';
        badge.innerText = '● LIVE AI MODE';
        document.getElementById('liveWarning').style.display = 'block';
      }
    }

    function setPrompt(text) {
      document.getElementById('taskPrompt').value = text;
    }

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (!data.hasApiKey) {
          document.getElementById('tabLive').innerText = 'Live AI (No API Key)';
        }
      } catch (e) {}
    }

    async function loadTasks() {
      try {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        const listEl = document.getElementById('taskList');
        if (!data.tasks || data.tasks.length === 0) {
          listEl.innerHTML = '<div style="padding: 12px; color: var(--text-muted);">No tasks in database.</div>';
          return;
        }
        listEl.innerHTML = data.tasks.map(t => \`
          <div class="task-item \${t.id === activeTaskId ? 'active' : ''}" onclick="selectTask('\${t.id}')">
            <div>
              <strong>\${t.title}</strong>
              <div style="font-size: 11px; color: var(--text-muted);">\${new Date(t.createdAt).toLocaleTimeString()} • \${t.id}</div>
            </div>
            <span class="status-pill status-\${t.status}">\${t.status}</span>
          </div>
        \`).join('');
      } catch (e) {}
    }

    async function selectTask(id) {
      activeTaskId = id;
      loadTaskDetails();
      loadTasks();
    }

    async function loadTaskDetails() {
      if (!activeTaskId) return;
      try {
        const res = await fetch('/api/tasks/' + activeTaskId);
        const data = await res.json();
        if (data.error) return;

        document.getElementById('activeTitle').innerText = data.task.title;
        document.getElementById('activeRunId').innerText = data.run ? data.run.id : 'none';
        
        const pill = document.getElementById('activeStatusPill');
        const status = data.run ? data.run.status : data.task.status;
        pill.className = 'status-pill status-' + status;
        pill.innerText = status;

        // Pending Approval
        if (data.pendingApproval) {
          pendingApprovalId = data.pendingApproval.id;
          document.getElementById('approvalCard').style.display = 'block';
          document.getElementById('approvalMeta').innerHTML = \`
            <strong>Action:</strong> \${data.pendingApproval.action}<br>
            <strong>Resource:</strong> \${data.pendingApproval.resource}<br>
            <strong>Actor:</strong> \${data.pendingApproval.actor}
          \`;
        } else {
          pendingApprovalId = null;
          document.getElementById('approvalCard').style.display = 'none';
        }

        // Events
        const streamEl = document.getElementById('eventStream');
        if (data.events && data.events.length > 0) {
          streamEl.innerHTML = data.events.map(e => \`
            <div class="event-row">
              <span class="event-seq">#\${e.seq}</span>
              <span class="event-type">\${e.type}</span>
              <span class="event-msg">\${e.payload.message || e.payload.label || JSON.stringify(e.payload)}</span>
            </div>
          \`).join('');
          streamEl.scrollTop = streamEl.scrollHeight;
        }

        // Artifact / Result
        const artEl = document.getElementById('artifactView');
        const artBadge = document.getElementById('artifactBadge');
        if (data.artifactContent) {
          artEl.innerText = data.artifactContent;
          if (data.artifacts && data.artifacts[0]) {
            artBadge.innerText = 'SHA-256: ' + data.artifacts[0].sha256.slice(0, 16) + '...';
          }
        } else if (data.run && data.run.status === 'failed') {
          artEl.innerText = '❌ Task Failed: ' + (data.run.error || 'Unknown error');
          artBadge.innerText = '';
        } else {
          artEl.innerText = 'Execution in progress... output will render upon completion.';
          artBadge.innerText = '';
        }

      } catch (e) {}
    }

    async function submitTask() {
      const prompt = document.getElementById('taskPrompt').value.trim();
      const requireApproval = document.getElementById('chkApproval').checked;
      const btn = document.getElementById('btnSubmit');

      btn.disabled = true;
      btn.innerText = 'Submitting...';

      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: prompt.slice(0, 50),
            description: prompt,
            mode: currentMode,
            requireApproval: requireApproval,
          })
        });
        const data = await res.json();
        if (data.task) {
          activeTaskId = data.task.id;
          await loadTasks();
          await loadTaskDetails();
        }
      } catch (e) {
        alert('Failed to submit task: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Submit Durable Task';
      }
    }

    async function resolveApproval(approved) {
      if (!pendingApprovalId) return;
      try {
        await fetch('/api/approvals/' + pendingApprovalId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved, decidedBy: 'local-owner' })
        });
        await loadTaskDetails();
      } catch (e) {
        alert('Failed to resolve approval: ' + e.message);
      }
    }

    // Poller
    loadStatus();
    loadTasks();
    setInterval(() => {
      loadTasks();
      if (activeTaskId) loadTaskDetails();
    }, 1000);
  </script>
</body>
</html>`;
}
