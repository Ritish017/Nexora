/**
 * Nexora Canonical Types & Lifecycle Definitions
 * 
 * Reuses concepts from Perry (TheM1N9/perry, commit 0a9ad789) for task lifecycle,
 * opaque engine cursors, and monotonic events.
 */

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "uncertain_effect";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired";

export interface TaskRecord {
  id: string;
  ownerId: string;
  projectId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  status: TaskStatus;
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  agentId: string;
  status: RunStatus;
  claimedBy: string | null;
  leaseExpiresAt: number | null;
  sessionCursor: string | null;
  uncertainEffect: boolean;
  uncertainReason: string | null;
  startedAt: number;
  endedAt: number | null;
  output: Record<string, unknown> | null;
  error: string | null;
}

export interface NormalizedEvent {
  id: string;
  runId: string;
  seq: number; // Monotonically increasing per run
  type:
    | "status_change"
    | "log"
    | "progress"
    | "item_started"
    | "item_completed"
    | "approval_requested"
    | "approval_resolved"
    | "artifact_saved";
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  action: string;
  argumentsHash: string;
  resource: string;
  actor: string;
  policyVersion: string;
  expiry: number;
  status: ApprovalStatus;
  decisionBy: string | null;
  decisionAt: number | null;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  taskId: string;
  name: string;
  filePath: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface VerificationResult {
  verified: boolean;
  checks: VerificationCheck[];
  timestamp: number;
}
