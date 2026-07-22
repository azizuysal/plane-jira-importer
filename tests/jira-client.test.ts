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

vi.mock('../src/utils/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/helpers.js')>('../src/utils/helpers.js');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: mockGet,
      post: mockPost,
    })),
    isAxiosError: vi.fn(
      (err: unknown) =>
        typeof err === 'object' && err !== null && 'isAxiosError' in err,
    ),
  },
}));

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
    mockGet.mockReset();
    mockPost.mockReset();
    client = createClient();
  });

  // ── listProjects ─────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('returns projects from the API', async () => {
      const projects = [{ id: '1', key: 'PROJ', name: 'My Project' }];
      mockGet.mockResolvedValueOnce({ data: projects });

      const result = await client.listProjects();

      expect(result).toEqual(projects);
      expect(mockGet).toHaveBeenCalledWith('/rest/api/3/project');
    });

    it('throws a descriptive error on 401', async () => {
      mockGet.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 401, data: { message: 'Unauthorized' } },
      });

      await expect(client.listProjects()).rejects.toThrow(
        /Jira API error 401.*listing Jira projects/,
      );
    });

    it('throws on network errors', async () => {
      mockGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));

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

      mockGet
        .mockResolvedValueOnce({ data: { issues: page1, nextPageToken: 'tok-2', isLast: false } })
        .mockResolvedValueOnce({ data: { issues: page2, isLast: true } });

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(101);
      expect(result[0].key).toBe('P-1');
      expect(result[100].key).toBe('P-101');

      // First page must not send a token; second must send the one it got.
      expect(mockGet.mock.calls[0][1].params.nextPageToken).toBeUndefined();
      expect(mockGet.mock.calls[1][1].params.nextPageToken).toBe('tok-2');
    });

    it('handles a single page of results', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          issues: [{ id: '1', key: 'P-1', fields: { summary: 'Only' } }],
          isLast: true,
        },
      });

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('stops when a full page arrives without a token', async () => {
      const page = Array.from({ length: 100 }, (_, i) => ({
        id: String(i + 1),
        key: `P-${i + 1}`,
        fields: { summary: `Issue ${i + 1}` },
      }));

      mockGet.mockResolvedValueOnce({ data: { issues: page } });

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(100);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates issues repeated across overlapping pages', async () => {
      const shared = { id: '1', key: 'P-1', fields: { summary: 'Dup' } };

      mockGet
        .mockResolvedValueOnce({ data: { issues: [shared], nextPageToken: 'tok-2', isLast: false } })
        .mockResolvedValueOnce({
          data: { issues: [shared, { id: '2', key: 'P-2', fields: { summary: 'New' } }], isLast: true },
        });

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.key)).toEqual(['P-1', 'P-2']);
    });

    it('terminates if the API keeps returning the same token', async () => {
      mockGet.mockResolvedValue({
        data: { issues: [{ id: '1', key: 'P-1', fields: { summary: 'Stuck' } }], nextPageToken: 'same' },
      });

      const result = await client.searchIssues('PROJ');

      expect(result).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledTimes(2);
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

      mockGet.mockResolvedValueOnce({ data: issue });

      const result = await client.getIssue('PROJ-1');

      expect(result).toEqual(issue);
      expect(mockGet).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
        params: { expand: 'renderedFields' },
      });
    });
  });

  // ── getComments ──────────────────────────────────────────────────────

  describe('getComments', () => {
    it('fetches all comments for an issue', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          comments: [
            { id: '1', renderedBody: '<p>Comment 1</p>' },
            { id: '2', renderedBody: '<p>Comment 2</p>' },
          ],
          total: 2,
          startAt: 0,
          maxResults: 100,
        },
      });

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
      mockGet.mockResolvedValueOnce({ data: arrayBuf });

      const result = await client.downloadAttachment('https://jira.example.com/file.png');

      expect(result).toBeInstanceOf(Buffer);
      expect(mockGet).toHaveBeenCalledWith('https://jira.example.com/file.png', {
        responseType: 'arraybuffer',
        baseURL: '',
      });
    });
  });
});
