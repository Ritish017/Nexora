#!/usr/bin/env node
/**
 * Nexora MCP Server stdio runner
 * 
 * Reads JSON-RPC line by line from stdin, dispatches through NexoraMcpServer,
 * and writes responses to stdout. Diagnostics and logs go to stderr.
 */

import { createInterface } from "node:readline";
import { NexoraMcpServer } from "./server.ts";
import { NexoraDatabase, TaskService } from "../../runtime/src/index.ts";
import { PageStore } from "../../workspace-adapter/src/page-store.ts";

const dbPath = process.env.NEXORA_DB_PATH ?? "data/nexora.db";
const db = new NexoraDatabase(dbPath);
const taskService = new TaskService(db);
const pageStore = new PageStore(db.db);

const server = new NexoraMcpServer({
  taskService,
  db,
  pageStore,
});

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const response = await server.handleMessage(trimmed);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    process.stderr.write(`[nexora-mcp error] ${String(err)}\n`);
  }
});

process.on("SIGINT", () => {
  try {
    db.close();
  } catch {}
  process.exit(0);
});
