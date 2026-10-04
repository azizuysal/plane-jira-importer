import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    heading: vi.fn(),
    item: vi.fn(),
  },
}));

vi.mock('../src/utils/helpers.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { HttpError } from '../src/utils/http.js';
import { log } from '../src/utils/logger.js';
import { sleep } from '../src/utils/helpers.js';
import { withRetry, isRetryable, getRetryAfterMs, calculateDelay } from '../src/utils/retry.js';

const mockLog = vi.mocked(log);
const mockSleep = vi.mocked(sleep);

// ─── isRetryable ─────────────────────────────────────────────────────────────

describe('isRetryable', () => {
  it('returns true for HTTP 429', () => {
    expect(isRetryable(new HttpError(429, new Headers(), ''))).toBe(true);
  });

  it('returns true for HTTP 500', () => {
    expect(isRetryable(new HttpError(500, new Headers(), ''))).toBe(true);
  });

  it('returns true for HTTP 502', () => {
    expect(isRetryable(new HttpError(502, new Headers(), ''))).toBe(true);
  });

  it('returns true for HTTP 503', () => {
    expect(isRetryable(new HttpError(503, new Headers(), ''))).toBe(true);
  });

  it('returns false for HTTP 400', () => {
    expect(isRetryable(new HttpError(400, new Headers(), ''))).toBe(false);
  });

  it('returns false for HTTP 401', () => {
    expect(isRetryable(new HttpError(401, new Headers(), ''))).toBe(false);
  });

  it('returns false for HTTP 404', () => {
    expect(isRetryable(new HttpError(404, new Headers(), ''))).toBe(false);
  });

  it('returns true for network errors (Error without response)', () => {
    expect(isRetryable(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns false for non-Error, non-HTTP values', () => {
    expect(isRetryable('string error')).toBe(false);
    expect(isRetryable(42)).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

// ─── getRetryAfterMs ─────────────────────────────────────────────────────────

describe('getRetryAfterMs', () => {
  it('extracts Retry-After header in seconds → milliseconds', () => {
    const err = new HttpError(429, new Headers({ 'retry-after': '5' }), '');
    expect(getRetryAfterMs(err)).toBe(5000);
  });

  it('returns null when no Retry-After header', () => {
    const err = new HttpError(429, new Headers({}), '');
    expect(getRetryAfterMs(err)).toBeNull();
  });

  it('returns null for an empty response header set', () => {
    const err = new HttpError(429, new Headers(), '');
    expect(getRetryAfterMs(err)).toBeNull();
  });

  it('returns null for non-numeric Retry-After', () => {
    const err = new HttpError(429, new Headers({ 'retry-after': 'not-a-number' }), '');
    expect(getRetryAfterMs(err)).toBeNull();
  });

  it('returns null for non-HTTP errors', () => {
    expect(getRetryAfterMs(new Error('network'))).toBeNull();
  });

  it('handles mixed-case header names', () => {
    const err = new HttpError(429, new Headers({ 'Retry-After': '10' }), '');
    expect(getRetryAfterMs(err)).toBe(10000);
  });
});

// ─── calculateDelay ──────────────────────────────────────────────────────────

describe('calculateDelay', () => {
  it('returns exponential delay for attempt 0', () => {
    // base * 2^0 = 1000, plus jitter [0, 1000)
    const delay = calculateDelay(0, 1000, 30000);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
  });

  it('returns exponential delay for attempt 1', () => {
    // base * 2^1 = 2000, plus jitter [0, 1000)
    const delay = calculateDelay(1, 1000, 30000);
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThan(3000);
  });

  it('caps at maxDelayMs', () => {
    // base * 2^10 = 1024000 → capped at 30000
    const delay = calculateDelay(10, 1000, 30000);
    expect(delay).toBeLessThanOrEqual(30000);
  });
});

// ─── withRetry ───────────────────────────────────────────────────────────────

describe('withRetry', () => {
  beforeEach(() => {
    mockSleep.mockClear();
    mockLog.warn.mockClear();
  });

  it('returns result on first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn, { maxRetries: 3 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, new Headers(), ''))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-retryable error', async () => {
    const err = new HttpError(404, new Headers(), '');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('throws after exhausting all retries', async () => {
    const err = new HttpError(500, new Headers(), '');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it('uses Retry-After header when available', async () => {
    const err = new HttpError(429, new Headers({ 'retry-after': '3' }), '');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3 });

    expect(mockSleep).toHaveBeenCalledWith(3000);
  });

  it('logs retry attempts with context', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(502, new Headers(), ''))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, context: 'fetching data' });

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn.mock.calls[0][0]).toContain('fetching data');
    expect(mockLog.warn.mock.calls[0][0]).toContain('HTTP 502');
  });

  it('retries network errors (no response)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('defaults maxRetries to 3', async () => {
    const err = new HttpError(500, new Headers(), '');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});
