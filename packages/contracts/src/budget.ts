/**
 * Nexora Budget & Request Reservation Contract
 */

import type { ModelRegistration, PriceClass } from "./provider.ts";

export type RoutingPolicyMode = "free-only" | "budgeted" | "quality-first";

export interface ReservationRequest {
  runId: string;
  taskId: string;
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  maxToolCalls?: number;
}

export type ReservationStatus = "reserved" | "reconciled" | "released" | "expired";

export interface ReservationRecord {
  id: string;
  runId: string;
  taskId: string;
  modelId: string;
  reservedTokens: number;
  status: ReservationStatus;
  createdAt: number;
  expiresAt: number;
}

export interface UsageReconciliation {
  reservationId: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualReasoningTokens?: number;
  totalTokens: number;
  durationMs: number;
}

export class DisallowedPaidEndpointError extends Error {
  constructor(modelId: string, priceClass: PriceClass) {
    super(`Model '${modelId}' with price class '${priceClass}' rejected: runtime is restricted to free-only routing.`);
    this.name = "DisallowedPaidEndpointError";
  }
}

export class InsufficientBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientBudgetError";
  }
}
