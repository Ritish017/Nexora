/**
 * Nexora Cryptographic Credential Derivation & Approval Signature Module
 * 
 * Complies with OpenDots pin b6932d31a8d6e7896c15139dfc27a6c6911deb27:
 * - Derives per-Dot container credentials: HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)
 * - Cryptographically binds action approvals to (action, argumentsHash, resource, actor, runId, policyVersion, expiry)
 */

import { createHmac, createHash } from "node:crypto";

export interface ApprovalBindingParams {
  action: string;
  argumentsHash: string;
  resource: string;
  actor: string;
  runId: string;
  policyVersion: string;
  expiry: number;
}

/**
 * Computes deterministic SHA-256 hash of arguments using sorted canonical JSON serialization.
 */
export function hashArguments(args: unknown): string {
  const serialize = (obj: any): string => {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return "[" + obj.map(serialize).join(",") + "]";
    }
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") + "}";
  };

  return createHash("sha256").update(serialize(args)).digest("hex");
}

/**
 * Derives isolated container credential for a given Dot/Agent ID.
 * Follows OpenDots deployment contract:
 * HMAC-SHA256(master, "opendots-computer:" + dotId)
 */
export function deriveComputerToken(masterSecret: string, dotId: string): string {
  const master = masterSecret?.trim();
  if (!master || master.length < 24) {
    throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");
  }
  if (!dotId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId)) {
    throw new Error(`Invalid dotId '${dotId}': must be 1-64 alphanumeric, underscore or dash characters.`);
  }

  return createHmac("sha256", master)
    .update(`opendots-computer:${dotId}`)
    .digest("hex");
}

/**
 * Computes cryptographic signature binding an approval decision to all its execution parameters.
 */
export function createApprovalSignature(
  signingSecret: string,
  params: ApprovalBindingParams
): string {
  const secret = signingSecret?.trim();
  if (!secret || secret.length < 16) {
    throw new Error("Signing secret must contain at least 16 characters.");
  }

  const payload = [
    params.action,
    params.argumentsHash,
    params.resource,
    params.actor,
    params.runId,
    params.policyVersion,
    String(params.expiry),
  ].join(":");

  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verifies that an approval signature matches the binding parameters.
 */
export function verifyApprovalSignature(
  signingSecret: string,
  params: ApprovalBindingParams,
  signature: string
): boolean {
  try {
    const expected = createApprovalSignature(signingSecret, params);
    return expected === signature;
  } catch {
    return false;
  }
}
