import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../src/agent-session.ts";

describe("AgentSession: Local Conversational Agent with System Tools", () => {
  it("initializes and reports key status", () => {
    const session = new AgentSession({ apiKey: "test-key" });
    assert.equal(session.hasKey, true);
    assert.equal(session.messages.length, 0);
  });

  it("executes safe get_system_info tool cleanly", async () => {
    const session = new AgentSession();
    const result = await session.executeTool("get_system_info", {});
    assert.equal(result.isMutating, false);
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.platform);
    assert.ok(parsed.totalMemoryGB > 0);
  });

  it("executes list_directory tool safely", async () => {
    const session = new AgentSession();
    const result = await session.executeTool("list_directory", {});
    assert.equal(result.isMutating, false);
    assert.match(result.output, /package\.json/);
  });

  it("blocks dangerous prohibited commands through policy engine", async () => {
    const session = new AgentSession();
    const result = await session.executeTool("exec_command", { command: "rm -rf /" });
    assert.match(result.output, /Policy blocked command/);
  });
});
