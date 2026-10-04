import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadUsersFile, loadStateMappingFile } from '../src/utils/mapping-files.js';

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jira-mappings-'));
  path = join(directory, 'mapping.json');
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('mapping files', () => {
  it('loads account IDs and trimmed emails while accepting contributor metadata', async () => {
    await writeFile(
      path,
      JSON.stringify({
        alice: {
          email: ' alice@example.com ',
          display_name: 'Alice',
          current: false,
          _seen_in: ['TEST'],
        },
        former: { email: null },
      }),
    );
    expect(await loadUsersFile(path)).toEqual({
      alice: { email: 'alice@example.com', display_name: 'Alice' },
      former: { email: null },
    });
  });

  it('loads state names, IDs, and unfilled template entries', async () => {
    await writeFile(
      path,
      JSON.stringify({ mapping: { Open: ' Todo ', Closed: 'state-id', Draft: null } }),
    );
    expect(await loadStateMappingFile(path)).toEqual({
      mapping: { Open: 'Todo', Closed: 'state-id', Draft: null },
    });
  });

  it('keeps interactive mapping available when no file is supplied', async () => {
    expect(await loadUsersFile(undefined)).toBeUndefined();
    expect(await loadStateMappingFile(undefined)).toBeUndefined();
  });

  it.each([true, false, ''])('rejects a missing path: %s', async (value) => {
    await expect(loadUsersFile(value)).rejects.toThrow('--users-file requires a file path');
    await expect(loadStateMappingFile(value)).rejects.toThrow(
      '--state-mapping-file requires a file path',
    );
  });

  it('reports unreadable files and malformed JSON without printing their contents', async () => {
    await expect(loadUsersFile(path)).rejects.toThrow('could not read file');
    await writeFile(path, '{"private-email":');
    await expect(loadUsersFile(path)).rejects.toThrow('invalid JSON');
    await expect(loadUsersFile(path)).rejects.not.toThrow('private-email');
  });

  it.each([
    [],
    null,
    { alice: {} },
    { alice: { email: true } },
    { alice: { email: '' } },
    { alice: { email: null, display_name: 42 } },
  ])('rejects invalid user entries: %j', async (data) => {
    await writeFile(path, JSON.stringify(data));
    await expect(loadUsersFile(path)).rejects.toThrow('--users-file');
  });

  it.each([[], {}, { mapping: [] }, { mapping: { Open: 42 } }, { mapping: { Open: '' } }])(
    'rejects invalid state entries: %j',
    async (data) => {
      await writeFile(path, JSON.stringify(data));
      await expect(loadStateMappingFile(path)).rejects.toThrow('--state-mapping-file');
    },
  );
});
