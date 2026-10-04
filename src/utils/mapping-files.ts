import { readFile } from 'node:fs/promises';
import type { StateMappingFile, UsersFile, UserFileEntry } from '../types/config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(path: string | boolean, flag: string): Promise<unknown> {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`--${flag} requires a file path`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'could not read file';
    throw new Error(`--${flag}: ${reason} (${path})`, { cause: error });
  }
}

export async function loadUsersFile(
  path: string | boolean | undefined,
): Promise<UsersFile | undefined> {
  if (path === undefined) return undefined;
  const data = await readJson(path, 'users-file');
  if (!isRecord(data)) {
    throw new Error('--users-file must contain an object keyed by Jira account ID');
  }
  const entries: Array<[string, UserFileEntry]> = [];
  for (const [accountId, entry] of Object.entries(data)) {
    if (
      !accountId.trim() ||
      !isRecord(entry) ||
      !(entry.email === null || (typeof entry.email === 'string' && entry.email.trim())) ||
      !(entry.display_name === undefined || typeof entry.display_name === 'string')
    ) {
      throw new Error(
        '--users-file entries require an email string or null and optional display_name',
      );
    }
    entries.push([
      accountId,
      {
        email: typeof entry.email === 'string' ? entry.email.trim() : null,
        display_name: entry.display_name,
      },
    ]);
  }
  return Object.fromEntries(entries);
}

export async function loadStateMappingFile(
  path: string | boolean | undefined,
): Promise<StateMappingFile | undefined> {
  if (path === undefined) return undefined;
  const data = await readJson(path, 'state-mapping-file');
  if (!isRecord(data) || !isRecord(data.mapping)) {
    throw new Error('--state-mapping-file must contain a mapping object');
  }
  const entries: Array<[string, string | null]> = [];
  for (const [status, target] of Object.entries(data.mapping)) {
    if (!status.trim() || !(target === null || (typeof target === 'string' && target.trim()))) {
      throw new Error('--state-mapping-file targets must be Plane state names, IDs, or null');
    }
    entries.push([status, typeof target === 'string' ? target.trim() : null]);
  }
  return { mapping: Object.fromEntries(entries) };
}
