import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../src/utils/helpers.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/utils/helpers.js')>('../src/utils/helpers.js');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

const mockFetch = vi.fn<typeof fetch>();

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

import { JiraClient } from '../src/clients/jira.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

function createClient() {
  return new JiraClient({
    host: 'test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
    rateLimiter: { wait: vi.fn().mockResolvedValue(undefined) },
    maxRetries: 0, // No retries in unit tests for predictable behavior
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('JiraClient', () => {
  let client: JiraClient;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    client = createClient();
  });

  afterEach(() => vi.unstubAllGlobals());

  // ── listProjects ─────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('returns projects from the API', async () => {
      const projects = [{ id: '1', key: 'PROJ', name: 'My Project' }];
      mockFetch.mockResolvedValueOnce(response(projects));

      const result = await client.listProjects();

      expect(result).toEqual(projects);
      expect(String(mockFetch.mock.calls[0][0])).toBe(
        'https://test.atlassian.net/rest/api/3/project',
      );
      expect(new Headers(mockFetch.mock.calls[0][1]?.headers).get('Authorization')).toBe(
        `Basic ${Buffer.from('test@example.com:test-token').toString('base64')}`,
      );
    });

    it('throws a descriptive error on 401', async () => {
      mockFetch.mockResolvedValueOnce(response({ message: 'Unauthorized' }, 401));

      await expect(client.listProjects()).rejects.toThrow(
        /Jira API error 401.*listing Jira projects/,
      );
    });

    it('throws on network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.listProjects()).rejects.toThrow(/Network error.*listing Jira projects/);
    });
  });

  // ── searchIssues ─────────────────────────────────────────────────────

  describe('searchIssues', () => {
    it('follows nextPageToken across multiple pages', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: String(i + 1),
        key: `P-${i + 1}`,
        fields: { summary: `Issue ${i + 1}` },
      }));
      const page2 = [{ id: '101', key: 'P-101', fields: { summary: 'Last' } }];

      mockFetch
        .mockResolvedValueOnce(response({ issues: page1, nextPageToken: 'tok-2', isLast: false }))
        .mockResolvedValueOnce(response({ issues: page2, isLast: true }));

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(101);
      expect(result[0].key).toBe('P-1');
      expect(result[100].key).toBe('P-101');

      // First page must not send a token; second must send the one it got.
      expect(
        new URL(String(mockFetch.mock.calls[0][0])).searchParams.get('nextPageToken'),
      ).toBeNull();
      expect(new URL(String(mockFetch.mock.calls[1][0])).searchParams.get('nextPageToken')).toBe(
        'tok-2',
      );
      expect(new URL(String(mockFetch.mock.calls[0][0])).searchParams.get('startAt')).toBeNull();
      expect(new URL(String(mockFetch.mock.calls[1][0])).searchParams.get('startAt')).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('handles a single page of results', async () => {
      mockFetch.mockResolvedValueOnce(
        response({
          issues: [{ id: '1', key: 'P-1', fields: { summary: 'Only' } }],
          isLast: true,
        }),
      );

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('stops after exactly 100 issues when the API marks the page as last', async () => {
      const page = Array.from({ length: 100 }, (_, i) => ({
        id: String(i + 1),
        key: `P-${i + 1}`,
        fields: { summary: `Issue ${i + 1}` },
      }));

      mockFetch.mockResolvedValueOnce(response({ issues: page, isLast: true }));

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(100);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns an empty project when the API marks the page as last', async () => {
      mockFetch.mockResolvedValueOnce(response({ issues: [], isLast: true }));

      await expect(client.searchIssues('PROJ')).resolves.toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, ''])(
      'rejects incomplete results when the next token is %s',
      async (nextPageToken) => {
        mockFetch
          .mockResolvedValueOnce(
            response({
              issues: [{ id: '1', key: 'P-1', fields: { summary: 'First' } }],
              nextPageToken: 'tok-2',
              isLast: false,
            }),
          )
          .mockResolvedValueOnce(
            response({
              issues: [{ id: '2', key: 'P-2', fields: { summary: 'Second' } }],
              nextPageToken,
              isLast: false,
            }),
          );

        await expect(client.searchIssues('PROJ')).rejects.toThrow(
          /Jira pagination error.*PROJ.*page 2.*missing nextPageToken/,
        );
        expect(mockFetch).toHaveBeenCalledTimes(2);
      },
    );

    it('rejects results without a completion marker or next token', async () => {
      mockFetch.mockResolvedValueOnce(
        response({ issues: [{ id: '1', key: 'P-1', fields: { summary: 'Incomplete' } }] }),
      );

      await expect(client.searchIssues('PROJ')).rejects.toThrow(
        /Jira pagination error.*PROJ.*page 1.*missing nextPageToken/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates issues repeated across overlapping pages', async () => {
      const shared = { id: '1', key: 'P-1', fields: { summary: 'Dup' } };

      mockFetch
        .mockResolvedValueOnce(
          response({ issues: [shared], nextPageToken: 'tok-2', isLast: false }),
        )
        .mockResolvedValueOnce(
          response({
            issues: [shared, { id: '2', key: 'P-2', fields: { summary: 'New' } }],
            isLast: true,
          }),
        );

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.key)).toEqual(['P-1', 'P-2']);
    });

    it('rejects incomplete results if the API keeps returning the same token', async () => {
      mockFetch.mockImplementation(async () =>
        response({
          issues: [{ id: '1', key: 'P-1', fields: { summary: 'Stuck' } }],
          nextPageToken: 'same',
          isLast: false,
        }),
      );

      await expect(client.searchIssues('PROJ')).rejects.toThrow(
        /Jira pagination error.*PROJ.*page 2.*repeated nextPageToken/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('rejects incomplete results if the API cycles through previously seen tokens', async () => {
      mockFetch
        .mockResolvedValueOnce(response({ issues: [], nextPageToken: 'tok-2', isLast: false }))
        .mockResolvedValueOnce(response({ issues: [], nextPageToken: 'tok-3', isLast: false }))
        .mockResolvedValueOnce(response({ issues: [], nextPageToken: 'tok-2', isLast: false }));

      await expect(client.searchIssues('PROJ')).rejects.toThrow(
        /Jira pagination error.*PROJ.*page 3.*repeated nextPageToken/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // ── getIssue ─────────────────────────────────────────────────────────

  describe('getIssue', () => {
    it('fetches an issue with rendered fields', async () => {
      const issue = {
        id: '1',
        key: 'PROJ-1',
        fields: { summary: 'Test' },
        renderedFields: { description: '<p>HTML</p>' },
      };

      mockFetch.mockResolvedValueOnce(response(issue));

      const result = await client.getIssue('PROJ-1');

      expect(result).toEqual(issue);
      const url = new URL(String(mockFetch.mock.calls[0][0]));
      expect(url.pathname).toBe('/rest/api/3/issue/PROJ-1');
      expect(url.searchParams.get('expand')).toBe('renderedFields');
    });
  });

  // ── getComments ──────────────────────────────────────────────────────

  describe('getComments', () => {
    it('fetches all comments for an issue', async () => {
      mockFetch.mockResolvedValueOnce(
        response({
          comments: [
            { id: '1', renderedBody: '<p>Comment 1</p>' },
            { id: '2', renderedBody: '<p>Comment 2</p>' },
          ],
          total: 2,
          startAt: 0,
          maxResults: 100,
        }),
      );

      const result = await client.getComments('PROJ-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1');
    });
  });

  // ── getAttachments ───────────────────────────────────────────────────

  describe('getAttachments', () => {
    it('normalises raw attachment data', () => {
      const fields = {
        summary: 'Test',
        attachment: [
          {
            id: 'att-1',
            filename: 'screenshot.png',
            mimeType: 'image/png',
            size: 2048,
            content: 'https://jira.example.com/attachments/screenshot.png',
            author: { accountId: 'a1', displayName: 'Alice' },
            created: '2024-03-01T12:00:00Z',
          },
        ],
      };

      const result = client.getAttachments(fields);

      expect(result).toEqual([
        {
          id: 'att-1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          size: 2048,
          contentUrl: 'https://jira.example.com/attachments/screenshot.png',
          author: 'Alice',
          created: '2024-03-01T12:00:00Z',
        },
      ]);
    });

    it('returns empty array when no attachments exist', () => {
      expect(client.getAttachments({ summary: 'Test' })).toEqual([]);
    });

    it('defaults mimeType to application/octet-stream', () => {
      const fields = {
        summary: 'Test',
        attachment: [
          {
            id: 'att-1',
            filename: 'file.bin',
            size: 100,
            content: 'https://jira.example.com/file.bin',
            created: '2024-01-01',
          },
        ],
      };

      const result = client.getAttachments(fields);
      expect(result[0].mimeType).toBe('application/octet-stream');
    });
  });

  // ── downloadAttachment ───────────────────────────────────────────────

  describe('downloadAttachment', () => {
    it('downloads attachment content as a Buffer', async () => {
      const arrayBuf = new ArrayBuffer(8);
      mockFetch.mockResolvedValueOnce(new Response(arrayBuf));

      const result = await client.downloadAttachment('https://test.atlassian.net/file.png');

      expect(result).toBeInstanceOf(Buffer);
      expect(result).toEqual(Buffer.from(arrayBuf));
      expect(String(mockFetch.mock.calls[0][0])).toBe('https://test.atlassian.net/file.png');
      expect(new Headers(mockFetch.mock.calls[0][1]?.headers).get('Authorization')).toMatch(
        /^Basic /,
      );
    });

    it('does not send Jira credentials to signed storage URLs', async () => {
      mockFetch.mockResolvedValueOnce(new Response('attachment'));

      await client.downloadAttachment('https://storage.example.com/file.png?signature=test');

      expect(new Headers(mockFetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    });
  });
});
