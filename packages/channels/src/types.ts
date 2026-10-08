/**
 * Nexora Channels & UX Cards Types
 */

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
  };
}

export interface ApprovalCard {
  approvalId: string;
  action: string;
  arguments: Record<string, unknown>;
  resource: string;
  actor: string;
  runId: string;
  status: "pending" | "approved" | "denied";
  humanReadableTitle: string;
  humanReadableDescription: string;
  riskLevel: "low" | "medium" | "high";
}

export interface SystemStatusSummary {
  quota: {
    status: "healthy" | "rate_limited" | "exhausted";
    retryAfterSeconds?: number;
    message: string;
  };
  approvals: {
    pendingCount: number;
    pendingCards: ApprovalCard[];
  };
  runners: {
    onlineCount: number;
    offlineCount: number;
    list: Array<{ id: string; name: string; status: "online" | "offline" }>;
  };
}
