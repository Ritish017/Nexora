/**
 * Nexora UI Cards & Human-Readable State Presenters
 * 
 * Formats approvals, quota states, and runner fleet status into human-friendly cards.
 */

import type { ApprovalRecord } from "../../runtime/src/index.ts";
import type { ApprovalCard, SystemStatusSummary } from "./types.ts";

export class UiCardPresenter {
  /**
   * Translates a raw cryptographic approval record into a clear, human-readable card.
   */
  static renderApprovalCard(
    record: ApprovalRecord,
    args: Record<string, unknown> = {}
  ): ApprovalCard {
    let title = `Action: ${record.action}`;
    let description = `Proposed execution on ${record.resource} by ${record.actor}`;
    let riskLevel: "low" | "medium" | "high" = "medium";

    if (record.action === "exec") {
      const cmd = String(args.command ?? "");
      title = `Terminal Command Execution`;
      description = `Run command: \`${cmd}\``;
      riskLevel = cmd.includes("rm") || cmd.includes("kill") || cmd.includes("sudo") ? "high" : "medium";
    } else if (record.action === "files_write" || record.action === "files_delete") {
      const path = String(args.path ?? args.target ?? "");
      title = record.action === "files_write" ? "File Modification" : "File Deletion";
      description = `${record.action === "files_write" ? "Write" : "Delete"} file at \`${path}\``;
      riskLevel = record.action === "files_delete" ? "high" : "medium";
    } else if (record.action.startsWith("browser_")) {
      title = `Browser Automation`;
      description = `Perform browser action '${record.action.replace("browser_", "")}'`;
      riskLevel = "low";
    }

    return {
      approvalId: record.id,
      action: record.action,
      arguments: args,
      resource: record.resource,
      actor: record.actor,
      runId: record.runId,
      status: record.status as any,
      humanReadableTitle: title,
      humanReadableDescription: description,
      riskLevel,
    };
  }

  /**
   * Formats system status into human-readable text dashboard.
   */
  static formatDashboardSummary(summary: SystemStatusSummary): string {
    const lines: string[] = [
      "╔════════════════════════════════════════════════╗",
      "║             NEXORA SYSTEM OVERVIEW             ║",
      "╚════════════════════════════════════════════════╝",
      "",
      `▶ Quota & Routing: [${summary.quota.status.toUpperCase()}]`,
      `  ${summary.quota.message}`,
    ];

    if (summary.quota.retryAfterSeconds) {
      lines.push(`  Cool-down active: ready in ~${summary.quota.retryAfterSeconds}s`);
    }

    lines.push("");
    lines.push(`▶ Action Approvals: ${summary.approvals.pendingCount} pending`);
    for (const card of summary.approvals.pendingCards) {
      lines.push(`  - [${card.riskLevel.toUpperCase()}] ${card.humanReadableTitle}: ${card.humanReadableDescription}`);
      lines.push(`    ID: ${card.approvalId}`);
    }

    lines.push("");
    lines.push(`▶ Runner Fleet: ${summary.runners.onlineCount} online, ${summary.runners.offlineCount} offline`);
    for (const runner of summary.runners.list) {
      const dot = runner.status === "online" ? "●" : "○";
      lines.push(`  ${dot} ${runner.name} (${runner.status})`);
    }

    return lines.join("\n");
  }
}
