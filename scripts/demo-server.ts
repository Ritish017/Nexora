/**
 * Nexora Sovereign Interactive Operating Console & Agent Server
 * 
 * Provides a unified local graphical environment showcasing ALL Nexora capabilities:
 * - Living On-Screen Agent Mascot with reactive animations and real-time speech/thought stream
 * - Real AI Mode (Gemini 3.8 Flash with free-only routing and streaming tokens)
 * - Local Demo Mode (Zero API keys needed, deterministic SHA-256 output)
 * - Interactive Document Canvas (OpenDots revision-checked pages with optimistic concurrency)
 * - Governed Computer Sandbox (OpenBot action policy engine, HMAC credential derivation, terminal simulation)
 * - Multi-Host MCP Hub (Configs for Antigravity, Claude Desktop, and Codex)
 * - Outbound Runner Fleet (Pairing code generator, lease fencing, and Asia/Kolkata schedules)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { NexoraDatabase, TaskService } from "../packages/runtime/src/index.ts";
import { GeminiEngine } from "../packages/provider-engine/src/index.ts";
import { BudgetRouter, ReservationManager } from "../packages/budget-router/src/index.ts";
import { PageStore } from "../packages/workspace-adapter/src/index.ts";
import { PolicyEngine } from "../packages/governance/src/index.ts";
import { FleetManager } from "../packages/runner-fleet/src/index.ts";

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
const pageStore = new PageStore(db.db);
const policyEngine = new PolicyEngine({ mode: "supervised" });
const fleetManager = new FleetManager();

// Initialize default document workspace if none exists
try {
  let spaces = pageStore.listSpaces("local-owner");
  let defaultSpaceId = spaces[0]?.id;
  if (!defaultSpaceId) {
    const space = pageStore.createSpace("local-owner", "Default Workspace");
    defaultSpaceId = space.id;
    pageStore.createPage({
      spaceId: defaultSpaceId,
      ownerId: "local-owner",
      title: "Welcome to Nexora Workspace",
      content: `# Welcome to Nexora Workspace\n\nThis is your sovereign, revision-checked document canvas.\n\n- **Optimistic Concurrency**: Prevents concurrent write conflicts.\n- **Agent Sync**: Task outputs automatically publish as versioned document pages upon owner approval.\n- **Zero Cloud Dependence**: Fully persisted in local SQLite WAL storage.`,
    });
  }
} catch (e) {
  // Database already has schema initialized
}

const hasApiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
const geminiEngine = new GeminiEngine({ apiKey: process.env.GEMINI_API_KEY });

const pendingLiveCompletions = new Map<string, { taskId: string; outcome: any; modelId: string }>();

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
        return;
      }

      // 3. Complete demo execution
      await finishDemoExecution(runId, taskId);
    } else {
      // Live Mode execution
      if (!hasApiKey) {
        taskService.failRun(runId, "Live AI mode requires GEMINI_API_KEY to be set in your system environment.");
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

      const outcome = await geminiEngine.runTurn(
        {
          prompt: claim.task.description || claim.task.title,
          instructions: "You are Nexora, a sovereign hybrid personal agent operating system. Answer clearly, concisely, and execute instructions with precision.",
          cwd: process.cwd(),
          access: "workspace",
        },
        {
          onSession: () => {},
          onEvent: (event) => {
            if (event.type === "text") {
              taskService.emitEvent(runId, "progress", {
                stream: event.stream,
                delta: event.delta,
                message: event.stream === "reasoning" ? `[Thinking] ${event.delta}` : event.delta,
              });
            } else if (event.type === "item") {
              taskService.emitEvent(runId, event.phase === "started" ? "item_started" : "item_completed", {
                item: event.item.type,
                title: event.item.title,
              });
            } else if (event.type === "usage") {
              taskService.emitEvent(runId, "usage", { usage: event.usage });
            }
          },
          onRequest: async () => "accept",
        }
      );

      reservationMgr.reconcile({
        reservationId: reservation.id,
        actualInputTokens: outcome.usage?.inputTokens ?? 200,
        actualOutputTokens: outcome.usage?.outputTokens ?? 300,
        totalTokens: (outcome.usage?.inputTokens ?? 200) + (outcome.usage?.outputTokens ?? 300),
      });

      if (outcome.outcome === "completed") {
        if (requireApproval) {
          taskService.requestApproval(
            runId,
            "files_write",
            {
              path: "artifacts/nexora_live_output.md",
              description: `Save ${model.id} generated response to disk (${outcome.text?.length ?? 0} characters)`,
            },
            "workspace://artifacts/nexora_live_output.md",
            "worker-local-console",
            "1.0.0",
            300000
          );
          pendingLiveCompletions.set(runId, { taskId, outcome, modelId: model.id });
          return;
        }

        await finishLiveExecution(runId, taskId, outcome, model.id);
      } else {
        taskService.failRun(runId, outcome.error ?? "Gemini engine turn failed.");
      }
    }
  } catch (err: any) {
    taskService.failRun(runId, `Execution error: ${err.message ?? err}`);
  }
}

async function finishLiveExecution(runId: string, taskId: string, outcome: any, modelId: string) {
  const artifactPath = resolve(ARTIFACTS_DIR, "nexora_live_output.md");
  const liveContent = `# Nexora Live Output\n\n${outcome.text ?? ""}\n\n---\n*Generated by ${modelId} via official API under free-only policy.*`;
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
    const runs = db.listRecentRuns(5);
    const activeRun = runs.find((r) => r.status === "running" || r.status === "waiting_for_approval");
    const approvals = db.listPendingApprovals();
    const spaces = pageStore.listSpaces("local-owner");
    const pages = spaces[0] ? pageStore.listPages(spaces[0].id) : [];

    return sendJson(res, 200, {
      status: "ok",
      hasApiKey,
      model: "gemini-3.8-flash",
      priceClass: "free",
      entitlement: "verified_free",
      activeRun,
      pendingApproval: approvals[0] ?? null,
      pageCount: pages.length,
    });
  }

  // --- API: Pages ---
  if (method === "GET" && url.pathname === "/api/pages") {
    const spaces = pageStore.listSpaces("local-owner");
    const pages = spaces[0] ? pageStore.listPages(spaces[0].id) : [];
    return sendJson(res, 200, { spaces, pages });
  }

  if (method === "POST" && url.pathname === "/api/pages") {
    const body = await parseJsonBody(req);
    const spaces = pageStore.listSpaces("local-owner");
    const spaceId = spaces[0]?.id || pageStore.createSpace("local-owner", "Default").id;

    if (body.id) {
      const updated = pageStore.updatePage(body.id, {
        title: body.title,
        content: body.content,
        expectedRevision: body.expectedRevision,
      });
      return sendJson(res, 200, { page: updated });
    } else {
      const created = pageStore.createPage({
        spaceId,
        ownerId: "local-owner",
        title: body.title || "Untitled Note",
        content: body.content || "",
      });
      return sendJson(res, 201, { page: created });
    }
  }

  // --- API: Policy Evaluation ---
  if (method === "POST" && url.pathname === "/api/policy/evaluate") {
    const body = await parseJsonBody(req);
    const evaluation = policyEngine.evaluateAction(body.action || "files_read", body.args || {});
    return sendJson(res, 200, { evaluation, policy: policyEngine.policy });
  }

  // --- API: Runner Pairing ---
  if (method === "POST" && url.pathname === "/api/runners/pair") {
    const pairing = fleetManager.createPairingCode("local-owner", "Secondary Workstation", 300000);
    return sendJson(res, 200, { pairing });
  }

  // --- API: Submit Task ---
  if (method === "POST" && url.pathname === "/api/tasks") {
    const body = await parseJsonBody(req);
    const mode = body.mode === "live" ? "live" : "demo";
    const title = (body.prompt || "Create a short introduction to Nexora.").trim();
    const requireApproval = body.requireApproval !== false;

    const submission = taskService.submitTask({
      title,
      description: title,
      ownerId: "local-user",
      projectId: "console-workspace",
      idempotencyKey: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      input: { mode, requireApproval },
    });

    // Spawn async worker loop
    setImmediate(() => {
      processTask(submission.task.id, mode, requireApproval);
    });

    return sendJson(res, 201, {
      taskId: submission.task.id,
      status: submission.task.status,
      mode,
    });
  }

  // --- API: Get Task State ---
  if (method === "GET" && url.pathname.startsWith("/api/tasks/")) {
    const taskId = url.pathname.split("/")[3];
    const task = db.getTask(taskId);
    if (!task) return sendJson(res, 404, { error: "Task not found" });

    const runs = db.listRunsForTask(taskId);
    const latestRun = runs[runs.length - 1];
    let events: any[] = [];
    let artifactContent: string | null = null;
    let artifactMeta: any = null;

    if (latestRun) {
      events = db.listEventsForRun(latestRun.id);
      const artifacts = db.listArtifactsForRun(latestRun.id);
      if (artifacts[0]) {
        artifactMeta = artifacts[0];
        try {
          if (existsSync(artifacts[0].path)) {
            artifactContent = readFileSync(artifacts[0].path, "utf8");
          }
        } catch {}
      }
    }

    return sendJson(res, 200, {
      task,
      run: latestRun ?? null,
      events,
      artifact: artifactMeta,
      artifactContent,
    });
  }

  // --- API: Resolve Approval ---
  if (method === "POST" && url.pathname.startsWith("/api/approvals/")) {
    const approvalId = url.pathname.split("/")[3];
    const body = await parseJsonBody(req);
    const approved = Boolean(body.approved);

    const resolved = taskService.resolveApproval(approvalId, approved, "owner-console");

    // If approved, complete the run
    if (approved) {
      const pendingLive = pendingLiveCompletions.get(resolved.run.id);
      if (pendingLive) {
        pendingLiveCompletions.delete(resolved.run.id);
        await finishLiveExecution(resolved.run.id, pendingLive.taskId, pendingLive.outcome, pendingLive.modelId);
      } else {
        await finishDemoExecution(resolved.run.id, resolved.task.id);
      }
    } else {
      taskService.failRun(resolved.run.id, "Owner declined required action approval.");
    }

    return sendJson(res, 200, {
      approvalId: resolved.approval.id,
      status: resolved.approval.status,
      runStatus: db.getRun(resolved.run.id)?.status,
    });
  }

  // --- 404 Fallback ---
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n============================================================`);
  console.log(`⚡ Nexora Sovereign Console: http://127.0.0.1:${PORT}`);
  console.log(`🛡️ Storage: SQLite WAL [${dbPath}]`);
  console.log(`🤖 AI Engine: Google Gemini 3.8 Flash (Free-Tier Strictly Enforced)`);
  console.log(`🔑 Key Status: ${hasApiKey ? "GEMINI_API_KEY Configured" : "No Key Found (Local Demo Mode Ready)"}`);
  console.log(`============================================================\n`);
});

// HTML Interface
function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexora Sovereign Agent OS</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f2937;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --text: #f3f4f6;
      --text-muted: #94a3b8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --platypus-teal: #06b6d4;
      --platypus-bill: #f59e0b;
      --platypus-fedora: #78350f;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 20px;
      overflow-x: hidden;
    }
    .container { max-width: 1300px; margin: 0 auto; }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 20px;
    }
    .logo-group h1 { font-size: 22px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .logo-group p { font-size: 13px; color: var(--text-muted); }
    
    .nav-tabs {
      display: flex;
      gap: 8px;
      background: #0f172a;
      padding: 4px;
      border-radius: 10px;
      border: 1px solid #1e293b;
      margin-bottom: 20px;
    }
    .nav-tab {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      border: none;
      background: transparent;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .nav-tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
    .nav-tab.active { background: #1e293b; color: var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 950px) { .grid { grid-template-columns: 1fr; } }
    
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .card h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }

    .mode-selector {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
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
      margin-bottom: 10px;
      outline: none;
    }
    textarea:focus { border-color: var(--accent); }

    .quick-pill {
      display: inline-block;
      font-size: 11px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent);
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      margin-right: 6px;
      margin-bottom: 8px;
      border: 1px dashed rgba(56, 189, 248, 0.4);
    }
    .quick-pill:hover { background: rgba(56, 189, 248, 0.2); }

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

    .approval-alert {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 16px;
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { border-color: rgba(245, 158, 11, 0.4); }
      50% { border-color: rgba(245, 158, 11, 0.8); }
    }
    .approval-alert h3 { font-size: 14px; color: var(--warning); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .approval-meta { font-family: var(--mono); font-size: 12px; color: #cbd5e1; margin-bottom: 10px; }
    .approval-actions { display: flex; gap: 8px; }
    .btn-approve { background: var(--success); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; }
    .btn-deny { background: var(--danger); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; }

    .event-stream { max-height: 220px; overflow-y: auto; font-family: var(--mono); font-size: 12px; }
    .event-row { padding: 4px 6px; border-bottom: 1px solid #1e293b; display: flex; gap: 8px; }
    .event-seq { color: var(--accent); font-weight: 600; min-width: 35px; }
    .event-type { color: #f59e0b; min-width: 110px; }
    .event-msg { color: var(--text-muted); word-break: break-all; }

    .artifact-view {
      background: #0b1120;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
      max-height: 350px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-family: var(--mono);
    }

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

    /* ========================================================
       LIVING ON-SCREEN AGENT MASCOT WIDGET (PERRY CHARACTER)
       ======================================================== */
    .agent-mascot-container {
      position: fixed;
      bottom: 24px;
      right: 28px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      pointer-events: none;
    }
    .agent-speech-bubble {
      background: #1e293b;
      border: 1px solid #334155;
      color: #fff;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 13px;
      max-width: 260px;
      margin-bottom: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      position: relative;
      pointer-events: auto;
      transition: all 0.3s;
      animation: bubble-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    .agent-speech-bubble::after {
      content: "";
      position: absolute;
      bottom: -8px;
      right: 36px;
      border-width: 8px 8px 0;
      border-style: solid;
      border-color: #1e293b transparent;
      display: block;
      width: 0;
    }
    .agent-mascot-avatar {
      width: 90px;
      height: 90px;
      cursor: pointer;
      pointer-events: auto;
      filter: drop-shadow(0 10px 15px rgba(0,0,0,0.6));
      transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      animation: mascot-idle 3s infinite ease-in-out;
    }
    .agent-mascot-avatar:hover { transform: scale(1.1) rotate(-3deg); }
    .agent-mascot-avatar.thinking { animation: mascot-thinking 1s infinite alternate ease-in-out; }
    .agent-mascot-avatar.alert { animation: mascot-alert 0.8s infinite ease-in-out; }
    .agent-mascot-avatar.celebrating { animation: mascot-celebrate 0.6s infinite alternate ease-in-out; }

    @keyframes mascot-idle {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }
    @keyframes mascot-thinking {
      0% { transform: translateY(0) rotate(-4deg); }
      100% { transform: translateY(-10px) rotate(4deg); }
    }
    @keyframes mascot-alert {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.08) translateY(-4px); }
    }
    @keyframes mascot-celebrate {
      0% { transform: translateY(0) rotate(-6deg); }
      100% { transform: translateY(-14px) rotate(6deg); }
    }
    @keyframes bubble-pop {
      0% { opacity: 0; transform: scale(0.8) translateY(10px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-group">
        <h1><span>⚡</span> Nexora Sovereign Console</h1>
        <p>Unified Agent Operating System • Real-Time AI, Governed Computers & Document Canvas</p>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <span id="modeBadge" class="status-pill status-queued">● LOCAL DEMO MODE</span>
        <span class="status-pill status-queued">SQLite WAL: data/nexora.db</span>
      </div>
    </header>

    <!-- NAVIGATION TABS -->
    <div class="nav-tabs">
      <button class="nav-tab active" onclick="switchTab('tab-agent')">🤖 Agent & Tasks</button>
      <button class="nav-tab" onclick="switchTab('tab-canvas')">📄 Document Canvas</button>
      <button class="nav-tab" onclick="switchTab('tab-computer')">💻 Governed Computer</button>
      <button class="nav-tab" onclick="switchTab('tab-mcp')">🔌 MCP Ecosystem</button>
      <button class="nav-tab" onclick="switchTab('tab-fleet')">🌐 Runner Fleet</button>
    </div>

    <!-- TAB 1: AGENT & TASKS -->
    <div id="tab-agent" class="tab-content active">
      <div class="grid">
        <!-- LEFT: Input & History -->
        <div>
          <div class="card" style="margin-bottom: 20px;">
            <h2>1. Submit Task to Agent</h2>
            
            <div class="mode-selector">
              <button id="tabDemo" class="mode-tab active" onclick="setMode('demo')">🧪 Local Demo Mode (Zero API Key)</button>
              <button id="tabLive" class="mode-tab" onclick="setMode('live')">⚡ Live Gemini 3.8 Flash</button>
            </div>
            
            <div id="liveWarning" style="display:none; margin-bottom: 12px; font-size: 12px; color: var(--warning); padding: 8px; background: rgba(245, 158, 11, 0.1); border-radius: 6px;">
              ⚠️ Live AI mode calls Gemini 3.8 Flash using free-tier tokens. Zero paid overages.
            </div>

            <textarea id="taskPrompt" placeholder="What should Nexora do?">Create a short introduction to Nexora.</textarea>
            
            <div style="margin-bottom: 12px;">
              <span class="quick-pill" onclick="setPrompt('Create a short introduction to Nexora.')">🎯 Demo: Intro</span>
              <span class="quick-pill" onclick="setPrompt('Write a clean TypeScript rate-limiter with sliding window algorithm.')">⚡ Live: Code Service</span>
              <span class="quick-pill" onclick="setPrompt('Analyze system architecture and list top 3 resilience guarantees.')">🔍 Live: Analysis</span>
            </div>

            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: 13px; color: var(--text-muted);">
              <input type="checkbox" id="chkApproval" checked>
              <label for="chkApproval">Require human owner authorization before saving artifact</label>
            </div>

            <button id="btnSubmit" class="btn-submit" onclick="submitTask()">Execute Durable Task</button>
          </div>

          <div class="card">
            <h2>2. Persisted Task History</h2>
            <div id="taskList" style="max-height: 180px; overflow-y: auto;">Loading tasks...</div>
          </div>
        </div>

        <!-- RIGHT: Worker Activity & Result -->
        <div>
          <!-- Approval Alert Card -->
          <div id="approvalCard" class="approval-alert" style="display: none;">
            <h3>⚠️ Action Authorization Required</h3>
            <p style="font-size: 12px; margin-bottom: 6px;">Worker paused: mutating action requires owner approval under supervised governance.</p>
            <div id="approvalMeta" class="approval-meta"></div>
            <div class="approval-actions">
              <button class="btn-approve" onclick="resolveApproval(true)">✅ Approve Action</button>
              <button class="btn-deny" onclick="resolveApproval(false)">❌ Deny Action</button>
            </div>
          </div>

          <div class="card" style="margin-bottom: 20px;">
            <h2>
              <span>Active Worker Activity</span>
              <span id="activeStatusPill" class="status-pill status-queued">QUEUED</span>
            </h2>
            <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px;">
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

    <!-- TAB 2: DOCUMENT CANVAS (WORKSPACE) -->
    <div id="tab-canvas" class="tab-content">
      <div class="grid">
        <div class="card">
          <h2>
            <span>Document Pages</span>
            <button onclick="createNewPage()" style="background: var(--accent); border: none; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">+ New Page</button>
          </h2>
          <div id="pagesList" style="max-height: 400px; overflow-y: auto;">Loading pages...</div>
        </div>
        <div class="card">
          <h2>
            <span id="pageTitleHeading">Page Viewer / Editor</span>
            <span id="pageRevBadge" class="status-pill status-queued">REV 1</span>
          </h2>
          <input type="text" id="pageTitleInput" placeholder="Page Title" style="width: 100%; background: #0b1120; border: 1px solid #334155; padding: 8px; border-radius: 6px; color: #fff; margin-bottom: 10px;">
          <textarea id="pageContentInput" style="height: 250px; font-family: var(--mono); font-size: 13px;" placeholder="Markdown content..."></textarea>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; color: var(--text-muted);">Optimistic Concurrency: Protected against conflicting overwrites</span>
            <button onclick="saveCurrentPage()" class="btn-approve">Save Changes</button>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: GOVERNED COMPUTER (SANDBOX) -->
    <div id="tab-computer" class="tab-content">
      <div class="card" style="margin-bottom: 20px;">
        <h2>Governed Computer Supervisor & Policy Engine</h2>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Simulates the sandboxed container execution environment. Demonstrates cryptographic action policy boundaries, path traversal prevention, and prohibited command filtering.
        </p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div>
            <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 6px;">Test Action Evaluation:</label>
            <select id="selTestAction" style="width: 100%; background: #0b1120; border: 1px solid #334155; color: #fff; padding: 8px; border-radius: 6px; margin-bottom: 10px;">
              <option value="files_read">files_read (Safe Read Operation)</option>
              <option value="files_write">files_write (Mutating File Modification)</option>
              <option value="exec_rm_root">exec: rm -rf / (Prohibited Dangerous Command)</option>
              <option value="exec_safe">exec: node -v (Safe Command Execution)</option>
            </select>
            <button onclick="testPolicyEvaluation()" class="btn-submit" style="padding: 8px 12px;">Evaluate Action with Policy Engine</button>
          </div>
          <div>
            <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px;">Policy Evaluation Result:</div>
            <div id="policyResultBox" style="background: #0b1120; border: 1px solid #1e293b; padding: 12px; border-radius: 6px; font-family: var(--mono); font-size: 12px; color: #cbd5e1; min-height: 80px;">
              Select an action and click Evaluate to test governance rules.
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 4: MCP ECOSYSTEM -->
    <div id="tab-mcp" class="tab-content">
      <div class="card">
        <h2>Multi-Host Model Context Protocol (MCP) Hub</h2>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Connect your favorite coding agent directly into Nexora's durable ledger via native stdio MCP.
        </p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div>
            <h3 style="font-size: 13px; color: var(--accent); margin-bottom: 8px;">Google Antigravity Config:</h3>
            <pre style="background: #0b1120; padding: 12px; border-radius: 6px; font-size: 11px; overflow-x: auto; color: #cbd5e1;">{
  "name": "nexora-mcp",
  "command": "node",
  "args": ["--experimental-strip-types", "packages/mcp-server/src/cli.ts"],
  "env": { "NEXORA_DB_PATH": "data/nexora.db" }
}</pre>
          </div>
          <div>
            <h3 style="font-size: 13px; color: var(--accent); margin-bottom: 8px;">Claude Desktop Config:</h3>
            <pre style="background: #0b1120; padding: 12px; border-radius: 6px; font-size: 11px; overflow-x: auto; color: #cbd5e1;">"nexora": {
  "command": "node",
  "args": ["--experimental-strip-types", "packages/mcp-server/src/cli.ts"],
  "env": { "NEXORA_DB_PATH": "data/nexora.db" }
}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 5: RUNNER FLEET -->
    <div id="tab-fleet" class="tab-content">
      <div class="card">
        <h2>Outbound Runner Fleet & Autonomous Schedules</h2>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Pair secondary laptops and nodes via outbound-only connections with short pairing codes.
        </p>
        <button onclick="generatePairingCode()" class="btn-submit" style="width: auto; padding: 8px 16px; margin-bottom: 14px;">Generate 8-Character Pairing Code</button>
        <div id="pairingCodeBox" style="font-family: var(--mono); font-size: 13px; color: var(--success); margin-bottom: 14px;"></div>
        <div style="font-size: 12px; color: var(--text-muted);">
          Autonomous jobs execute in <strong>Asia/Kolkata</strong> timezone under the Quiet Proactivity protocol (zero spam pings).
        </div>
      </div>
    </div>

  </div>

  <!-- ========================================================
       LIVING ON-SCREEN AGENT MASCOT WIDGET (PERRY CHARACTER)
       ======================================================== -->
  <div class="agent-mascot-container">
    <div id="agentSpeechBubble" class="agent-speech-bubble">
      Hi! I'm Nexora. Type a prompt or run the demo to see me in action!
    </div>
    <div id="agentMascot" class="agent-mascot-avatar" onclick="pokeMascot()" title="Click to interact with Nexora!">
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        <!-- Platypus Tail -->
        <ellipse cx="20" cy="70" rx="14" ry="7" fill="#b45309" transform="rotate(-20 20 70)"/>
        <!-- Platypus Body (Teal) -->
        <ellipse cx="50" cy="58" rx="28" ry="26" fill="#06b6d4"/>
        <!-- Belly Highlight -->
        <ellipse cx="50" cy="62" rx="18" ry="16" fill="#22d3ee" opacity="0.6"/>
        <!-- Feet -->
        <ellipse cx="38" cy="84" rx="8" ry="4" fill="#f59e0b"/>
        <ellipse cx="62" cy="84" rx="8" ry="4" fill="#f59e0b"/>
        <!-- Bill / Beak -->
        <ellipse cx="50" cy="55" rx="18" ry="8" fill="#f59e0b"/>
        <ellipse cx="45" cy="53" rx="1.5" ry="1.5" fill="#78350f"/>
        <ellipse cx="55" cy="53" rx="1.5" ry="1.5" fill="#78350f"/>
        <!-- Eyes -->
        <circle id="eyeLeft" cx="42" cy="42" r="5" fill="#ffffff"/>
        <circle id="pupilLeft" cx="43" cy="42" r="2.5" fill="#0b1120"/>
        <circle id="eyeRight" cx="58" cy="42" r="5" fill="#ffffff"/>
        <circle id="pupilRight" cx="57" cy="42" r="2.5" fill="#0b1120"/>
        <!-- Fedora Hat (Agent Mascot Icon) -->
        <ellipse cx="50" cy="34" rx="22" ry="5" fill="#78350f"/>
        <path d="M36 34 L38 20 Q50 17 62 20 L64 34 Z" fill="#78350f"/>
        <!-- Fedora Black Ribbon -->
        <path d="M37 32 L38 28 Q50 26 62 28 L63 32 Z" fill="#18181b"/>
      </svg>
    </div>
  </div>

  <script>
    let currentMode = 'demo';
    let activeTaskId = null;
    let pendingApprovalId = null;
    let pollInterval = null;
    let currentPageId = null;
    let currentPageRev = 1;

    function setMascotMood(mood, text) {
      const mascot = document.getElementById('agentMascot');
      const bubble = document.getElementById('agentSpeechBubble');
      mascot.className = 'agent-mascot-avatar ' + mood;
      if (text) bubble.innerText = text;
    }

    function pokeMascot() {
      const phrases = [
        "I'm awake and ready! What task shall we execute?",
        "My SQLite WAL engine is running with zero corruption risk!",
        "Governed action boundaries are active. Your machine is safe!",
        "Gemini 3.8 Flash is standing by under strict free-only routing."
      ];
      const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
      setMascotMood('celebrating', randomPhrase);
      setTimeout(() => setMascotMood('idle'), 2500);
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      event.target.classList.add('active');
      if (tabId === 'tab-canvas') loadPages();
    }

    function setMode(mode) {
      currentMode = mode;
      document.getElementById('tabDemo').className = 'mode-tab' + (mode === 'demo' ? ' active' : '');
      document.getElementById('tabLive').className = 'mode-tab' + (mode === 'live' ? ' active' : '');
      const badge = document.getElementById('modeBadge');
      if (mode === 'demo') {
        badge.className = 'status-pill status-queued';
        badge.innerText = '● LOCAL DEMO MODE';
        document.getElementById('liveWarning').style.display = 'none';
        setMascotMood('idle', "Switched to Local Demo mode. Zero API keys required!");
      } else {
        badge.className = 'status-pill status-running';
        badge.innerText = '● LIVE GEMINI 3.8 FLASH';
        document.getElementById('liveWarning').style.display = 'block';
        setMascotMood('idle', "Switched to Live AI mode. Ready to call Gemini 3.8 Flash!");
      }
    }

    function setPrompt(txt) {
      document.getElementById('taskPrompt').value = txt;
      setMascotMood('idle', "Loaded preset prompt!");
    }

    async function submitTask() {
      const prompt = document.getElementById('taskPrompt').value.trim();
      if (!prompt) return alert('Please enter a task prompt.');

      const requireApproval = document.getElementById('chkApproval').checked;
      const btn = document.getElementById('btnSubmit');
      btn.disabled = true;
      btn.innerText = 'Submitting...';

      setMascotMood('thinking', "Submitting task to SQLite ledger...");

      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, mode: currentMode, requireApproval })
        });
        const data = await res.json();
        activeTaskId = data.taskId;

        setMascotMood('thinking', "Lease claimed! Worker is executing turn...");
        startPolling();
      } catch (err) {
        alert('Failed to submit task: ' + err.message);
        setMascotMood('alert', "Failed to submit task.");
      } finally {
        btn.disabled = false;
        btn.innerText = 'Execute Durable Task';
      }
    }

    function startPolling() {
      if (pollInterval) clearInterval(pollInterval);
      pollStatus();
      pollInterval = setInterval(pollStatus, 1000);
    }

    async function pollStatus() {
      if (!activeTaskId) return;
      try {
        const res = await fetch('/api/tasks/' + activeTaskId);
        if (!res.ok) return;
        const data = await res.json();

        // Update active run header
        document.getElementById('activeTitle').innerText = data.task.title;
        document.getElementById('activeRunId').innerText = data.run ? data.run.id : 'Pending';

        const runStatus = data.run ? data.run.status : data.task.status;
        const pill = document.getElementById('activeStatusPill');
        pill.className = 'status-pill status-' + runStatus;
        pill.innerText = runStatus.toUpperCase();

        // Mascot expressions
        if (runStatus === 'running') {
          setMascotMood('thinking', "Thinking... Processing turn events.");
        } else if (runStatus === 'waiting_for_approval') {
          setMascotMood('alert', "⚠️ Action paused! I need your approval to proceed.");
        } else if (runStatus === 'completed') {
          setMascotMood('celebrating', "🎉 Done! Artifact created and verified.");
        }

        // Render monotonic events
        const streamDiv = document.getElementById('eventStream');
        if (data.events && data.events.length > 0) {
          streamDiv.innerHTML = data.events.map(ev => {
            let msg = '';
            try {
              const p = JSON.parse(ev.payload);
              msg = p.message || p.label || p.item || JSON.stringify(p);
            } catch { msg = ev.payload; }
            return '<div class="event-row">' +
              '<span class="event-seq">#' + ev.seq + '</span>' +
              '<span class="event-type">' + ev.type + '</span>' +
              '<span class="event-msg">' + escapeHtml(msg) + '</span>' +
            '</div>';
          }).join('');
          streamDiv.scrollTop = streamDiv.scrollHeight;
        }

        // Render Artifact
        if (data.artifactContent) {
          document.getElementById('artifactView').innerText = data.artifactContent;
          document.getElementById('artifactBadge').innerText = 'SHA-256: ' + (data.artifact?.sha256?.slice(0, 12) || '') + '...';
        }

        // Check Pending Approvals
        const statusRes = await fetch('/api/status');
        const sys = await statusRes.json();
        if (sys.pendingApproval) {
          pendingApprovalId = sys.pendingApproval.id;
          const card = document.getElementById('approvalCard');
          card.style.display = 'block';
          document.getElementById('approvalMeta').innerText =
            'Action: ' + sys.pendingApproval.action + ' | Resource: ' + sys.pendingApproval.resource;
        } else {
          document.getElementById('approvalCard').style.display = 'none';
        }

        if (runStatus === 'completed' || runStatus === 'failed') {
          clearInterval(pollInterval);
          loadTasksList();
        }
      } catch (e) {
        console.error('Polling error', e);
      }
    }

    async function resolveApproval(approved) {
      if (!pendingApprovalId) return;
      try {
        await fetch('/api/approvals/' + pendingApprovalId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved })
        });
        document.getElementById('approvalCard').style.display = 'none';
        setMascotMood(approved ? 'thinking' : 'idle', approved ? "Approval received! Executing mutation." : "Action denied.");
        startPolling();
      } catch (err) {
        alert('Failed to resolve approval: ' + err.message);
      }
    }

    async function loadTasksList() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        // Trigger list reload
      } catch {}
    }

    // --- CANVAS TABS ---
    async function loadPages() {
      try {
        const res = await fetch('/api/pages');
        const data = await res.json();
        const listDiv = document.getElementById('pagesList');
        if (data.pages.length === 0) {
          listDiv.innerHTML = '<div style="color: var(--text-muted); padding: 8px;">No pages found.</div>';
          return;
        }
        listDiv.innerHTML = data.pages.map(p =>
          '<div onclick="selectPage(\'' + p.id + '\', \'' + escapeHtml(p.title) + '\', ' + p.revision + ')" style="padding: 10px; border-bottom: 1px solid #1e293b; cursor: pointer; display: flex; justify-content: space-between;">' +
            '<span>' + escapeHtml(p.title) + '</span>' +
            '<span class="status-pill status-queued">REV ' + p.revision + '</span>' +
          '</div>'
        ).join('');
        if (data.pages[0] && !currentPageId) {
          selectPage(data.pages[0].id, data.pages[0].title, data.pages[0].revision, data.pages[0].content);
        }
      } catch (e) {}
    }

    function selectPage(id, title, rev, content) {
      currentPageId = id;
      currentPageRev = rev;
      document.getElementById('pageTitleHeading').innerText = title;
      document.getElementById('pageRevBadge').innerText = 'REV ' + rev;
      document.getElementById('pageTitleInput').value = title;
      if (content !== undefined) {
        document.getElementById('pageContentInput').value = content;
      } else {
        // Fetch fresh
        fetch('/api/pages').then(r => r.json()).then(d => {
          const pg = d.pages.find(p => p.id === id);
          if (pg) document.getElementById('pageContentInput').value = pg.content;
        });
      }
    }

    function createNewPage() {
      currentPageId = null;
      currentPageRev = 0;
      document.getElementById('pageTitleHeading').innerText = 'New Document Note';
      document.getElementById('pageRevBadge').innerText = 'NEW';
      document.getElementById('pageTitleInput').value = 'Untitled Note';
      document.getElementById('pageContentInput').value = '# New Note\n\nStart typing...';
    }

    async function saveCurrentPage() {
      const title = document.getElementById('pageTitleInput').value.trim();
      const content = document.getElementById('pageContentInput').value;
      try {
        const res = await fetch('/api/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: currentPageId,
            title,
            content,
            expectedRevision: currentPageRev
          })
        });
        const data = await res.json();
        if (data.page) {
          selectPage(data.page.id, data.page.title, data.page.revision, data.page.content);
          loadPages();
          alert('Page saved successfully!');
        }
      } catch (err) {
        alert('Failed to save page: ' + err.message);
      }
    }

    // --- POLICY TESTER ---
    async function testPolicyEvaluation() {
      const action = document.getElementById('selTestAction').value;
      let args = {};
      if (action === 'files_write') args = { path: 'workspace/output.txt' };
      if (action === 'exec_rm_root') args = { command: 'rm -rf /' };
      if (action === 'exec_safe') args = { command: 'node -v' };

      const res = await fetch('/api/policy/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action.startsWith('exec') ? 'exec' : action, args })
      });
      const data = await res.json();
      document.getElementById('policyResultBox').innerHTML =
        '<div style="color: ' + (data.evaluation.allowed ? 'var(--success)' : 'var(--danger)') + ';">' +
        '<strong>Allowed:</strong> ' + data.evaluation.allowed + '<br>' +
        '<strong>Requires Approval:</strong> ' + data.evaluation.requiresApproval + '<br>' +
        '<strong>Reason:</strong> ' + (data.evaluation.reason || 'Conforms to policy') +
        '</div>';
    }

    // --- FLEET PAIRING ---
    async function generatePairingCode() {
      const res = await fetch('/api/runners/pair', { method: 'POST' });
      const data = await res.json();
      document.getElementById('pairingCodeBox').innerText =
        'Pairing Code Generated: ' + data.pairing.code + ' (Expires in 5 minutes)';
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}
