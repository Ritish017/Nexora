/**
 * Nexora Backoff Scheduler
 * 
 * Computes bounded jittered exponential backoff and parses HTTP 429 Retry-After
 * headers without busy-wait sleeping. Provides scheduled retry timestamps and
 * tracks per-model rate limit state.
 */

import {
  DEFAULT_BACKOFF_POLICY,
  type BackoffPolicy,
  type RateLimitState,
} from "../../contracts/src/quota.ts";

export interface ComputeBackoffOptions {
  attempt: number;
  retryAfterHeader?: string | number | null;
  now?: number;
  customJitter?: number; // 0..1 deterministic jitter factor for testing
}

export interface BackoffSchedule {
  delayMs: number;
  retryAt: number;
  attempt: number;
  fromRetryAfter: boolean;
}

export class BackoffScheduler {
  private readonly policy: BackoffPolicy;
  private readonly rateLimits = new Map<string, RateLimitState>();

  constructor(policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY) {
    this.policy = { ...policy };
  }

  /**
   * Return active backoff policy.
   */
  getPolicy(): BackoffPolicy {
    return { ...this.policy };
  }

  /**
   * Parse HTTP 'Retry-After' header.
   * Supports:
   * - Numeric string or number in seconds (e.g. "30" -> 30,000ms)
   * - Fractional seconds (e.g. "2.5" -> 2,500ms)
   * - HTTP-date string (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
   * Returns delay in milliseconds, or null if missing/unparseable.
   */
  parseRetryAfter(
    header?: string | number | null,
    now = Date.now()
  ): number | null {
    if (header === undefined || header === null || header === "") {
      return null;
    }

    if (typeof header === "number") {
      if (Number.isNaN(header) || !Number.isFinite(header)) return null;
      return Math.max(0, Math.round(header * 1000));
    }

    const trimmed = header.trim();

    // Check numeric seconds (integer or decimal)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const seconds = parseFloat(trimmed);
      if (!Number.isNaN(seconds) && Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
      }
    }

    // Check HTTP-date format
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      const diffMs = parsedDate - now;
      return Math.max(0, diffMs);
    }

    return null;
  }

  /**
   * Calculate bounded exponential delay for a given retry attempt index (0-based or 1-based).
   */
  calculateExponentialDelay(attempt: number): number {
    const safeAttempt = Math.max(0, attempt);
    const delay = this.policy.initialDelayMs * Math.pow(this.policy.multiplier, safeAttempt);
    return Math.min(delay, this.policy.maxDelayMs);
  }

  /**
   * Apply jitter within ±(jitterRatio * delay), bounded by [0, maxDelayMs].
   */
  applyJitter(baseDelayMs: number, jitterFactor?: number): number {
    const ratio = this.policy.jitterRatio;
    const factor = jitterFactor !== undefined ? Math.min(1, Math.max(0, jitterFactor)) : Math.random();

    const minDelay = Math.max(0, baseDelayMs * (1 - ratio));
    const maxDelay = Math.min(this.policy.maxDelayMs, baseDelayMs * (1 + ratio));

    const jittered = minDelay + factor * (maxDelay - minDelay);
    return Math.min(this.policy.maxDelayMs, Math.max(0, Math.round(jittered)));
  }

  /**
   * Compute backoff duration and scheduled retry timestamp.
   * If Retry-After header is provided and valid, it is honored (bounded by maxDelayMs).
   * Otherwise, exponential backoff with bounded jitter is calculated.
   */
  computeBackoff(options: ComputeBackoffOptions): BackoffSchedule {
    const now = options.now ?? Date.now();
    const parsedHeader = this.parseRetryAfter(options.retryAfterHeader, now);

    let delayMs: number;
    let fromRetryAfter = false;

    if (parsedHeader !== null) {
      // Bounded by maxDelayMs to prevent infinite deadlocks
      delayMs = Math.min(parsedHeader, this.policy.maxDelayMs);
      fromRetryAfter = true;
    } else {
      const baseDelay = this.calculateExponentialDelay(options.attempt);
      delayMs = this.applyJitter(baseDelay, options.customJitter);
      fromRetryAfter = false;
    }

    return {
      delayMs,
      retryAt: now + delayMs,
      attempt: options.attempt,
      fromRetryAfter,
    };
  }

  /**
   * Record a 429 response for a model/provider, incrementing consecutive count
   * and updating the rate limit state with scheduled reset time.
   */
  record429(
    modelId: string,
    retryAfterHeader?: string | number | null,
    provider = "google",
    now = Date.now()
  ): RateLimitState {
    const key = `${provider}:${modelId}`;
    const previous = this.rateLimits.get(key);
    const consecutive429s = (previous?.consecutive429s ?? 0) + 1;

    const schedule = this.computeBackoff({
      attempt: consecutive429s - 1,
      retryAfterHeader,
      now,
    });

    const state: RateLimitState = {
      provider,
      modelId,
      isRateLimited: true,
      retryAfterMs: schedule.delayMs,
      resetTime: schedule.retryAt,
      consecutive429s,
    };

    this.rateLimits.set(key, state);
    return { ...state };
  }

  /**
   * Check whether a model is currently rate limited.
   */
  isRateLimited(modelId: string, provider = "google", now = Date.now()): boolean {
    const key = `${provider}:${modelId}`;
    const state = this.rateLimits.get(key);
    if (!state) return false;

    if (now >= state.resetTime) {
      // Cooldown expired
      this.rateLimits.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get remaining wait time in milliseconds for a rate-limited model.
   * Returns 0 if not rate-limited.
   */
  getRemainingWaitMs(modelId: string, provider = "google", now = Date.now()): number {
    const key = `${provider}:${modelId}`;
    const state = this.rateLimits.get(key);
    if (!state) return 0;

    const remaining = state.resetTime - now;
    return Math.max(0, remaining);
  }

  /**
   * Reset rate limit state for a model upon successful response.
   */
  reset(modelId: string, provider = "google"): void {
    const key = `${provider}:${modelId}`;
    this.rateLimits.delete(key);
  }

  /**
   * Retrieve active RateLimitState if exists.
   */
  getState(modelId: string, provider = "google"): RateLimitState | undefined {
    const key = `${provider}:${modelId}`;
    const state = this.rateLimits.get(key);
    return state ? { ...state } : undefined;
  }

  /**
   * Non-busy-wait timer that sleeps for specified milliseconds using event-loop timer.
   * Supports cancellation via AbortSignal without leaking timer handles.
   */
  async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) return;
    if (signal?.aborted) {
      throw new Error("Sleep aborted");
    }

    return new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;

      const abortHandler = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        reject(new Error("Sleep aborted"));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      timeoutId = setTimeout(() => {
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve();
      }, delayMs);
    });
  }
}
