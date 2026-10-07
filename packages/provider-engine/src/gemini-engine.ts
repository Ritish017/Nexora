/**
 * Nexora Direct Gemini 3.8 Flash Engine Provider
 *
 * Implements the Nexora Engine interface for direct Gemini API (v1beta) interaction.
 * Provides streaming text (assistant + reasoning thoughts), tool call governance,
 * timeout controls, and cooperative cancellation.
 */

import type {
  Engine,
  EngineCapabilities,
  EngineItem,
  EngineRequest,
  EngineStatus,
  ItemType,
  RequestOption,
  RequestType,
  TokenUsage,
  TurnEvent,
  TurnInput,
  TurnResult,
  TurnSink,
} from "../../contracts/src/engine.ts";

export interface GeminiEngineOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  defaultModel?: string;
}

interface GeminiCandidatePart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiCandidatePart[];
    role?: string;
  };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thinkingTokenCount?: number;
  candidatesTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
}

interface GeminiChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class GeminiEngine implements Engine {
  readonly capabilities: EngineCapabilities = {
    approvals: true,
    steer: "queue",
    compaction: { type: "none" },
    sandbox: {},
    images: true,
    modelSwitchInSession: false,
    usage: "complete",
    quickTurns: true,
    guestLockdown: true,
  };

  private apiKey?: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private defaultModel: string;
  private activeControllers: Set<AbortController> = new Set();

