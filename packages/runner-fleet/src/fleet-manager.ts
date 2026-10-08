/**
 * Nexora Fleet Manager
 * 
 * Manages revocable runner credentials, pairing code exchange,
 * and outbound heartbeat tracking.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  RunnerRecord,
  PairingCodeRecord,
  RunnerCheckInInput,
  RunnerPolicy,
} from "./types.ts";

function secureCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class FleetManager {
  private readonly runners: Map<string, RunnerRecord> = new Map();
  private readonly pairingCodes: Map<string, PairingCodeRecord> = new Map();

  /**
   * Generates a short-lived pairing code (default 10 minutes) for connecting a new runner.
   */
  mintPairingCode(runnerName: string, ttlMs: number = 600000): PairingCodeRecord {
    const code = randomBytes(4).toString("hex").toUpperCase(); // 8-char hex code
    const now = Date.now();
    const record: PairingCodeRecord = {
      code,
      runnerName: runnerName.slice(0, 80),
      expiresAt: now + ttlMs,
      used: false,
      createdAt: now,
    };
    this.pairingCodes.set(code, record);
    return record;
  }

  /**
   * Redeems a pairing code to register the runner and issue an isolated runner token.
   */
  redeemPairingCode(
    code: string,
    hostInfo?: { platform?: string; hostname?: string; workdir?: string; policy?: RunnerPolicy }
  ): { runner: RunnerRecord; token: string } {
    const cleanCode = code.trim().toUpperCase();
    const pairing = this.pairingCodes.get(cleanCode);

    if (!pairing) {
      throw new Error("Invalid pairing code.");
    }

    if (pairing.used) {
      throw new Error("Pairing code has already been redeemed.");
    }

    if (Date.now() > pairing.expiresAt) {
      throw new Error("Pairing code has expired.");
    }

    pairing.used = true;

    const runnerId = `runner_${randomBytes(12).toString("hex")}`;
    const token = `rn_${randomBytes(24).toString("hex")}`;
    const now = Date.now();

    const runner: RunnerRecord = {
      id: runnerId,
      name: pairing.runnerName,
      token,
      policy: hostInfo?.policy ?? "supervised",
      revoked: false,
      platform: hostInfo?.platform,
      hostname: hostInfo?.hostname,
      workdir: hostInfo?.workdir,
      lastSeenAt: now,
      createdAt: now,
    };

    this.runners.set(runnerId, runner);
    return { runner, token };
  }

  /**
   * Authenticates a runner by its bearer token using constant-time comparison.
   */
  authenticate(token: string): RunnerRecord {
    if (!token || typeof token !== "string") {
      throw new Error("Missing runner token.");
    }

    for (const runner of this.runners.values()) {
      if (secureCompare(runner.token, token)) {
        if (runner.revoked) {
          throw new Error("This runner token has been revoked.");
        }
        return runner;
      }
    }

    throw new Error("Invalid runner token.");
  }

  /**
   * Updates last-seen timestamp and runner host information.
   */
  checkIn(input: RunnerCheckInInput): RunnerRecord {
    const runner = this.authenticate(input.token);
    runner.lastSeenAt = Date.now();
    if (input.platform) runner.platform = input.platform;
    if (input.hostname) runner.hostname = input.hostname;
    if (input.workdir) runner.workdir = input.workdir;
    if (input.policy) runner.policy = input.policy;
    return runner;
  }

  /**
   * Revokes a runner immediately.
   */
  revokeRunner(runnerId: string): void {
    const runner = this.runners.get(runnerId);
    if (runner) {
      runner.revoked = true;
    }
  }

  getRunner(runnerId: string): RunnerRecord | undefined {
    return this.runners.get(runnerId);
  }

  listRunners(): RunnerRecord[] {
    return Array.from(this.runners.values());
  }

  /**
   * Identifies offline runners whose heartbeat has exceeded the timeout threshold.
   */
  getStaleRunners(timeoutMs: number = 60000): RunnerRecord[] {
    const now = Date.now();
    return Array.from(this.runners.values()).filter(
      (r) => !r.revoked && now - r.lastSeenAt > timeoutMs
    );
  }
}
