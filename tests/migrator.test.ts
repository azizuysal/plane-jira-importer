import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import inquirer from 'inquirer';
import { JiraClient } from '../src/clients/jira.js';
import { PlaneClient } from '../src/clients/plane.js';
import { runMigration, type MigrationOptions } from '../src/services/migrator.js';
import type { JiraIssue } from '../src/types/jira.js';
import type {
  CreateWorkItemPayload,
  CreateCommentPayload,
  PlaneWorkItem,
} from '../src/types/plane.js';
import { log } from '../src/utils/logger.js';

let issues: JiraIssue[];
let existing: PlaneWorkItem[];
let writes: Array<{
  method: string;
  path: string;
  body: CreateWorkItemPayload | CreateCommentPayload;
}>;
let options: MigrationOptions;

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  for (const method of Object.keys(log) as Array<keyof typeof log>) {
    vi.spyOn(log, method).mockImplementation(() => {});
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  issues = [
    {
      id: '1',
      key: 'TEST-1',
      fields: {
        summary: 'Issue',
        status: { id: 'open', name: 'Open' },
        assignee: { accountId: 'a', displayName: 'Alice', emailAddress: 'source@example.com' },
        reporter: {
          accountId: 'r',
          displayName: '<Reporter> & "Team"',
          emailAddress: "r'@example.com",
        },
      },
      renderedFields: { description: '<p><em>Original description</em></p>' },
    },
  ];
  existing = [];
  writes = [];
  const rateLimiter = { wait: async () => {} };
  options = {
    jira: new JiraClient({
      host: 'jira.example.com',
      email: 'fixture@example.com',
      apiToken: 'fixture',
      rateLimiter,
      maxRetries: 0,
    }),
    plane: new PlaneClient({
      host: 'https://plane.example.com',
      apiKey: 'fixture',
      workspaceSlug: 'test',
      rateLimiter,
      maxRetries: 0,
    }),
    projectKey: 'TEST',
    planeProjectId: 'project',
    dryRun: false,
    reimport: false,
    config: { maxRetries: 0, maxAttachmentSizeMb: 10 },
    stateMappingFile: { mapping: { Open: 'Todo' } },
    usersFile: { a: { email: 'destination@example.com' }, r: { email: null } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        writes.push({ method, path, body: JSON.parse(String(init?.body)) });
        return response({ id: 'work-item' });
      }
      if (url.hostname === 'jira.example.com') {
        if (path.endsWith('/search/jql')) return response({ issues, isLast: true });
        if (path.endsWith('/comment'))
          return response({
            total: 1,
            comments: [
              {
                id: 'c1',
                author: { displayName: '<Author> & "Name"' },
                created: 'date <tag>',
                renderedBody: '<p><strong>Comment body</strong></p>',
              },
            ],
          });
        const issue = issues.find((item) => path.endsWith(`/issue/${item.key}`));
        if (issue) return response(issue);
      } else {
        if (path.endsWith('/states/'))
          return response([{ id: 's1', name: 'Todo', group: 'unstarted' }]);
        if (path.endsWith('/project-members/'))
          return response([{ id: 'm1', email: 'destination@example.com' }]);
        if (path.endsWith('/work-items/')) return response(existing);
        if (path.endsWith('/labels/')) return response([]);
        if (path.endsWith('/comments/'))
          return response([{ external_source: 'jira-importer', external_id: 'TEST-1-comment-c1' }]);
        if (path.endsWith('/attachments/')) return response([]);
      }
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('migration with file mappings', () => {
  it('creates a mapped issue and preserves escaped reporter and comment attribution', async () => {
    const prompt = vi.spyOn(inquirer, 'prompt');
    await runMigration(options);
    expect(writes).toHaveLength(2);
    const payload = writes[0].body as CreateWorkItemPayload;
    expect(payload.state).toBe('s1');
    expect(payload.assignees).toEqual(['m1']);
    expect(payload.description_html).toContain(
      'Original Jira reporter:</strong> &lt;Reporter&gt; &amp; &quot;Team&quot; (r&#39;@example.com)',
    );
    expect(payload.description_html).toContain('<p><em>Original description</em></p>');
    expect(payload.description_html).not.toContain('Original Jira assignee');
    const comment = writes[1].body as CreateCommentPayload;
    expect(comment.comment_html).toContain(
      'Originally by &lt;Author&gt; &amp; &quot;Name&quot; on date &lt;tag&gt;:',
    );
    expect(comment.comment_html).toContain('<p><strong>Comment body</strong></p>');
    expect(prompt).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/Created:\s+1/));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Updated:'));
  });

  it('preserves an unmapped assignee and reporter even when they are the same person', async () => {
    const original = {
      accountId: 'former',
      displayName: '<Former> & User',
      emailAddress: 'former@example.com',
    };
    issues[0].fields.assignee = original;
    issues[0].fields.reporter = original;
    await runMigration(options);
    const payload = writes[0].body as CreateWorkItemPayload;
    expect(payload.assignees).toEqual([]);
    expect(writes[1]).toMatchObject({
      method: 'PATCH',
      path: expect.stringContaining('/work-items/work-item/'),
      body: { assignees: [] },
    });
    expect(payload.description_html).toContain(
      'Original Jira assignee:</strong> &lt;Former&gt; &amp; User (former@example.com)',
    );
    expect(payload.description_html).toContain(
      'Original Jira reporter:</strong> &lt;Former&gt; &amp; User (former@example.com)',
    );
  });

  it('keeps reporter attribution even when the reporter maps to a Plane member', async () => {
    issues[0].fields.reporter = issues[0].fields.assignee;
    await runMigration(options);
    const html = (writes[0].body as CreateWorkItemPayload).description_html;
    expect(html).toContain('Original Jira reporter:</strong> Alice (source@example.com)');
    expect(html).not.toContain('destination@example.com');
  });

  it('skips previously imported issues without prompting on a file-based rerun', async () => {
    existing = [
      { id: 'existing', name: 'Issue', external_source: 'jira-importer', external_id: 'TEST-1' },
    ];
    const prompt = vi.spyOn(inquirer, 'prompt');
    await runMigration(options);
    expect(writes).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('use --reimport'));
  });

  it('updates on explicit reimport, clears an unmapped assignee, and deduplicates comments', async () => {
    existing = [
      { id: 'existing', name: 'Issue', external_source: 'jira-importer', external_id: 'TEST-1' },
    ];
    options.reimport = true;
    options.usersFile = {};
    await runMigration(options);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].path).toContain('/work-items/existing/');
    expect((writes[0].body as CreateWorkItemPayload).assignees).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/Updated:\s+1/));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Created:'));
  });

  it('validates mappings without writing in a dry run', async () => {
    options.dryRun = true;
    await runMigration(options);
    expect(writes).toEqual([]);
    options.stateMappingFile = { mapping: {} };
    await expect(runMigration(options)).rejects.toThrow('Missing Plane state mapping');
    expect(writes).toEqual([]);
  });

  it('rejects an invalid state mapping before writing to Plane', async () => {
    options.stateMappingFile = { mapping: { Open: 'Other project state' } };
    await expect(runMigration(options)).rejects.toThrow('unknown in this project');
    expect(writes).toEqual([]);
  });
});
