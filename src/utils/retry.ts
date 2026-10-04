/**
 * Shared retry utility with exponential backoff and jitter.
 *
 * Used by both Jira and Plane API clients to handle transient failures
 * and rate limiting (HTTP 429) gracefully.
 */

import { log } from './logger.js';
import { sleep } from './helpers.js';
import { HttpError } from './http.js';

/** Options controlling retry behavior. */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 30000). */
  maxDelayMs?: number;
  /** Context label for log messages (e.g. "listing Jira projects"). */
  context?: string;
}

/**
 * Whether an error is retryable.
 *
 * Retries on: 429 (rate limit), 500, 502, 503, 504, and network errors
 * (errors without an HTTP response).
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    const { status } = err;
    return status === 429 || status >= 500;
  }
  // Network errors (no response) — ECONNREFUSED, ETIMEDOUT, etc.
  return err instanceof Error;
}

/**
 * Extract `Retry-After` header value in milliseconds.
 *
 * Supports integer-seconds format. Returns `null` if the header is
 * missing or unparseable.
 */
export function getRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof HttpError)) return null;
  const value = err.headers.get('Retry-After');
  if (!value) return null;

  const seconds = Number.parseInt(value, 10);
  return Number.isNaN(seconds) ? null : seconds * 1000;
}

/**
 * Calculate delay with exponential backoff and jitter.
 *
 * `delay = min(baseDelay × 2^attempt + random jitter, maxDelay)`
 */
export function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Execute `fn` with automatic retries on transient failures.
 *
 * - Handles HTTP 429 with `Retry-After` header when available
 * - Uses exponential backoff with jitter for server errors
 * - Non-retryable errors (4xx except 429) are thrown immediately
 * - Logs each retry attempt at warn level
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30_000, context = 'API call' } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt || !isRetryable(err)) {
        throw err;
      }

      const retryAfterMs = getRetryAfterMs(err);
      const delay = retryAfterMs ?? calculateDelay(attempt, baseDelayMs, maxDelayMs);

      const statusInfo = err instanceof HttpError ? ` (HTTP ${err.status})` : '';

      log.warn(
        `Retry ${attempt + 1}/${maxRetries} for ${context}${statusInfo} — waiting ${Math.round(delay / 1000)}s`,
      );

      await sleep(delay);
    }
  }

  // Unreachable — the loop always returns or throws — but TypeScript needs it.
  throw new Error(`withRetry: exhausted ${maxRetries} retries for ${context}`);
}
