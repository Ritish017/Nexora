/**
 * Nexora Gemini 3.8 Flash Direct Engine Unit Tests
 *
 * Verifies:
 * 1. Status probe & capabilities
 * 2. Turn execution & event normalization (assistant text, reasoning, items, usage)
 * 3. Tool call routing to sink.onRequest and non-mutating safety
 * 4. Cooperative cancellation via engine.kill()
 * 5. Turn timeout handling
 * 6. API error response handling
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GeminiEngine } from "../src/gemini-engine.ts";
import type {
  EngineRequest,
  TurnEvent,
  TurnInput,
  TurnSink,
} from "../../contracts/src/engine.ts";

function createMockSseResponse(chunks: Array<Record<string, unknown>>, delayMs = 0): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        const sseLine = `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(sseLine));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createHangingResponse(signal?: AbortSignal): Response {
  const stream = new ReadableStream({
    start(controller) {
      if (signal?.aborted) {
        try { controller.close(); } catch {}
        return;
      }
      signal?.addEventListener("abort", () => {
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {},
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("GeminiEngine: Status probe and capabilities", async (t) => {
  await t.test("Capabilities match specification", () => {
    const engine = new GeminiEngine({ apiKey: "test-key" });
    assert.deepEqual(engine.capabilities, {
      approvals: true,
      steer: "queue",
      compaction: { type: "none" },
      sandbox: {},
      images: true,
      modelSwitchInSession: false,
      usage: "complete",
      quickTurns: true,
      guestLockdown: true,
    });
  });

  await t.test("Status reports signedIn when apiKey is provided", async () => {
    const engine = new GeminiEngine({ apiKey: "test-api-key" });
    const status = await engine.status();

    assert.equal(status.kind, "direct-api");
    assert.equal(status.installed, true);
    assert.equal(status.signedIn, true);
    assert.equal(status.auth.type, "api-key");
    assert.equal(status.auth.label, "GEMINI_API_KEY");
    assert.equal(status.models.length, 1);
    assert.equal(status.models[0].id, "gemini-3.8-flash");
    assert.equal(status.models[0].name, "Gemini 3.8 Flash");
    assert.equal(status.models[0].isDefault, true);
    assert.deepEqual(status.models[0].efforts, ["low", "medium", "high"]);
    assert.equal(status.models[0].defaultEffort, "medium");
  });

  await t.test("Status reports signedIn: false when no key exists", async () => {
    const originalEnv = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const engine = new GeminiEngine({ apiKey: "" });
      const status = await engine.status();
      assert.equal(status.signedIn, false);
      assert.equal(status.message, "GEMINI_API_KEY is not configured");
    } finally {
      if (originalEnv) process.env.GEMINI_API_KEY = originalEnv;
    }
  });
});

test("GeminiEngine: Turn execution & event normalization", async (t) => {
  await t.test("Streams reasoning, assistant text, and token usage", async () => {
    const mockChunks = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Thinking step 1...", thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Thinking step 2.", thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Here is the " }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "final answer." }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          cachedContentTokenCount: 20,
          candidatesTokenCount: 45,
          thinkingTokenCount: 18,
          totalTokenCount: 165,
        },
      },
    ];

    const engine = new GeminiEngine({
      apiKey: "test-key",
      fetchFn: async () => createMockSseResponse(mockChunks),
    });

    const events: TurnEvent[] = [];
    let sessionCursor = "";
    const sink: TurnSink = {
      onSession(cursor) {
        sessionCursor = cursor;
      },
      onEvent(event) {
        events.push(event);
      },
      async onRequest() {
        return "accept";
      },
    };

    const input: TurnInput = {
      instructions: "You are a helpful coding assistant.",
      prompt: "Solve problem X",
      cwd: "C:/AI-Projects/Nexora",
      access: "supervised",
    };

    const result = await engine.runTurn(input, sink);

    assert.equal(result.outcome, "completed");
    assert.equal(result.text, "Here is the final answer.");
    assert.ok(sessionCursor.startsWith("session_"));

    // Check reasoning text events
    const reasoningTexts = events.filter(
      (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text" && e.stream === "reasoning"
    );
    assert.equal(reasoningTexts.length, 2);
    assert.equal(reasoningTexts[0].delta, "Thinking step 1...");
    assert.equal(reasoningTexts[1].text, "Thinking step 1...Thinking step 2.");

    // Check assistant text events
    const assistantTexts = events.filter(
      (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text" && e.stream === "assistant"
    );
    assert.equal(assistantTexts.length, 2);
    assert.equal(assistantTexts[0].delta, "Here is the ");
    assert.equal(assistantTexts[1].text, "Here is the final answer.");

    // Check items started/completed
    const itemEvents = events.filter(
      (e): e is Extract<TurnEvent, { type: "item" }> => e.type === "item"
    );
    const reasoningStarted = itemEvents.find((e) => e.item.type === "reasoning" && e.phase === "started");
    const reasoningCompleted = itemEvents.find((e) => e.item.type === "reasoning" && e.phase === "completed");
    assert.ok(reasoningStarted, "Reasoning started event must exist");
    assert.ok(reasoningCompleted, "Reasoning completed event must exist");

    // Check usage event
    const usageEvents = events.filter(
      (e): e is Extract<TurnEvent, { type: "usage" }> => e.type === "usage"
    );
    assert.ok(usageEvents.length > 0);
    const lastUsage = usageEvents[usageEvents.length - 1];
    if (lastUsage.state === "complete") {
      assert.equal(lastUsage.usage.inputTokens, 120);
      assert.equal(lastUsage.usage.cachedInputTokens, 20);
      assert.equal(lastUsage.usage.outputTokens, 45);
      assert.equal(lastUsage.usage.reasoningTokens, 18);
      assert.equal(lastUsage.usage.totalTokens, 165);
    } else {
      assert.fail("Expected complete usage state");
    }

    // Check result usage
    assert.deepEqual(result.usage, {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 45,
      reasoningTokens: 18,
      totalTokens: 165,
    });
  });
});

test("GeminiEngine: Tool call routing & non-mutating safety", async (t) => {
  await t.test("Routes exec_command to sink.onRequest and never executes directly", async () => {
    const mockChunks = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "run_command",
                    args: { command: "git status" },
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    const engine = new GeminiEngine({
      apiKey: "test-key",
      fetchFn: async () => createMockSseResponse(mockChunks),
    });

    const requestsReceived: EngineRequest[] = [];
    const events: TurnEvent[] = [];

    const sink: TurnSink = {
      onSession() {},
      onEvent(event) {
        events.push(event);
      },
      async onRequest(req) {
        requestsReceived.push(req);
        return "accept";
      },
    };

    const input: TurnInput = {
      instructions: "Check git status",
      prompt: "Check git status",
      cwd: "C:/AI-Projects/Nexora",
      access: "supervised",
    };

    const result = await engine.runTurn(input, sink);

    assert.equal(result.outcome, "completed");
    assert.equal(requestsReceived.length, 1);
    assert.equal(requestsReceived[0].type, "exec_command_approval");
    assert.equal(requestsReceived[0].detail.command, "git status");
    assert.equal(requestsReceived[0].detail.cwd, "C:/AI-Projects/Nexora");
    assert.equal(requestsReceived[0].options.length, 3);
    assert.equal(requestsReceived[0].options[0].id, "accept");

    // Check item event phases
    const itemEvents = events.filter(
      (e): e is Extract<TurnEvent, { type: "item" }> => e.type === "item"
    );
    const started = itemEvents.find((e) => e.phase === "started");
    const completed = itemEvents.find((e) => e.phase === "completed");
    assert.ok(started);
    assert.ok(completed);
    assert.equal(started.item.type, "command_execution");
    assert.equal(completed.item.status, "completed");
    assert.equal(completed.item.output, "accept");
  });

  await t.test("Routes file modification to sink.onRequest and marks declined on rejection", async () => {
    const mockChunks = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "write_to_file",
                    args: { TargetFile: "C:/test.txt", CodeContent: "sample" },
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    const engine = new GeminiEngine({
      apiKey: "test-key",
      fetchFn: async () => createMockSseResponse(mockChunks),
    });

    const requestsReceived: EngineRequest[] = [];
    const events: TurnEvent[] = [];

    const sink: TurnSink = {
      onSession() {},
      onEvent(event) {
        events.push(event);
      },
      async onRequest(req) {
        requestsReceived.push(req);
        return "decline";
      },
    };

    const input: TurnInput = {
      instructions: "Write a file",
      prompt: "Write a file",
      cwd: "C:/AI-Projects/Nexora",
      access: "supervised",
    };

    const result = await engine.runTurn(input, sink);

    assert.equal(result.outcome, "completed");
    assert.equal(requestsReceived.length, 1);
    assert.equal(requestsReceived[0].type, "file_change_approval");
    assert.equal(requestsReceived[0].detail.changes?.[0].path, "C:/test.txt");

    const itemEvents = events.filter(
      (e): e is Extract<TurnEvent, { type: "item" }> => e.type === "item"
    );
    const completed = itemEvents.find((e) => e.phase === "completed");
    assert.ok(completed);
    assert.equal(completed.item.type, "file_change");
    assert.equal(completed.item.status, "declined");
    // Ensure files array in result does not include declined changes
    assert.equal(result.files, undefined);
  });
});

test("GeminiEngine: Cancellation support", async (t) => {
  await t.test("Cancels turn via engine.kill()", async () => {
    let aborted = false;

    const engine = new GeminiEngine({
      apiKey: "test-key",
      fetchFn: async (_url, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return createHangingResponse(init?.signal);
      },
    });

    const sink: TurnSink = {
      onSession() {},
      onEvent() {},
      async onRequest() {
        return "accept";
      },
    };

    const input: TurnInput = {
      instructions: "Run task",
      prompt: "Do long running work",
      cwd: "C:/AI-Projects/Nexora",
      access: "supervised",
    };

    const turnPromise = engine.runTurn(input, sink);

    // Give turn time to start and register controller
    await new Promise((r) => setTimeout(r, 30));

    // Kill engine
    await engine.kill();

    const result = await turnPromise;

    assert.equal(result.outcome, "cancelled");
    assert.equal(result.text, "Turn was cancelled");
    assert.equal(aborted, true);
  });
});

test("GeminiEngine: Timeout handling", async (t) => {
  await t.test("Fails turn when timeoutMs expires", async () => {
    const engine = new GeminiEngine({
      apiKey: "test-key",
      fetchFn: async (_url, init) => createHangingResponse(init?.signal),
    });

    const sink: TurnSink = {
      onSession() {},
      onEvent() {},
      async onRequest() {
        return "accept";
      },
    };

    const input: TurnInput = {
      instructions: "Run task",
      prompt: "Do long running work",
      cwd: "C:/AI-Projects/Nexora",
      access: "supervised",
      timeoutMs: 60,
    };

    const startTime = Date.now();
    const result = await engine.runTurn(input, sink);
    const duration = Date.now() - startTime;

    assert.equal(result.outcome, "failed");
    assert.equal(result.error, "TimeoutError");
    assert.ok(result.text.includes("timed out after 60ms"));
    assert.ok(duration >= 50);
  });
});

test("GeminiEngine: HTTP Error handling", async (t) => {
  await t.test("Returns failed outcome on HTTP 500 error", async () => {
    const engine = new GeminiEngine({
      apiKey: "test-key",
      fetchFn: async () => {
        return new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        });
      },
    });

    const sink: TurnSink = {
      onSession() {},
      onEvent() {},
      async onRequest() {
        return "accept";
      },
    };

    const input: TurnInput = {
      instructions: "Run task",
      prompt: "Test error handling",
      cwd: "C:/AI-Projects/Nexora",
      access: "supervised",
    };

    const result = await engine.runTurn(input, sink);

    assert.equal(result.outcome, "failed");
    assert.equal(result.error, "HTTP_500");
    assert.ok(result.text.includes("500"));
  });
});
