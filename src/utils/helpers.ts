/**
 * General-purpose helper utilities.
 *
 * Pure functions (or near-pure) that don't depend on external APIs.
 */

import chalk from 'chalk';
import type { CliFlags } from '../types/config.js';

// ─── Timing ──────────────────────────────────────────────────────────────────

/** Promise-based sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

/**
 * Parse CLI arguments into a simple flags object.
 *
 * Supports:
 *   `--flag`           → `{ flag: true }`
 *   `--key=value`      → `{ key: 'value' }`
 *   `--key value`      → `{ key: 'value' }`
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): CliFlags {
  const flags: CliFlags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const keyPart = arg.slice(2);

      if (keyPart.includes('=')) {
        const eqIndex = keyPart.indexOf('=');
        const k = keyPart.slice(0, eqIndex);
        const v = keyPart.slice(eqIndex + 1);
        flags[k] = v;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i++;
        flags[keyPart] = argv[i];
      } else {
        flags[keyPart] = true;
      }
    }
  }

  return flags;
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

/**
 * Format a date string to `YYYY-MM-DD`.
 *
 * Returns `null` for falsy, unparseable, or invalid inputs.
 */
export function formatDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;

  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

// ─── String Helpers ──────────────────────────────────────────────────────────

/** Escape plain text before inserting it into HTML. */
export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

/**
 * Truncate `str` to `maxLen` characters, appending `…` when truncated.
 */
export function truncate(str: string | null | undefined, maxLen = 80): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

// ─── Environment Validation ──────────────────────────────────────────────────

/**
 * Check that every key in `required` is present in `process.env`.
 *
 * @returns Array of missing variable names (empty when all are set).
 */
export function validateEnv(required: string[]): string[] {
  return required.filter((key) => !process.env[key]);
}

/** Read an environment variable, throwing if it is missing or empty. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

// ─── Progress Display ────────────────────────────────────────────────────────

/**
 * Build a progress string like `[12/45]` (dimmed via chalk).
 */
export function progress(current: number, total: number): string {
  return chalk.dim(`[${current}/${total}]`);
}

// ─── MIME Type Detection ─────────────────────────────────────────────────────

/** Common MIME type map by file extension. */
const MIME_TYPES: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  md: 'text/markdown',
  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // Media
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/**
 * Detect MIME type from a filename extension.
 *
 * Returns `application/octet-stream` if the extension is unknown.
 */
export function mimeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  return MIME_TYPES[ext ?? ''] ?? 'application/octet-stream';
}

// ─── Size & Duration Formatting ──────────────────────────────────────────────

/**
 * Format a byte count as a human-readable size string.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
