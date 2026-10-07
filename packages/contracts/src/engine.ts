/**
 * Nexora Engine Contract
 * 
 * Reuses and adapts Perry's engine interface (repos/perry/runner/engine.ts, MIT)
 * for direct API engines (Gemini 3.8 Flash, local models) and headless runners.
 */

export type Access = "supervised" | "auto" | "full";
export type EngineKind = "direct-api" | "antigravity" | "claude" | "codex" | "grok" | "local-openai";

export type SteerMode = "native" | "concurrent-prompt" | "cancel-and-resend" | "queue";

export interface EngineCapabilities {
  steer: SteerMode;
  compaction: { type: "native" } | { type: "slash-command"; command: string } | { type: "none" };
  approvals: boolean;
  sandbox: Partial<Record<NodeJS.Platform, readonly Access[]>>;
  images: boolean;
  modelSwitchInSession: boolean;
  usage: "complete" | "partial" | "unavailable";
  quickTurns: boolean;
  guestLockdown: boolean;
  concurrentTurns?: boolean;
  skills?: boolean;
}

export interface EngineModel {
  id: string;
  name: string;
  isDefault: boolean;
  efforts?: string[];
  defaultEffort?: string;
}

export interface EngineStatus {
  kind: EngineKind;
  installed: boolean;
  version?: string;
  signedIn: boolean;
  auth: { type?: string; label?: string; email?: string; plan?: string };
  models: EngineModel[];
  message?: string;
  error?: string;
}

export const ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "web_search",
  "image_generation",
  "reasoning",
  "context_compaction",
  "plan",
  "error",
  "unknown",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemStatus = "running" | "completed" | "failed" | "declined";

export interface EngineItem {
  id: string;
  type: ItemType;
  status: ItemStatus;
  title: string;
  input?: string;
  output?: string;
  durationMs?: number;
  raw: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type TurnEvent =
  | { type: "text"; stream: "assistant" | "reasoning"; itemId: string; delta: string; text: string }
  | { type: "item"; phase: "started" | "updated" | "completed"; item: EngineItem; atMs: number }
  | { type: "usage"; state: "complete" | "partial"; usage: TokenUsage; contextWindow?: number }
  | { type: "usage"; state: "unavailable" };

export type RequestType = "exec_command_approval" | "file_change_approval" | "permission_approval" | "tool_user_input";
export type RequestOption = { id: string; kind: "accept" | "acceptForSession" | "decline"; label: string };

export interface EngineRequest {
  type: RequestType;
  detail: {
    command?: string;
    cwd?: string;
    reason?: string;
    changes?: Array<{ path: string; kind?: string; diff?: string }>;
    server?: string;
    message?: string;
  };
  options: RequestOption[];
  raw: unknown;
}

export interface TurnHandle {
  cursor: string;
  turnId: string;
}

export interface EngineAttachment {
  url?: string;
  localPath?: string;
  fileName: string;
  contentType?: string;
}

export interface TurnInput {
  resumeCursor?: string;
  instructions: string;
  history?: string;
  recalled?: string;
  prompt: string;
  attachments?: EngineAttachment[];
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  timeoutMs?: number;
}

export interface TurnSink {
  onSession(cursor: string, oldCursor?: string): void;
  onEvent(event: TurnEvent): void;
  onRequest(request: EngineRequest): Promise<string>;
  onHandle?(handle: TurnHandle): void;
}

export type TurnResult =
  | { outcome: "completed"; text: string; files?: string[]; usage?: TokenUsage }
  | { outcome: "failed"; text: string; error?: string }
  | { outcome: "interrupted"; text: string }
  | { outcome: "cancelled"; text: string };

export interface Engine {
  status(): Promise<EngineStatus>;
  runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult>;
  kill(): Promise<void>;
  readonly capabilities: EngineCapabilities;
}
