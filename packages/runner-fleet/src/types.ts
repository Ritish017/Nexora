/**
 * Nexora Runner Fleet Types
 * 
 * Complies with Perry runner pairing protocol (repos/perry/convex/runner.ts).
 */

export type RunnerPolicy = "supervised" | "auto" | "full";

export interface RunnerRecord {
  id: string;
  name: string;
  token: string;
  policy: RunnerPolicy;
  revoked: boolean;
  platform?: string;
  hostname?: string;
  workdir?: string;
  lastSeenAt: number;
  createdAt: number;
}

export interface PairingCodeRecord {
  code: string;
  runnerName: string;
  expiresAt: number;
  used: boolean;
  createdAt: number;
}

export interface RunnerCheckInInput {
  token: string;
  platform?: string;
  hostname?: string;
  workdir?: string;
  policy?: RunnerPolicy;
}
