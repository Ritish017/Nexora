import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NexoraDatabase, TaskService } from "../../runtime/src/index.ts";
import { PageStore } from "../../workspace-adapter/src/page-store.ts";
import { NexoraMcpServer, NEXORA_MCP_TOOLS } from "../src/index.ts";

describe("Phase 5: Multi-Host MCP Server Handshake & Protocol Integrity", () => {
  let tempDir: string;
  let db: NexoraDatabase;
  let taskService: TaskService;
  let pageStore: PageStore;
  let server: NexoraMcpServer;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-mcp-test-"));
    db = new NexoraDatabase(join(tempDir, "mcp.db"));
    taskService = new TaskService(db);
    pageStore = new PageStore(db.db);
    server = new NexoraMcpServer({ taskService, db, pageStore });
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("handles initialize request with MCP 2024-11-05 protocol", async () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    const response = await server.handleMessage(raw);
    assert.ok(response);
    assert.equal(response.id, 1);
    assert.equal(response.jsonrpc, "2.0");
    const result = response.result as any;
    assert.equal(result.protocolVersion, "2024-11-05");
    assert.equal(result.serverInfo.name, "nexora-mcp-server");
    assert.ok(result.capabilities.tools);
  });

  it("lists all exposed Nexora tools via tools/list", async () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const response = await server.handleMessage(raw);
    assert.ok(response);
    assert.equal(response.id, 2);
    const result = response.result as any;
    assert.ok(Array.isArray(result.tools));
    assert.equal(result.tools.length, NEXORA_MCP_TOOLS.length);

    const toolNames = result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("nexora_submit_task"));
    assert.ok(toolNames.includes("nexora_get_task"));
    assert.ok(toolNames.includes("nexora_list_tasks"));
    assert.ok(toolNames.includes("nexora_get_run"));
    assert.ok(toolNames.includes("nexora_resolve_approval"));
    assert.ok(toolNames.includes("nexora_get_artifact"));
    assert.ok(toolNames.includes("nexora_query_pages"));
  });

  it("returns parse error for invalid JSON", async () => {
    const response = await server.handleMessage("{ invalid json");
    assert.ok(response);
    assert.equal(response.error?.code, -32700);
  });

  it("returns method not found error for unknown method", async () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "unknown_method",
    });

    const response = await server.handleMessage(raw);
    assert.ok(response);
    assert.equal(response.error?.code, -32601);
  });
});

describe("Phase 5: MCP Tool Execution & Headless Approval Workflow", () => {
  let tempDir: string;
  let db: NexoraDatabase;
  let taskService: TaskService;
  let pageStore: PageStore;
  let server: NexoraMcpServer;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexora-mcp-tools-"));
    db = new NexoraDatabase(join(tempDir, "mcp-tools.db"));
    taskService = new TaskService(db);
    pageStore = new PageStore(db.db);
    server = new NexoraMcpServer({ taskService, db, pageStore });
  });

  after(() => {
    try {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("submits durable task via nexora_submit_task", async () => {
    const res = await server.callTool("nexora_submit_task", {
      title: "Index Research Paper",
      description: "Extract citations from PDF and summarize",
      input: { url: "https://arxiv.org/abs/2301.0000" },
      ownerId: "owner-alice",
    });

    assert.equal(res.isError, undefined);
    assert.equal(res.content.length, 1);
    const data = JSON.parse(res.content[0].text);
    assert.ok(data.task.id);
    assert.equal(data.task.title, "Index Research Paper");
    assert.equal(data.task.status, "queued");

    // Fetch back via nexora_get_task
    const getRes = await server.callTool("nexora_get_task", { taskId: data.task.id });
    const getData = JSON.parse(getRes.content[0].text);
    assert.equal(getData.task.id, data.task.id);
  });

  it("lists tasks via nexora_list_tasks", async () => {
    const res = await server.callTool("nexora_list_tasks", { limit: 10, status: "queued" });
    const data = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(data.tasks));
    assert.ok(data.tasks.length >= 1);
  });

  it("inspects run and handles headless approval resolution via nexora_resolve_approval", async () => {
    // 1. Submit task and claim worker run
    const { task } = taskService.submitTask({
      title: "Deploy Container Service",
      description: "Mutating deployment requiring owner approval",
      input: {},
      ownerId: "owner-alice",
      projectId: "default",
      idempotencyKey: "deploy-test-idem-key",
    });

    const claimed = taskService.claimTask("worker-codex");
    assert.ok(claimed);
    const runId = claimed.run.id;

    // 2. Request action approval
    const approval = taskService.requestApproval(
      runId,
      "container_deploy",
      { image: "openbot/runtime:v1" },
      "container://openbot/deploy",
      "worker-codex",
      "1.0.0",
      60000
    );

    // 3. Inspect run state via MCP nexora_get_run
    const runInspect = await server.callTool("nexora_get_run", { runId });
    const runData = JSON.parse(runInspect.content[0].text);
    assert.equal(runData.run.status, "waiting_for_approval");
    assert.ok(runData.eventsCount > 0);

    // 4. Resolve approval via MCP nexora_resolve_approval
    const resolveRes = await server.callTool("nexora_resolve_approval", {
      approvalId: approval.id,
      approved: true,
      decidedBy: "owner-alice",
    });

    assert.equal(resolveRes.isError, undefined);
    const resolveData = JSON.parse(resolveRes.content[0].text);
    assert.equal(resolveData.status, "approved");
    assert.equal(resolveData.runStatus, "running");

    // 5. Inspect run again to confirm it transitioned back to running
    const runAfter = await server.callTool("nexora_get_run", { runId });
    const runAfterData = JSON.parse(runAfter.content[0].text);
    assert.equal(runAfterData.run.status, "running");
  });

  it("queries document pages via nexora_query_pages", async () => {
    const space = pageStore.createSpace("owner-alice", "Default Space");

    pageStore.createPage({
      spaceId: space.id,
      ownerId: "owner-alice",
      title: "Project Summary",
      content: "# Nexora Blueprint Overview",
    });

    const res = await server.callTool("nexora_query_pages", { spaceId: space.id });
    const data = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(data.pages));
    assert.equal(data.pages.length, 1);
    assert.equal(data.pages[0].title, "Project Summary");
  });

  it("handles missing tasks or invalid parameters cleanly with error feedback", async () => {
    const res = await server.callTool("nexora_get_task", { taskId: "non-existent-task-id" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not found/);
  });
});
