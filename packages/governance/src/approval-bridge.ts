/**
 * Nexora Approval Bridge
 * 
 * Cryptographically binds action approvals to:
 * (action, argumentsHash, resource, actor, runId, policyVersion, expiry)
 * 
 * Enforces security invariants:
 * 1. Exact argument hash match: any mutation between approval and execution forces re-approval.
 * 2. Expiry bounds: expired approvals cannot be executed.
 * 3. One-time execution: approved tokens can only be consumed once.
 * 4. Cryptographic HMAC signature verification against secret.
 */

import {
  hashArguments,
  createApprovalSignature,
  verifyApprovalSignature,
  type ApprovalBindingParams,
} from "./credential-derivation.ts";

export interface ApprovalRequest {
  id: string;
  runId: string;
  action: string;
  argumentsHash: string;
  resource: string;
  actor: string;
  policyVersion: string;
  expiry: number;
  signature: string;
  status: "pending" | "approved" | "denied" | "expired";
  decisionBy?: string;
  decisionAt?: number;
  consumed: boolean;
  consumedAt?: number;
}

export class ApprovalBridge {
  readonly signingSecret: string;
  private readonly approvals: Map<string, ApprovalRequest>;

  constructor(signingSecret: string) {
    if (!signingSecret || signingSecret.length < 16) {
      throw new Error("Approval signing secret must have at least 16 characters.");
    }
    this.signingSecret = signingSecret;
    this.approvals = new Map();
  }

  /**
   * Generates a new cryptographically bound approval request.
   */
  createRequest(params: {
    id: string;
    runId: string;
    action: string;
    args: Record<string, unknown>;
    resource: string;
    actor: string;
    policyVersion: string;
    ttlMs?: number;
  }): ApprovalRequest {
    const argsHash = hashArguments(params.args);
    const expiry = Date.now() + (params.ttlMs ?? 300000); // 5 min default

    const bindingParams: ApprovalBindingParams = {
      action: params.action,
      argumentsHash: argsHash,
      resource: params.resource,
      actor: params.actor,
      runId: params.runId,
      policyVersion: params.policyVersion,
      expiry,
    };

    const signature = createApprovalSignature(this.signingSecret, bindingParams);

    const request: ApprovalRequest = {
      id: params.id,
      runId: params.runId,
      action: params.action,
      argumentsHash: argsHash,
      resource: params.resource,
      actor: params.actor,
      policyVersion: params.policyVersion,
      expiry,
      signature,
      status: "pending",
      consumed: false,
    };

    this.approvals.set(request.id, request);
    return request;
  }

  /**
   * Resolves an approval request with human owner decision.
   */
  resolveRequest(
    approvalId: string,
    approved: boolean,
    decisionBy: string
  ): ApprovalRequest {
    const request = this.approvals.get(approvalId);
    if (!request) {
      throw new Error(`Approval request '${approvalId}' not found.`);
    }

    if (request.status !== "pending") {
      throw new Error(`Approval request is already in status '${request.status}'.`);
    }

    if (Date.now() > request.expiry) {
      request.status = "expired";
      throw new Error(`Approval request '${approvalId}' has expired.`);
    }

    request.status = approved ? "approved" : "denied";
    request.decisionBy = decisionBy;
    request.decisionAt = Date.now();
    return request;
  }

  /**
   * Verifies approval and authorizes action execution.
   * Enforces: status === 'approved', unexpired, unconsumed, identical arguments, valid signature.
   */
  authorizeExecution(params: {
    approvalId: string;
    runId: string;
    proposedArgs: Record<string, unknown>;
    actor: string;
  }): { authorized: boolean; reason?: string } {
    const request = this.approvals.get(params.approvalId);
    if (!request) {
      return { authorized: false, reason: `Approval request '${params.approvalId}' not found.` };
    }

    if (request.consumed) {
      return { authorized: false, reason: "Approval token has already been consumed (replay prevention)." };
    }

    if (request.status !== "approved") {
      return { authorized: false, reason: `Approval status is '${request.status}', expected 'approved'.` };
    }

    if (Date.now() > request.expiry) {
      request.status = "expired";
      return { authorized: false, reason: "Approval token has expired." };
    }

    if (request.runId !== params.runId) {
      return { authorized: false, reason: "Run ID mismatch: cross-run execution forbidden." };
    }

    if (request.actor !== params.actor) {
      return { authorized: false, reason: "Actor mismatch: cross-actor execution forbidden." };
    }

    // Cryptographic signature verification
    const bindingParams: ApprovalBindingParams = {
      action: request.action,
      argumentsHash: request.argumentsHash,
      resource: request.resource,
      actor: request.actor,
      runId: request.runId,
      policyVersion: request.policyVersion,
      expiry: request.expiry,
    };

    if (!verifyApprovalSignature(this.signingSecret, bindingParams, request.signature)) {
      return { authorized: false, reason: "Invalid cryptographic signature on approval request." };
    }

    // Argument mutation check: compare proposed arguments with approved arguments
    const proposedHash = hashArguments(params.proposedArgs);
    if (proposedHash !== request.argumentsHash) {
      return {
        authorized: false,
        reason: "Proposed arguments do not match approved argument hash; re-approval required.",
      };
    }

    // Mark as consumed
    request.consumed = true;
    request.consumedAt = Date.now();

    return { authorized: true };
  }

  getRequest(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId);
  }
}
