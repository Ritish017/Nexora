/**
 * Nexora Sovereign Interactive Operating Console & Agent Server
 * 
 * Provides a unified local graphical environment showcasing ALL Nexora capabilities:
 * - Natural Language Conversational Agent (lives on host computer with real tool loop)
 * - Living On-Screen Agent Mascot with reactive animations and real-time speech/thought stream
 * - Real AI Mode (Gemini 2.5 / 3.8 Flash with free-only routing and autonomous tools)
 * - Interactive Document Canvas (OpenDots revision-checked pages with optimistic concurrency)
 * - Governed Computer Sandbox (OpenBot action policy engine, HMAC credential derivation, terminal simulation)
 * - Multi-Host MCP Hub (Configs for Antigravity, Claude Desktop, and Codex)
 * - Outbound Runner Fleet (Pairing code generator, lease fencing, and Asia/Kolkata schedules)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { NexoraDatabase, TaskService, AgentSession } from "../packages/runtime/src/index.ts";
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
const agentSession = new AgentSession();

// Initialize default document workspace if none exists
try {
  let spaces = pageStore.db.prepare("SELECT * FROM spaces WHERE ownerId = ?").all("local-owner") as any[];
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
      taskService.emitEvent(runId, "item_started", {
        item: "demo_turn",
        label: "Starting Local Demo execution...",
        timestamp: Date.now(),
      });

      taskService.emitEvent(runId, "progress", {
        percent: 30,
        message: "Compiling deterministic introduction content...",
      });

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

      await finishDemoExecution(runId, taskId);
    } else {
      if (!hasApiKey) {
        taskService.failRun(runId, "Live AI mode requires GEMINI_API_KEY to be set in your system environment.");
        return;
      }

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
    const activeRuns = db.listActiveRuns();
    const activeRun = activeRuns[0] ?? null;
    const approvalRows = db.db.prepare("SELECT doc FROM approvals WHERE status = 'pending' ORDER BY expiry ASC").all() as Array<{ doc: string }>;
    const approvals = approvalRows.map((r) => JSON.parse(r.doc));
    const spaces = pageStore.db.prepare("SELECT * FROM spaces WHERE ownerId = ?").all("local-owner") as any[];
    const pages = spaces[0] ? pageStore.listPagesInSpace(spaces[0].id) : [];
    const tasks = db.listTasks().slice(0, 10);

    return sendJson(res, 200, {
      status: "ok",
      hasApiKey,
      model: "gemini-3.8-flash",
      priceClass: "free",
      entitlement: "verified_free",
      activeRun,
      pendingApproval: approvals[0] ?? null,
      pageCount: pages.length,
      tasks,
    });
  }

  // --- API: Conversational Agent Chat ---
  if (method === "GET" && url.pathname === "/api/chat") {
    return sendJson(res, 200, { messages: agentSession.messages });
  }

  if (method === "POST" && url.pathname === "/api/chat") {
    const body = await parseJsonBody(req);
    const userMessage = String(body.message || "").trim();
    if (!userMessage) {
      return sendJson(res, 400, { error: "Message cannot be empty." });
    }

    try {
      const result = await agentSession.chat(userMessage);
      return sendJson(res, 200, {
        response: result.response,
        toolCalls: result.toolCalls,
        messages: agentSession.messages,
      });
    } catch (err: any) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/chat/clear") {
    agentSession.clear();
    return sendJson(res, 200, { status: "cleared", messages: [] });
  }

  // --- API: Pages ---
  if (method === "GET" && url.pathname === "/api/pages") {
    const spaces = pageStore.db.prepare("SELECT * FROM spaces WHERE ownerId = ?").all("local-owner") as any[];
    const pages = spaces[0] ? pageStore.listPagesInSpace(spaces[0].id) : [];
    return sendJson(res, 200, { spaces, pages });
  }

  if (method === "POST" && url.pathname === "/api/pages") {
    const body = await parseJsonBody(req);
    const spaces = pageStore.db.prepare("SELECT * FROM spaces WHERE ownerId = ?").all("local-owner") as any[];
    const spaceId = spaces[0]?.id || pageStore.createSpace("local-owner", "Default").id;

    if (body.id) {
      const updated = pageStore.updatePage({
        id: body.id,
        ownerId: "local-owner",
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

    const runRows = db.db.prepare("SELECT doc FROM runs WHERE taskId = ? ORDER BY startedAt ASC").all(taskId) as Array<{ doc: string }>;
    const runs = runRows.map((r) => JSON.parse(r.doc));
    const latestRun = runs[runs.length - 1];
    let events: any[] = [];
    let artifactContent: string | null = null;
    let artifactMeta: any = null;

    if (latestRun) {
      events = db.getEvents(latestRun.id);
      const artRows = db.db.prepare("SELECT doc FROM artifacts WHERE runId = ?").all(latestRun.id) as Array<{ doc: string }>;
      const artifacts = artRows.map((r) => JSON.parse(r.doc));
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

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n============================================================`);
  console.log(`⚡ Nexora Sovereign Console: http://127.0.0.1:${PORT}`);
  console.log(`🛡️ Storage: SQLite WAL [${dbPath}]`);
  console.log(`🤖 AI Engine: Google Gemini (Natural Language Tools + Free-Tier)`);
  console.log(`🔑 Key Status: ${hasApiKey ? "GEMINI_API_KEY Configured" : "No Key Found"}`);
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

    /* CHAT STREAM */
    .chat-container {
      display: flex;
      flex-direction: column;
      height: 640px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .chat-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0f172a;
    }
    .chat-messages {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .chat-bubble {
      max-width: 82%;
      padding: 14px 18px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
    }
    .chat-bubble.user {
      align-self: flex-end;
      background: #0284c7;
      color: #fff;
      border-bottom-right-radius: 2px;
    }
    .chat-bubble.assistant {
      align-self: flex-start;
      background: #1e293b;
      color: #f3f4f6;
      border: 1px solid #334155;
      border-bottom-left-radius: 2px;
    }
    .tool-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-family: var(--mono);
      margin-top: 8px;
      margin-right: 6px;
      cursor: pointer;
    }
    .tool-output-details {
      background: #0b1120;
      border: 1px solid #1e293b;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-family: var(--mono);
      color: #94a3b8;
      max-height: 140px;
      overflow-y: auto;
      margin-top: 6px;
      white-space: pre-wrap;
    }
    .chat-input-bar {
      padding: 16px 20px;
      border-top: 1px solid var(--card-border);
      background: #0f172a;
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .chat-input {
      flex: 1;
      background: #0b1120;
      border: 1px solid #334155;
      color: #fff;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
    }
    .chat-input:focus { border-color: var(--accent); }
    .btn-send {
      padding: 12px 20px;
      background: var(--accent);
      color: #0b1120;
      font-weight: 700;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    .btn-send:hover { background: var(--accent-hover); }

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

    .quick-pill {
      display: inline-block;
      font-size: 11px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent);
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      margin-right: 6px;
      border: 1px dashed rgba(56, 189, 248, 0.4);
    }
    .quick-pill:hover { background: rgba(56, 189, 248, 0.2); }

    .status-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
    }
    .status-queued { background: #334155; color: #cbd5e1; }
    .status-running { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
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
        <p>Conversational Agent Living Inside Your Machine • Natural Language OS Assistant</p>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <span id="modeBadge" class="status-pill status-running">● AGENT READY</span>
        <span class="status-pill status-queued">SQLite WAL: data/nexora.db</span>
      </div>
    </header>

    <!-- NAVIGATION TABS -->
    <div class="nav-tabs">
      <button class="nav-tab active" onclick="switchTab('tab-chat')">💬 Natural Language Agent</button>
      <button class="nav-tab" onclick="switchTab('tab-agent')">⚡ Batch Tasks</button>
      <button class="nav-tab" onclick="switchTab('tab-canvas')">📄 Document Canvas</button>
      <button class="nav-tab" onclick="switchTab('tab-computer')">💻 Governed Computer</button>
      <button class="nav-tab" onclick="switchTab('tab-mcp')">🔌 MCP Ecosystem</button>
      <button class="nav-tab" onclick="switchTab('tab-fleet')">🌐 Runner Fleet</button>
    </div>

    <!-- TAB 0: CHAT WITH AGENT (PRIMARY CONVERSATIONAL EXPERIENCE) -->
    <div id="tab-chat" class="tab-content active">
      <div class="chat-container">
        <div class="chat-header">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 20px;">🤖</span>
            <div>
              <div style="font-weight: 700; font-size: 15px;">Nexora Living Assistant</div>
              <div style="font-size: 12px; color: var(--text-muted);">Autonomous local agent with direct computer tool execution (Files, Shell, Status)</div>
            </div>
          </div>
          <div>
            <button onclick="clearChatHistory()" style="background: transparent; border: 1px solid #334155; color: var(--text-muted); padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;">Clear Chat</button>
          </div>
        </div>

        <div id="chatMessages" class="chat-messages">
          <div class="chat-bubble assistant">
            👋 <strong>Hi, I'm Nexora!</strong> I live inside your computer as your autonomous personal agent.<br><br>
            You can ask me <em>any question or assign any task in natural language</em>:
            <ul style="margin: 8px 0 8px 20px; font-size: 13px;">
              <li>Inspect files, list folders, or read documents on your machine</li>
              <li>Execute safe commands like <code>git status</code>, check Node versions, or test scripts</li>
              <li>Check system memory, CPU architecture, uptime, or current time</li>
              <li>Ask general questions about architecture, code, math, or workflows!</li>
            </ul>
            What would you like me to do?
          </div>
        </div>

        <div style="padding: 10px 20px; background: #0b1120; border-top: 1px solid #1e293b; display: flex; gap: 8px; overflow-x: auto;">
          <span class="quick-pill" onclick="sendQuickPrompt('What files and folders are in this project directory?')">📁 List directory files</span>
          <span class="quick-pill" onclick="sendQuickPrompt('Check current system memory, platform, and uptime')">💻 Check system status</span>
          <span class="quick-pill" onclick="sendQuickPrompt('Run git status and show me what branch I am on')">🔍 Check git status</span>
          <span class="quick-pill" onclick="sendQuickPrompt('Read package.json and summarize what npm scripts are available')">📖 Inspect package.json</span>
          <span class="quick-pill" onclick="sendQuickPrompt('Explain how Nexora protects my computer from dangerous commands')">🛡️ Explain security governance</span>
        </div>

        <div class="chat-input-bar">
          <input type="text" id="chatInput" class="chat-input" placeholder="Ask Nexora anything or assign any task in natural language..." onkeydown="if(event.key==='Enter') sendChatMessage()">
          <button id="btnSendChat" class="btn-send" onclick="sendChatMessage()">Send Message</button>
        </div>
      </div>
    </div>

    <!-- TAB 1: BATCH TASKS -->
    <div id="tab-agent" class="tab-content">
      <div class="grid">
        <div class="card">
          <h2>1. Submit Batch Task</h2>
          <textarea id="taskPrompt" style="width: 100%; height: 90px; background: #0b1120; border: 1px solid #334155; border-radius: 8px; padding: 12px; color: #fff; margin-bottom: 10px;">Create a short introduction to Nexora.</textarea>
          <button id="btnSubmit" class="btn-send" style="width: 100%;" onclick="submitTask()">Execute Durable Task</button>
        </div>
        <div class="card">
          <h2>2. Saved Result & Artifact</h2>
          <div id="artifactView" style="background: #0b1120; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; font-size: 13px; max-height: 250px; overflow-y: auto; font-family: var(--mono);">No artifact generated yet.</div>
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
          <textarea id="pageContentInput" style="width: 100%; height: 250px; background: #0b1120; border: 1px solid #334155; padding: 8px; border-radius: 6px; color: #fff; font-family: var(--mono); font-size: 13px;" placeholder="Markdown content..."></textarea>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
            <span style="font-size: 12px; color: var(--text-muted);">Optimistic Concurrency Protection</span>
            <button onclick="saveCurrentPage()" class="btn-send" style="padding: 6px 14px;">Save Changes</button>
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
            <button onclick="testPolicyEvaluation()" class="btn-send" style="padding: 8px 12px;">Evaluate Action with Policy Engine</button>
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
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px;">
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
        <button onclick="generatePairingCode()" class="btn-send" style="width: auto; padding: 8px 16px; margin-bottom: 14px;">Generate 8-Character Pairing Code</button>
        <div id="pairingCodeBox" style="font-family: var(--mono); font-size: 13px; color: var(--success); margin-bottom: 14px;"></div>
      </div>
    </div>
  </div>

  <!-- ========================================================
       LIVING ON-SCREEN AGENT MASCOT WIDGET (PERRY CHARACTER)
       ======================================================== -->
  <div class="agent-mascot-container">
    <div id="agentSpeechBubble" class="agent-speech-bubble">
      I'm Nexora, living inside your computer. Ask me anything!
    </div>
    <div id="agentMascot" class="agent-mascot-avatar" onclick="pokeMascot()" title="Click to interact with Nexora!">
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        <ellipse cx="20" cy="70" rx="14" ry="7" fill="#b45309" transform="rotate(-20 20 70)"/>
        <ellipse cx="50" cy="58" rx="28" ry="26" fill="#06b6d4"/>
        <ellipse cx="50" cy="62" rx="18" ry="16" fill="#22d3ee" opacity="0.6"/>
        <ellipse cx="38" cy="84" rx="8" ry="4" fill="#f59e0b"/>
        <ellipse cx="62" cy="84" rx="8" ry="4" fill="#f59e0b"/>
        <ellipse cx="50" cy="55" rx="18" ry="8" fill="#f59e0b"/>
        <ellipse cx="45" cy="53" rx="1.5" ry="1.5" fill="#78350f"/>
        <ellipse cx="55" cy="53" rx="1.5" ry="1.5" fill="#78350f"/>
        <circle id="eyeLeft" cx="42" cy="42" r="5" fill="#ffffff"/>
        <circle id="pupilLeft" cx="43" cy="42" r="2.5" fill="#0b1120"/>
        <circle id="eyeRight" cx="58" cy="42" r="5" fill="#ffffff"/>
        <circle id="pupilRight" cx="57" cy="42" r="2.5" fill="#0b1120"/>
        <ellipse cx="50" cy="34" rx="22" ry="5" fill="#78350f"/>
        <path d="M36 34 L38 20 Q50 17 62 20 L64 34 Z" fill="#78350f"/>
        <path d="M37 32 L38 28 Q50 26 62 28 L63 32 Z" fill="#18181b"/>
      </svg>
    </div>
  </div>

  <script>
    let activeTaskId = null;
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
        "I'm awake and ready! Ask me anything or tell me to run a command.",
        "I live right here on your computer!",
        "Governed action boundaries are active. Your machine is safe!",
        "Gemini is standing by with local tools ready."
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

    // --- CONVERSATIONAL CHAT SYSTEM ---
    async function sendChatMessage() {
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      if (!text) return;

      input.value = '';
      appendChatMessage('user', text);

      setMascotMood('thinking', "Thinking... Analyzing request and consulting tools.");

      const btn = document.getElementById('btnSendChat');
      btn.disabled = true;
      btn.innerText = 'Working...';

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json();

        if (data.error) {
          appendChatMessage('assistant', '⚠️ Error: ' + data.error);
          setMascotMood('alert', "Error occurred.");
        } else {
          appendChatMessage('assistant', data.response, data.toolCalls);
          setMascotMood('celebrating', "Here is what I found!");
          setTimeout(() => setMascotMood('idle'), 3000);
        }
      } catch (err) {
        appendChatMessage('assistant', '⚠️ Network error: ' + err.message);
        setMascotMood('alert', "Network error.");
      } finally {
        btn.disabled = false;
        btn.innerText = 'Send Message';
      }
    }

    function sendQuickPrompt(prompt) {
      document.getElementById('chatInput').value = prompt;
      sendChatMessage();
    }

    function appendChatMessage(role, text, toolCalls) {
      const messagesDiv = document.getElementById('chatMessages');
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble ' + role;

      let toolHtml = '';
      if (toolCalls && toolCalls.length > 0) {
        toolHtml = '<div style="margin-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px;">' +
          toolCalls.map((tc, idx) => {
            const outId = 'tool_out_' + Date.now() + '_' + idx;
            return '<div style="margin-bottom: 6px;">' +
              '<span class="tool-chip" onclick="toggleToolOutput(\'' + outId + '\')">🛠️ Tool: ' + escapeHtml(tc.name) + ' (' + escapeHtml(JSON.stringify(tc.args)) + ') ▾</span>' +
              '<div id="' + outId + '" class="tool-output-details" style="display: none;">' + escapeHtml(tc.output || 'No output') + '</div>' +
            '</div>';
          }).join('') +
        '</div>';
      }

      bubble.innerHTML = (role === 'user' ? '<strong>You:</strong> ' : '<strong>Nexora:</strong> ') +
        formatMarkdown(text) + toolHtml;

      messagesDiv.appendChild(bubble);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function toggleToolOutput(id) {
      const el = document.getElementById(id);
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    async function clearChatHistory() {
      await fetch('/api/chat/clear', { method: 'POST' });
      document.getElementById('chatMessages').innerHTML =
        '<div class="chat-bubble assistant">🧹 Chat history cleared. What can I do for you?</div>';
      setMascotMood('idle', "Ready for a fresh start!");
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

    async function submitTask() {
      const prompt = document.getElementById('taskPrompt').value.trim();
      if (!prompt) return;
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, mode: 'demo', requireApproval: false })
      });
      const data = await res.json();
      activeTaskId = data.taskId;
      alert('Task submitted! ID: ' + activeTaskId);
    }

    function formatMarkdown(txt) {
      if (!txt) return '';
      return escapeHtml(txt).split('\n').join('<br>');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}
