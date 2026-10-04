import { describe, it, expect, vi, afterEach } from 'vitest';
import inquirer from 'inquirer';
import {
  mapPriority,
  buildStatusMap,
  buildUserMap,
  extractStatuses,
  extractUsers,
  extractIssueTypes,
} from '../src/services/mapper.js';
import type { JiraIssue } from '../src/types/jira.js';
import { log } from '../src/utils/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('file mappings', () => {
  const states = [
    { id: 's1', name: 'Todo', group: 'unstarted' },
    { id: 's2', name: 'Done', group: 'completed' },
  ];

  it('resolves state names without regard to case and exact state IDs without prompting', async () => {
    const prompt = vi.spyOn(inquirer, 'prompt');
    expect(
      await buildStatusMap(['Open', 'Closed'], states, {
        mapping: { Open: 'TODO', Closed: 's2' },
      }),
    ).toEqual({ Open: 's1', Closed: 's2' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([{}, { Open: null }, { Open: 'missing' }])(
    'rejects unresolved states: %j',
    async (mapping) => {
      await expect(buildStatusMap(['Open'], states, { mapping })).rejects.toThrow(
        /Missing|unknown/,
      );
    },
  );

  it('requires an ID when state names are ambiguous', async () => {
    const duplicates = [...states, { id: 's3', name: 'TODO', group: 'backlog' }];
    await expect(
      buildStatusMap(['Open'], duplicates, { mapping: { Open: 'Todo' } }),
    ).rejects.toThrow('ambiguous; use a state ID');
    expect(await buildStatusMap(['Open'], duplicates, { mapping: { Open: 's3' } })).toEqual({
      Open: 's3',
    });
  });

  it('matches hidden Jira emails through the file and leaves missing users unmapped', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const prompt = vi.spyOn(inquirer, 'prompt');
    const users = ['alice', 'former', 'missing', 'unknown'].map((accountId) => ({
      accountId,
      displayName: accountId,
    }));
    expect(
      await buildUserMap(users, [{ id: 'm1', email: 'Alice@Example.com' }], {
        alice: { email: ' alice@example.com ' },
        former: { email: null },
        unknown: { email: 'absent@example.com' },
      }),
    ).toEqual({ alice: 'm1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 Jira users'));
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rejects ambiguous member emails', async () => {
    await expect(
      buildUserMap(
        [{ accountId: 'a', displayName: 'Alice' }],
        [
          { id: 'm1', email: 'alice@example.com' },
          { id: 'm2', email: 'ALICE@example.com' },
        ],
        { a: { email: 'alice@example.com' } },
      ),
    ).rejects.toThrow('multiple Plane members');
  });

  it('retains interactive status and user selection without files', async () => {
    vi.spyOn(log, 'dim').mockImplementation(() => {});
    const prompt = vi
      .spyOn(inquirer, 'prompt')
      .mockResolvedValueOnce({ stateId: 's2' })
      .mockResolvedValueOnce({ selectedMemberId: 'm1' });
    expect(await buildStatusMap(['Open'], states)).toEqual({ Open: 's2' });
    expect(await buildUserMap([{ accountId: 'a', displayName: 'Alice' }], [{ id: 'm1' }])).toEqual({
      a: 'm1',
    });
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Create a minimal JiraIssue for testing. */
function mockIssue(overrides: Partial<JiraIssue['fields']> = {}): JiraIssue {
  return {
    id: '1',
    key: 'TEST-1',
    fields: {
      summary: 'Test issue',
      ...overrides,
    },
  };
}

// ─── mapPriority ─────────────────────────────────────────────────────────────

describe('mapPriority', () => {
  it('maps "Highest" to "urgent"', () => {
    expect(mapPriority('Highest')).toBe('urgent');
  });

  it('maps "High" to "high"', () => {
    expect(mapPriority('High')).toBe('high');
  });

  it('maps "Medium" to "medium"', () => {
    expect(mapPriority('Medium')).toBe('medium');
  });

  it('maps "Low" to "low"', () => {
    expect(mapPriority('Low')).toBe('low');
  });

  it('maps "Lowest" to "low"', () => {
    expect(mapPriority('Lowest')).toBe('low');
  });

  it('maps null to "none"', () => {
    expect(mapPriority(null)).toBe('none');
  });

  it('maps unknown priority to "none"', () => {
    expect(mapPriority('Critical')).toBe('none');
  });

  it('maps empty string to "none"', () => {
    expect(mapPriority('')).toBe('none');
  });

  it('is case-insensitive', () => {
    expect(mapPriority('highest')).toBe('urgent');
    expect(mapPriority('HIGH')).toBe('high');
    expect(mapPriority('medium')).toBe('medium');
    expect(mapPriority('low')).toBe('low');
  });
});

// ─── extractStatuses ─────────────────────────────────────────────────────────

describe('extractStatuses', () => {
  it('extracts unique status names', () => {
    const issues = [
      mockIssue({ status: { id: '1', name: 'To Do' } }),
      mockIssue({ status: { id: '2', name: 'In Progress' } }),
      mockIssue({ status: { id: '1', name: 'To Do' } }),
    ];

    const result = extractStatuses(issues);
    expect(result).toEqual(['To Do', 'In Progress']);
  });

  it('skips issues without a status', () => {
    const issues = [mockIssue({})];
    expect(extractStatuses(issues)).toEqual([]);
  });

  it('returns empty array for no issues', () => {
    expect(extractStatuses([])).toEqual([]);
  });
});

// ─── extractUsers ────────────────────────────────────────────────────────────

describe('extractUsers', () => {
  it('extracts unique users from assignees', () => {
    const issues = [
      mockIssue({
        assignee: { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com' },
      }),
      mockIssue({
        assignee: { accountId: 'a2', displayName: 'Bob', emailAddress: 'bob@example.com' },
      }),
      mockIssue({
        assignee: { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com' },
      }),
    ];

    const result = extractUsers(issues);
    expect(result).toHaveLength(2);
    expect(result[0].accountId).toBe('a1');
    expect(result[1].accountId).toBe('a2');
  });

  it('extracts users from reporter and creator fields', () => {
    const issues = [
      mockIssue({
        assignee: { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com' },
        reporter: { accountId: 'a2', displayName: 'Bob', emailAddress: 'bob@example.com' },
      }),
      mockIssue({
        creator: { accountId: 'a3', displayName: 'Carol', emailAddress: 'carol@example.com' },
      }),
    ];

    const result = extractUsers(issues);
    expect(result).toHaveLength(3);
  });

  it('deduplicates across assignee, reporter, and creator', () => {
    const issues = [
      mockIssue({
        assignee: { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com' },
        reporter: { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com' },
        creator: { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com' },
      }),
    ];

    const result = extractUsers(issues);
    expect(result).toHaveLength(1);
  });

  it('skips issues without any users', () => {
    const issues = [mockIssue({})];
    expect(extractUsers(issues)).toEqual([]);
  });

  it('returns empty array for no issues', () => {
    expect(extractUsers([])).toEqual([]);
  });
});

// ─── extractIssueTypes ───────────────────────────────────────────────────────

describe('extractIssueTypes', () => {
  it('extracts unique issue type names', () => {
    const issues = [
      mockIssue({ issuetype: { id: '1', name: 'Bug', subtask: false } }),
      mockIssue({ issuetype: { id: '2', name: 'Story', subtask: false } }),
      mockIssue({ issuetype: { id: '1', name: 'Bug', subtask: false } }),
    ];

    const result = extractIssueTypes(issues);
    expect(result).toEqual(['Bug', 'Story']);
  });

  it('skips issues without an issue type', () => {
    const issues = [mockIssue({})];
    expect(extractIssueTypes(issues)).toEqual([]);
  });

  it('returns empty array for no issues', () => {
    expect(extractIssueTypes([])).toEqual([]);
  });

  it('includes sub-task types', () => {
    const issues = [
      mockIssue({ issuetype: { id: '1', name: 'Sub-task', subtask: true } }),
      mockIssue({ issuetype: { id: '2', name: 'Task', subtask: false } }),
    ];

    const result = extractIssueTypes(issues);
    expect(result).toEqual(['Sub-task', 'Task']);
  });
});
