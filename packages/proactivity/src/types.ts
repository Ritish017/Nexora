/**
 * Nexora Proactivity & Delegation Types
 * 
 * Reuses concepts from Perry (repos/perry/convex/jobs.ts) for quiet delivery (QUIET = "NOTHING")
 * and Asia/Kolkata default scheduling.
 */

export const QUIET = "NOTHING";

export interface GoalRecord {
  id: string;
  title: string;
  criteria: string[];
  status: "active" | "achieved" | "paused" | "abandoned";
  budgetTokens: number;
  consumedTokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  cronExpression?: string; // e.g. "0 9 * * *"
  intervalMs?: number;     // for timer intervals
  runAt?: number;          // for one-shot reminders
  timezone: string;        // default "Asia/Kolkata"
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
}

export interface IncomingEvent {
  source: string;
  eventId: string;
  topic: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface DelegationNode {
  agentId: string;
  parentId: string | null;
  depth: number;
  maxDepth: number;
  taskId: string;
  status: "running" | "completed" | "cancelled" | "failed";
}
