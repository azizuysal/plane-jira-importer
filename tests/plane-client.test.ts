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

// sleep is used by both RateLimiter and the retry utility
vi.mock('../src/utils/helpers.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// retry utility uses sleep + log internally (both already mocked above)

const mockFetch = vi.fn<typeof fetch>();

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

import { PlaneClient } from '../src/clients/plane.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PlaneClient', () => {
  let client: PlaneClient;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);

    client = new PlaneClient({
      host: 'https://plane.test.com',
      apiKey: 'test-api-key',
      workspaceSlug: 'test-ws',
      rateLimiter: { wait: vi.fn().mockResolvedValue(undefined) },
      maxRetries: 0, // No retries in unit tests for predictable behavior
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  // ── listProjects ─────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('handles a flat array response', async () => {
      const projects = [{ id: '1', identifier: 'PROJ', name: 'Project' }];
      mockFetch.mockResolvedValueOnce(response(projects));

      const result = await client.listProjects();

      expect(result).toEqual(projects);
    });

    it('handles paginated responses', async () => {
      mockFetch
        .mockResolvedValueOnce(
          response({
            results: [{ id: '1', identifier: 'P1', name: 'P1' }],
            next_cursor: 'cursor-abc',
            next_page_results: true,
          }),
        )
        .mockResolvedValueOnce(
          response({
            results: [{ id: '2', identifier: 'P2', name: 'P2' }],
          }),
        );

      const result = await client.listProjects();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('2');
    });
  });

  // ── listStates ───────────────────────────────────────────────────────

  describe('listStates', () => {
    it('returns states for a project', async () => {
      const states = [{ id: 's1', name: 'Todo', group: 'unstarted' }];
      mockFetch.mockResolvedValueOnce(response(states));

      const result = await client.listStates('proj-1');

      expect(result).toEqual(states);
    });
  });

  // ── listLabels ───────────────────────────────────────────────────────

  describe('listLabels', () => {
    it('returns labels for a project', async () => {
      const labels = [{ id: 'l1', name: 'Bug', color: '#ff0000' }];
      mockFetch.mockResolvedValueOnce(response(labels));

      const result = await client.listLabels('proj-1');

      expect(result).toEqual(labels);
    });
  });

  // ── createLabel ──────────────────────────────────────────────────────

  describe('createLabel', () => {
    it('creates a new label', async () => {
      const label = { id: 'l1', name: 'Jira: Bug' };
      mockFetch.mockResolvedValueOnce(response(label));

      const result = await client.createLabel('proj-1', 'Jira: Bug');

      expect(result).toEqual(label);
    });

    it('returns existing label on 409 conflict', async () => {
      mockFetch.mockResolvedValueOnce(response({}, 409));

      // listLabels call triggered by the 409 handler
      const existing = [
        { id: 'l1', name: 'Jira: Bug' },
        { id: 'l2', name: 'Jira: Story' },
      ];
      mockFetch.mockResolvedValueOnce(response(existing));

      const result = await client.createLabel('proj-1', 'Jira: Bug');

      expect(result).toEqual({ id: 'l1', name: 'Jira: Bug' });
    });
  });

  // ── listMembers ──────────────────────────────────────────────────────

  describe('listMembers', () => {
    it('returns workspace members', async () => {
      const members = [{ id: 'm1', email: 'alice@example.com', display_name: 'Alice', role: 20 }];
      mockFetch.mockResolvedValueOnce(response(members));

      const result = await client.listMembers();

      expect(result).toEqual(members);
    });
  });

  // ── listWorkItems ────────────────────────────────────────────────────

  describe('listWorkItems', () => {
    it('handles a flat array response', async () => {
      const items = [{ id: 'wi1', name: 'Item 1' }];
      mockFetch.mockResolvedValueOnce(response(items));

      const result = await client.listWorkItems('proj-1');

      expect(result).toEqual(items);
    });

    it('handles paginated work items', async () => {
      mockFetch
        .mockResolvedValueOnce(
          response({
            results: [{ id: 'wi1', name: 'First' }],
            next_cursor: 'c1',
            next_page_results: true,
          }),
        )
        .mockResolvedValueOnce(
          response({
            results: [{ id: 'wi2', name: 'Second' }],
          }),
        );

      const result = await client.listWorkItems('proj-1');

      expect(result).toHaveLength(2);
    });
  });

  // ── createWorkItem ───────────────────────────────────────────────────

  describe('createWorkItem', () => {
    it('creates a work item with full payload', async () => {
      const item = { id: 'wi1', name: 'New Issue' };
      mockFetch.mockResolvedValueOnce(response(item));

      const result = await client.createWorkItem('proj-1', {
        name: 'New Issue',
        description_html: '<p>Description</p>',
        priority: 'medium',
        external_id: 'PROJ-1',
        external_source: 'jira-importer',
      });

      expect(result).toEqual(item);
    });
  });

  // ── addComment ───────────────────────────────────────────────────────

  describe('addComment', () => {
    it('adds a comment to a work item', async () => {
      const comment = { id: 'c1', comment_html: '<p>Test comment</p>' };
      mockFetch.mockResolvedValueOnce(response(comment));

      const result = await client.addComment('proj-1', 'wi-1', {
        comment_html: '<p>Test comment</p>',
        external_source: 'jira-importer',
        external_id: 'PROJ-1-comment-100',
      });

      expect(result).toEqual(comment);
    });
  });

  // ── updateWorkItem ────────────────────────────────────────────────────

  describe('updateWorkItem', () => {
    it('updates a work item with partial payload', async () => {
      const updated = { id: 'wi-1', name: 'Updated Issue' };
      mockFetch.mockResolvedValueOnce(response(updated));

      const result = await client.updateWorkItem('proj-1', 'wi-1', {
        name: 'Updated Issue',
      });

      expect(result).toEqual(updated);
      expect(String(mockFetch.mock.calls[0][0])).toBe(
        'https://plane.test.com/api/v1/workspaces/test-ws/projects/proj-1/work-items/wi-1/',
      );
      expect(mockFetch.mock.calls[0][1]?.method).toBe('PATCH');
      expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
        name: 'Updated Issue',
      });
    });
  });

  // ── deleteWorkItem ────────────────────────────────────────────────────

  describe('deleteWorkItem', () => {
    it('deletes a work item', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.deleteWorkItem('proj-1', 'wi-1');

      expect(String(mockFetch.mock.calls[0][0])).toBe(
        'https://plane.test.com/api/v1/workspaces/test-ws/projects/proj-1/work-items/wi-1/',
      );
      expect(mockFetch.mock.calls[0][1]?.method).toBe('DELETE');
    });

    it('throws on API errors', async () => {
      mockFetch.mockResolvedValueOnce(response('Not found', 404));

      await expect(client.deleteWorkItem('proj-1', 'wi-1')).rejects.toThrow(
        /Plane API error 404.*deleting work item/,
      );
    });
  });

  // ── Error Handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('wraps API errors with status and context', async () => {
      mockFetch.mockResolvedValueOnce(response('Internal Server Error', 500));

      await expect(client.listStates('proj-1')).rejects.toThrow(
        /Plane API error 500.*listing Plane states/,
      );
    });

    it('wraps network errors with context', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.listStates('proj-1')).rejects.toThrow(
        /Network error.*listing Plane states/,
      );
    });
  });
});
