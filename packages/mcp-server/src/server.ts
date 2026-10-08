/**
 * Nexora Multi-Host MCP Server Implementation
 * 
 * Provides unified MCP tools for Antigravity, Codex, and Claude.
 * Exposes durable tasks, run state, approvals, artifacts, and workspace pages.
 */

import type { TaskService, NexoraDatabase } from "../../runtime/src/index.ts";
import type { PageStore } from "../../workspace-adapter/src/page-store.ts";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTool,
  McpToolCallResult,
} from "./types.ts";

export const NEXORA_MCP_TOOLS: McpTool[] = [
  {
    name: "nexora_submit_task",
    description: "Submit a durable task to Nexora's SQLite task ledger.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human-readable title of the task" },
        description: { type: "string", description: "Detailed description of the task requirements" },
        input: { type: "object", description: "Structured task input parameters" },
        idempotencyKey: { type: "string", description: "Optional idempotency key to prevent duplicate execution" },
        ownerId: { type: "string", description: "Owner identifier (defaults to 'owner-default')" },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "nexora_get_task",
    description: "Retrieve a task's durable state and active run details.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ID of the task to retrieve" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "nexora_list_tasks",
    description: "List queued, running, or recent tasks.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of tasks to return" },
        status: { type: "string", description: "Optional status filter (e.g. queued, running, completed, failed)" },
      },
    },
  },
  {
    name: "nexora_get_run",
    description: "Inspect a run's status, monotonic sequence events, and pending approvals.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "ID of the run to inspect" },
      },
      required: ["runId"],
    },
  },
  {
    name: "nexora_resolve_approval",
    description: "Approve or deny a pending action approval for a running task.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string", description: "ID of the approval request" },
        approved: { type: "boolean", description: "True to grant approval, false to deny" },
        decidedBy: { type: "string", description: "Identifier of the authorizing owner/actor" },
      },
      required: ["approvalId", "approved", "decidedBy"],
    },
  },
  {
    name: "nexora_get_artifact",
    description: "Retrieve verified artifact metadata and cryptographic SHA-256 hash.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "ID of the artifact to retrieve" },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "nexora_query_pages",
    description: "Query OpenDots workspace document pages.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Space identifier (defaults to 'default')" },
      },
    },
  },
];

export class NexoraMcpServer {
  readonly taskService?: TaskService;
  readonly db?: NexoraDatabase;
  readonly pageStore?: PageStore;

  constructor(options?: {
    taskService?: TaskService;
    db?: NexoraDatabase;
    pageStore?: PageStore;
  }) {
    this.taskService = options?.taskService;
    this.db = options?.db;
    this.pageStore = options?.pageStore;
  }

  async handleMessage(rawMessage: string): Promise<JsonRpcResponse | null> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(rawMessage);
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      };
    }

    if (!req.method) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32600, message: "Invalid Request: method is required" },
      };
    }

    // Notifications (no id)
    if (req.id === undefined || req.id === null) {
      return null;
    }

    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: err.code ?? -32000,
          message: err.message ?? String(err),
        },
      };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "nexora-mcp-server",
            version: "0.1.0",
          },
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
        };

      case "tools/list":
        return {
          tools: NEXORA_MCP_TOOLS,
        };

      case "tools/call": {
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        return this.callTool(name, args);
      }

      default:
        throw { code: -32601, message: `Method not found: ${method}` };
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    try {
      let outputData: unknown;

      switch (name) {
        case "nexora_submit_task": {
          if (!this.taskService) throw new Error("TaskService not configured on MCP server");
          const idempotencyKey =
            (args.idempotencyKey as string) ||
            `idem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          const result = this.taskService.submitTask({
            title: String(args.title),
            description: String(args.description),
            input: (args.input as Record<string, unknown>) ?? {},
            ownerId: (args.ownerId as string) ?? "owner-default",
            projectId: "nexora-default",
            idempotencyKey,
          });
          outputData = { task: result.task, isNew: result.isNew };
          break;
        }

        case "nexora_get_task": {
          if (!this.db) throw new Error("Database not configured on MCP server");
          const task = this.db.getTask(String(args.taskId));
          if (!task) throw new Error(`Task '${args.taskId}' not found`);
          outputData = { task };
          break;
        }

        case "nexora_list_tasks": {
          if (!this.db) throw new Error("Database not configured on MCP server");
          const limit = typeof args.limit === "number" ? args.limit : 20;
          const status = args.status as string | undefined;
          const tasks = this.db.listTasks(status);
          outputData = { tasks: tasks.slice(0, limit) };
          break;
        }

        case "nexora_get_run": {
          if (!this.db) throw new Error("Database not configured on MCP server");
          const runId = String(args.runId);
          const run = this.db.getRun(runId);
          if (!run) throw new Error(`Run '${runId}' not found`);
          const events = this.db.getEvents(runId);
          outputData = { run, eventsCount: events.length, latestEvents: events.slice(-5) };
          break;
        }

        case "nexora_resolve_approval": {
          if (!this.taskService) throw new Error("TaskService not configured on MCP server");
          const result = this.taskService.resolveApproval(
            String(args.approvalId),
            Boolean(args.approved),
            String(args.decidedBy)
          );
          outputData = {
            approvalId: result.approval.id,
            status: result.approval.status,
            runStatus: result.run.status,
          };
          break;
        }

        case "nexora_get_artifact": {
          if (!this.db) throw new Error("DatabaseEngine not configured on MCP server");
          const artifact = this.db.getArtifact(String(args.artifactId));
          if (!artifact) throw new Error(`Artifact '${args.artifactId}' not found`);
          outputData = { artifact };
          break;
        }

        case "nexora_query_pages": {
          if (!this.pageStore) {
            outputData = { pages: [], notice: "PageStore not connected" };
          } else {
            const spaceId = (args.spaceId as string) ?? "default";
            const pages = this.pageStore.listPagesInSpace(spaceId);
            outputData = { pages };
          }
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(outputData, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing tool '${name}': ${err.message ?? err}`,
          },
        ],
      };
    }
  }
}
