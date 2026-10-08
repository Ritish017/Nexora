/**
 * Nexora Action Policy Engine
 * 
 * Enforces action policies (supervised, auto, full) and safety boundaries:
 * - Supervised mode: mutating actions require owner approval before execution.
 * - Auto mode: actions within workspace bounds run automatically; dangerous system commands blocked.
 * - Full mode: all non-prohibited actions allowed.
 * - Granular safety invariants: path traversal prevention, prohibited command filtering.
 */

export type GovernanceMode = "supervised" | "auto" | "full";

export interface GovernancePolicy {
  version: string;
  mode: GovernanceMode;
  allowedPaths: string[];
  deniedCommands: RegExp[];
}

export interface ActionEvaluation {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  isMutating: boolean;
}

export class PolicyEngine {
  readonly policy: GovernancePolicy;

  constructor(policy?: Partial<GovernancePolicy>) {
    this.policy = {
      version: policy?.version ?? "1.0.0",
      mode: policy?.mode ?? "supervised",
      allowedPaths: policy?.allowedPaths ?? ["workspace/"],
      deniedCommands: policy?.deniedCommands ?? [
        /\brm\s+-(rf|fr|r\s+f|f\s+r)\s+(\/|\*)/i,
        /\bmkfs\b/i,
        /\bdd\s+if=/i,
        /\bchmod\s+-R\s+777\s+\//i,
        />\s*\/dev\/sd[a-z]/i,
        /\bshutdown\b/i,
        /\breboot\b/i,
        /:(){ :\|:& };:/, // Fork bomb
      ],
    };
  }

  /**
   * Identifies whether an action is mutating (causes side-effects on files, processes, or external state).
   */
  isMutatingAction(action: string): boolean {
    const mutatingPrefixes = ["files_write", "files_delete", "files_create", "browser_click", "browser_fill", "browser_type", "browser_submit"];
    if (mutatingPrefixes.some((p) => action.startsWith(p))) return true;
    if (action === "exec" || action === "start" || action === "stop" || action === "reset") return true;
    return false;
  }

  /**
   * Validates path arguments to prevent directory traversal outside allowed workspaces.
   */
  checkPathSafety(pathValue: string): { safe: boolean; reason?: string } {
    if (!pathValue || typeof pathValue !== "string") {
      return { safe: false, reason: "Invalid path format" };
    }

    // Reject null bytes
    if (pathValue.includes("\0")) {
      return { safe: false, reason: "Null byte injection detected in path" };
    }

    // Normalize slashes
    const normalized = pathValue.replace(/\\/g, "/");

    // Check for directory traversal sequences
    if (normalized.includes("../") || normalized.includes("/..") || normalized === "..") {
      return { safe: false, reason: "Path traversal sequence ('..') detected" };
    }

    // Check for host root escape
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      return { safe: false, reason: "Absolute root path traversal prohibited; paths must be relative to workspace" };
    }

    return { safe: true };
  }

  /**
   * Evaluates proposed action against governance policy.
   */
  evaluateAction(
    action: string,
    args: Record<string, unknown> = {},
    actor: "owner" | "agent" = "agent"
  ): ActionEvaluation {
    const isMutating = this.isMutatingAction(action);

    // 1. Filesystem safety inspection
    if (args.path && typeof args.path === "string") {
      const pathCheck = this.checkPathSafety(args.path);
      if (!pathCheck.safe) {
        return {
          allowed: false,
          requiresApproval: false,
          isMutating,
          reason: `Policy denial: ${pathCheck.reason}`,
        };
      }
    }

    if (args.target && typeof args.target === "string") {
      const targetCheck = this.checkPathSafety(args.target);
      if (!targetCheck.safe) {
        return {
          allowed: false,
          requiresApproval: false,
          isMutating,
          reason: `Policy denial: ${targetCheck.reason}`,
        };
      }
    }

    // 2. Command execution inspection
    if (action === "exec" && typeof args.command === "string") {
      for (const pattern of this.policy.deniedCommands) {
        if (pattern.test(args.command)) {
          return {
            allowed: false,
            requiresApproval: false,
            isMutating,
            reason: `Policy denial: prohibited system command pattern '${pattern.source}'`,
          };
        }
      }
    }

    // 3. Owner actions bypass approval requirement
    if (actor === "owner") {
      return {
        allowed: true,
        requiresApproval: false,
        isMutating,
      };
    }

    // 4. Governance Mode Evaluation for Agent actors
    if (this.policy.mode === "supervised") {
      if (isMutating) {
        return {
          allowed: true,
          requiresApproval: true,
          isMutating,
          reason: `Action '${action}' is mutating and requires owner approval under supervised policy.`,
        };
      }
      return {
        allowed: true,
        requiresApproval: false,
        isMutating,
      };
    }

    if (this.policy.mode === "auto") {
      // In auto mode, safe workspace mutations are permitted without pausing for approval
      return {
        allowed: true,
        requiresApproval: false,
        isMutating,
      };
    }

    if (this.policy.mode === "full") {
      return {
        allowed: true,
        requiresApproval: false,
        isMutating,
      };
    }

    return {
      allowed: false,
      requiresApproval: false,
      isMutating,
      reason: `Unknown governance mode '${this.policy.mode}'`,
    };
  }
}
