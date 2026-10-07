/**
 * Nexora Governed Tool Execution Contract
 */

export interface GovernedToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface GovernedToolResult {
  callId: string;
  output: unknown;
  requiresApproval: boolean;
  approvalId?: string;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
  isMutating: boolean; // Mutating actions require explicit approval under supervised mode
}