  constructor(options?: GeminiEngineOptions) {
    this.apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY;
    this.baseUrl = (options?.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.defaultModel = options?.defaultModel ?? "gemini-3.8-flash";
  }

  async status(): Promise<EngineStatus> {
    const key = this.apiKey ?? process.env.GEMINI_API_KEY;
    const signedIn = Boolean(key && key.trim().length > 0);

    return {
      kind: "direct-api",
      installed: true,
      signedIn,
      auth: {
        type: "api-key",
        label: "GEMINI_API_KEY",
      },
      models: [
        {
          id: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
          isDefault: true,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
      ],
      message: signedIn ? "Ready" : "GEMINI_API_KEY is not configured",
    };
  }

  async kill(): Promise<void> {
    for (const controller of this.activeControllers) {
      controller.abort(new Error("Engine killed"));
    }
    this.activeControllers.clear();
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const controller = new AbortController();
    this.activeControllers.add(controller);

    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;

    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("TimeoutError"));
      }, input.timeoutMs);
    }

    let rawResponseBody: any = null;

    try {
      const sessionCursor = input.resumeCursor ?? `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      sink.onSession(sessionCursor, input.resumeCursor);
      if (sink.onHandle) {
        sink.onHandle({
          cursor: sessionCursor,
          turnId: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        });
      }

      // Check key configuration
      const key = this.apiKey ?? process.env.GEMINI_API_KEY;

      const model = input.model ?? this.defaultModel;
      const effort = input.effort ?? "medium";
      const thinkingBudget = effort === "low" ? 1024 : effort === "high" ? 8192 : 4096;

      // Construct Gemini request
      const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

      if (input.history) {
        contents.push({
          role: "user",
          parts: [{ text: `[Prior History]\n${input.history}` }],
        });
        contents.push({
          role: "model",
          parts: [{ text: "Acknowledged prior context." }],
        });
      }

      const userParts: Array<Record<string, unknown>> = [];
      if (input.recalled) {
        userParts.push({ text: `[Recalled Context]\n${input.recalled}\n` });
      }
      userParts.push({ text: input.prompt });

      if (input.attachments && input.attachments.length > 0) {
        for (const att of input.attachments) {
          if (att.url) {
            userParts.push({ text: `[Attachment: ${att.fileName} at ${att.url}]` });
          } else if (att.localPath) {
            userParts.push({ text: `[Attachment: ${att.fileName} path: ${att.localPath}]` });
          }
        }
      }

      contents.push({
        role: "user",
        parts: userParts,
      });

      const requestBody: Record<string, unknown> = {
        contents,
        generationConfig: {
          thinkingConfig: {
            thinkingBudget,
          },
        },
      };

      if (input.instructions) {
        requestBody.systemInstruction = {
          parts: [{ text: input.instructions }],
        };
      }

      let url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      if (key) {
        url += `&key=${encodeURIComponent(key)}`;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (key) {
        headers["x-goog-api-key"] = key;
      }

      const response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      rawResponseBody = response.body;

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        return {
          outcome: "failed",
          text: `Gemini API error (${response.status}): ${errorText}`,
          error: `HTTP_${response.status}`,
        };
      }

      // Stream & event tracking
      let reasoningItemId: string | null = null;
      let accumulatedReasoning = "";
      let reasoningItemCompleted = false;

      let assistantItemId: string | null = null;
      let accumulatedAssistant = "";

      let itemCounter = 0;
      const modifiedFiles: string[] = [];

      let latestUsage: TokenUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      };
      let hasUsage = false;

      const handleChunk = async (chunk: GeminiChunk) => {
        if (chunk.error) {
          throw new Error(chunk.error.message || `Gemini API error code ${chunk.error.code}`);
        }

        // 1. Process usageMetadata if present
        if (chunk.usageMetadata) {
          const inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          const cachedInputTokens = chunk.usageMetadata.cachedContentTokenCount ?? 0;
          const outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
          let reasoningTokens = chunk.usageMetadata.thinkingTokenCount ?? 0;

          if (!reasoningTokens && Array.isArray(chunk.usageMetadata.candidatesTokensDetails)) {
            const detail = chunk.usageMetadata.candidatesTokensDetails.find(
              (d) => d.modality === "THINKING" || d.modality === "REASONING"
            );
            if (detail?.tokenCount) {
              reasoningTokens = detail.tokenCount;
            }
          }

          const totalTokens = chunk.usageMetadata.totalTokenCount ?? inputTokens + outputTokens;

          latestUsage = {
            inputTokens,
            cachedInputTokens,
            outputTokens,
            reasoningTokens,
            totalTokens,
          };
          hasUsage = true;

          sink.onEvent({
            type: "usage",
            state: "complete",
            usage: latestUsage,
          });
        }

        // 2. Process candidates & parts
        if (chunk.candidates) {
          for (const candidate of chunk.candidates) {
            const parts = candidate.content?.parts ?? [];
            for (const part of parts) {
              // A. Reasoning stream
              if (part.thought === true && part.text) {
                if (!reasoningItemId) {
                  reasoningItemId = `reasoning_${Date.now()}_${++itemCounter}`;
                  sink.onEvent({
                    type: "item",
                    phase: "started",
                    item: {
                      id: reasoningItemId,
                      type: "reasoning",
                      status: "running",
                      title: "Reasoning",
                      raw: part,
                    },
                    atMs: Date.now(),
                  });
                }

                accumulatedReasoning += part.text;
                sink.onEvent({
                  type: "text",
                  stream: "reasoning",
                  itemId: reasoningItemId,
                  delta: part.text,
                  text: accumulatedReasoning,
                });
                continue;
              }

              // B. Assistant text stream
              if (!part.thought && part.text != null) {
                // If reasoning was active, mark it completed on first assistant token
                if (reasoningItemId && !reasoningItemCompleted) {
                  reasoningItemCompleted = true;
                  sink.onEvent({
                    type: "item",
                    phase: "completed",
                    item: {
                      id: reasoningItemId,
                      type: "reasoning",
                      status: "completed",
                      title: "Reasoning",
                      output: accumulatedReasoning,
                      raw: { text: accumulatedReasoning },
                    },
                    atMs: Date.now(),
                  });
                }

                if (!assistantItemId) {
                  assistantItemId = `assistant_${Date.now()}_${++itemCounter}`;
                  sink.onEvent({
                    type: "item",
                    phase: "started",
                    item: {
                      id: assistantItemId,
                      type: "plan",
                      status: "running",
                      title: "Assistant Response",
                      raw: part,
                    },
                    atMs: Date.now(),
                  });
                }

                accumulatedAssistant += part.text;
                sink.onEvent({
                  type: "text",
                  stream: "assistant",
                  itemId: assistantItemId,
                  delta: part.text,
                  text: accumulatedAssistant,
                });
                continue;
              }

              // C. Tool calls (function calls)
              if (part.functionCall) {
                // Close any open reasoning
                if (reasoningItemId && !reasoningItemCompleted) {
                  reasoningItemCompleted = true;
                  sink.onEvent({
                    type: "item",
                    phase: "completed",
                    item: {
                      id: reasoningItemId,
                      type: "reasoning",
                      status: "completed",
                      title: "Reasoning",
                      output: accumulatedReasoning,
                      raw: { text: accumulatedReasoning },
                    },
                    atMs: Date.now(),
                  });
                }

                const fnName = part.functionCall.name;
                const args = part.functionCall.args ?? {};
                const toolItemId = `tool_${Date.now()}_${++itemCounter}`;

                let itemType: ItemType = "dynamic_tool_call";
                let requestType: RequestType = "permission_approval";
                let title = `Tool: ${fnName}`;

                if (
                  fnName === "run_command" ||
                  fnName === "exec_command" ||
                  fnName === "bash" ||
                  fnName === "execute_command"
                ) {
                  itemType = "command_execution";
                  requestType = "exec_command_approval";
                  title = `Command: ${args.command ?? fnName}`;
                } else if (
                  fnName === "write_file" ||
                  fnName === "write_to_file" ||
                  fnName === "replace_file_content" ||
                  fnName === "edit_file" ||
                  fnName === "delete_file"
                ) {
                  itemType = "file_change";
                  requestType = "file_change_approval";
                  const target = (args.path ?? args.TargetFile ?? fnName) as string;
                  title = `File Change: ${target}`;
                } else if (fnName.startsWith("mcp_")) {
                  itemType = "mcp_tool_call";
                  requestType = "permission_approval";
                  title = `MCP Tool: ${fnName}`;
                } else if (fnName.includes("search")) {
                  itemType = "web_search";
                  requestType = "permission_approval";
                  title = `Search: ${args.query ?? fnName}`;
                }

                sink.onEvent({
                  type: "item",
                  phase: "started",
                  item: {
                    id: toolItemId,
                    type: itemType,
                    status: "running",
                    title,
                    input: JSON.stringify(args),
                    raw: part.functionCall,
                  },
                  atMs: Date.now(),
                });

                const options: RequestOption[] = [
                  { id: "accept", kind: "accept", label: `Approve ${fnName}` },
                  { id: "acceptForSession", kind: "acceptForSession", label: `Always approve ${fnName} in session` },
                  { id: "decline", kind: "decline", label: `Decline ${fnName}` },
                ];

                const request: EngineRequest = {
                  type: requestType,
                  detail: {
                    command: args.command as string | undefined,
                    cwd: input.cwd,
                    reason: (args.reason as string | undefined) ?? `Requested tool execution: ${fnName}`,
                    changes:
                      args.path || args.TargetFile
                        ? [
                            {
                              path: (args.path ?? args.TargetFile) as string,
                              kind: "modify",
                              diff: (args.CodeContent ?? args.diff) as string | undefined,
                            },
                          ]
                        : undefined,
                    server: fnName,
                    message: `Engine requests approval for ${fnName}`,
                  },
                  options,
                  raw: part.functionCall,
                };

                // Route to sink.onRequest and race with cancellation / timeout
                const decision = await Promise.race([
                  sink.onRequest(request),
                  new Promise<string>((_, reject) => {
                    if (controller.signal.aborted) {
                      reject(new Error(timedOut ? "TimeoutError" : "Cancelled"));
                    } else {
                      controller.signal.addEventListener(
                        "abort",
                        () => {
                          reject(new Error(timedOut ? "TimeoutError" : "Cancelled"));
                        },
                        { once: true }
                      );
                    }
                  }),
                ]);

                // Never execute mutating tools directly; record decision
                const isApproved = decision === "accept" || decision === "acceptForSession";
                if (isApproved && (args.path ?? args.TargetFile)) {
                  modifiedFiles.push((args.path ?? args.TargetFile) as string);
                }

                sink.onEvent({
                  type: "item",
                  phase: "completed",
                  item: {
                    id: toolItemId,
                    type: itemType,
                    status: isApproved ? "completed" : "declined",
                    title,
                    input: JSON.stringify(args),
                    output: decision,
                    raw: { decision, functionCall: part.functionCall },
                  },
                  atMs: Date.now(),
                });
              }
            }
          }
        }
      };

      // Read SSE stream or body
      if (response.body) {
        for await (const chunk of parseSseStream(response.body, controller.signal)) {
          await handleChunk(chunk);
        }
      } else if (typeof (response as any).json === "function") {
        const data = await response.json();
        if (Array.isArray(data)) {
          for (const item of data) {
            await handleChunk(item);
          }
        } else if (data) {
          await handleChunk(data);
        }
      }

      if (controller.signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }

      // Close open items on stream end
      if (reasoningItemId && !reasoningItemCompleted) {
        reasoningItemCompleted = true;
        sink.onEvent({
          type: "item",
          phase: "completed",
          item: {
            id: reasoningItemId,
            type: "reasoning",
            status: "completed",
            title: "Reasoning",
            output: accumulatedReasoning,
            raw: { text: accumulatedReasoning },
          },
          atMs: Date.now(),
        });
      }

      if (assistantItemId) {
        sink.onEvent({
          type: "item",
          phase: "completed",
          item: {
            id: assistantItemId,
            type: "plan",
            status: "completed",
            title: "Assistant Response",
            output: accumulatedAssistant,
            raw: { text: accumulatedAssistant },
          },
          atMs: Date.now(),
        });
      }

      return {
        outcome: "completed",
        text: accumulatedAssistant,
        files: modifiedFiles.length > 0 ? modifiedFiles : undefined,
        usage: hasUsage ? latestUsage : undefined,
      };
    } catch (err: any) {
      if (controller.signal.aborted) {
        if (timedOut || err?.message === "TimeoutError" || err?.name === "TimeoutError") {
          return {
            outcome: "failed",
            text: `Turn timed out after ${input.timeoutMs}ms`,
            error: "TimeoutError",
          };
        }
        return {
          outcome: "cancelled",
          text: "Turn was cancelled",
        };
      }
      return {
        outcome: "failed",
        text: err?.message || String(err),
        error: err?.name || "ExecutionError",
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.activeControllers.delete(controller);
    }
  }
}

/**
 * Parses SSE chunks or newline-delimited JSON chunks from a readable stream.
 */
async function* parseSseStream(body: any, signal?: AbortSignal): AsyncGenerator<GeminiChunk, void, unknown> {
  if (!body) return;

  if (signal?.aborted) {
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      if (signal?.aborted) {
        return;
      }
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") continue;
          if (dataStr) {
            try {
              yield JSON.parse(dataStr);
            } catch {
              // Ignore partial JSON
            }
          }
        } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            yield JSON.parse(trimmed);
          } catch {
            // Ignore malformed line
          }
        }
      }
    }

    if (buffer.trim() && !signal?.aborted) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr && dataStr !== "[DONE]") {
          try {
            yield JSON.parse(dataStr);
          } catch {}
        }
      } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          yield JSON.parse(trimmed);
        } catch {}
      }
    }
  } else if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        if (signal?.aborted) {
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("data:")) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;
            if (dataStr) {
              try {
                yield JSON.parse(dataStr);
              } catch {}
            }
          } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              yield JSON.parse(trimmed);
            } catch {}
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }
}
