/**
 * Nexora Quota & Rate Limit Backoff Contract
 */

export interface RateLimitState {
  provider: string;
  modelId: string;
  isRateLimited: boolean;
  retryAfterMs: number;
  resetTime: number;
  consecutive429s: number;
}

export interface BackoffPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  multiplier: 2.0,
  jitterRatio: 0.25,
};
