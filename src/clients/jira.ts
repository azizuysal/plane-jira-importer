/**
 * Jira Cloud API client.
 *
 * Uses Basic auth (`email:api_token`) and the v3 REST API.
 * All methods respect rate limits and retry transient failures with
 * exponential backoff.
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { log } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { mimeFromFilename } from '../utils/helpers.js';
import type { IRateLimiter, JiraConfig } from '../types/config.js';

/** Prefer extension-based MIME over Jira metadata (which is often wrong/missing). */
function deriveMimeType(filename: string, jiraMime?: string): string {
  const fromExt = mimeFromFilename(filename);
  if (fromExt !== 'application/octet-stream') return fromExt;
  return jiraMime ?? 'application/octet-stream';
}
import type {
  JiraProject,
  JiraIssue,
  JiraAttachment,
  JiraComment,
  JiraSearchResponse,
  JiraCommentsResponse,
  JiraIssueFields,
} from '../types/jira.js';

export class JiraClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter: IRateLimiter;
  private readonly maxRetries: number;
  readonly host: string;

  constructor(config: JiraConfig) {
    const base64 = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

    this.client = axios.create({
      baseURL: `https://${config.host}`,
      headers: {
        Authorization: `Basic ${base64}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });

    this.host = config.host;
    this.rateLimiter = config.rateLimiter;
    this.maxRetries = config.maxRetries ?? 3;
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  /** List all Jira projects visible to the authenticated user. */
  async listProjects(): Promise<JiraProject[]> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.get<JiraProject[]>('/rest/api/3/project');
        return data;
      },
      'listing Jira projects',
    );
  }

  // ── Issues ───────────────────────────────────────────────────────────────

  /**
   * Fetch all issues for a project using JQL pagination.
   *
   * `/rest/api/3/search/jql` paginates by opaque token, not by offset — it
   * ignores `startAt` entirely and returns the same first page for every
   * offset. Pages are followed via `nextPageToken` until `isLast` is set.
   *
   * Each page is individually retried on transient failures.
   * Returns the full list of issue summaries (not expanded).
   */
  async searchIssues(projectKey: string): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    const seenKeys = new Set<string>();
    const seenTokens = new Set<string>();
    const maxResults = 100;

    let nextPageToken: string | undefined;
    let page = 1;

    for (;;) {
      const token = nextPageToken;

      const data = await this.apiCall(
        async () => {
          const { data } = await this.client.get<JiraSearchResponse>('/rest/api/3/search/jql', {
            params: {
              jql: `project = "${projectKey}" ORDER BY created ASC`,
              maxResults,
              ...(token ? { nextPageToken: token } : {}),
              fields:
                'summary,status,priority,issuetype,created,updated,assignee,reporter,creator,labels,parent,customfield_10015,duedate,attachment',
            },
          });
          return data;
        },
        `searching issues (page ${page})`,
      );

      const fetched = data.issues;

      // Pages can overlap; de-duplicate so a repeated issue is counted once.
      for (const issue of fetched) {
        if (!seenKeys.has(issue.key)) {
          seenKeys.add(issue.key);
          issues.push(issue);
        }
      }
      log.dim(`  Fetched ${issues.length} issues so far`);

      if (data.isLast === true) break;
      if (!data.nextPageToken) {
        throw new Error(
          `Jira pagination error for ${projectKey} on page ${page}: missing nextPageToken before isLast is true`,
        );
      }
      if (seenTokens.has(data.nextPageToken)) {
        throw new Error(
          `Jira pagination error for ${projectKey} on page ${page}: repeated nextPageToken before isLast is true`,
        );
      }

      seenTokens.add(data.nextPageToken);
      nextPageToken = data.nextPageToken;
      page++;
    }

    return issues;
  }

  /** Get a single issue with rendered (HTML) fields. */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.get<JiraIssue>(`/rest/api/3/issue/${issueKey}`, {
          params: { expand: 'renderedFields' },
        });
        return data;
      },
      `fetching issue ${issueKey}`,
    );
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  /**
   * Extract normalised attachment metadata from raw issue fields.
   *
   * This is a synchronous helper — attachment info is already present in the
   * issue payload.
   */
  getAttachments(issueFields: JiraIssueFields): JiraAttachment[] {
    return (issueFields.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      // Prefer extension-based MIME detection over Jira metadata — Jira
      // sometimes omits or misreports mimeType, causing Plane to reject
      // the upload with "Invalid file type".
      mimeType: deriveMimeType(a.filename, a.mimeType),
      size: a.size,
      contentUrl: a.content,
      author: a.author?.displayName ?? 'Unknown',
      created: a.created,
    }));
  }

  /**
   * Download an attachment as a Buffer.
   *
   * The `contentUrl` is an absolute URL that still requires authentication.
   */
  async downloadAttachment(contentUrl: string): Promise<Buffer> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.get<ArrayBuffer>(contentUrl, {
          responseType: 'arraybuffer',
          baseURL: '', // contentUrl is absolute
        });
        return Buffer.from(data);
      },
      `downloading attachment from ${contentUrl}`,
    );
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  /**
   * Get all comments for an issue, paginating automatically.
   *
   * Each page is individually retried on transient failures.
   */
  async getComments(issueKey: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    const maxResults = 100;

    for (;;) {
      const data = await this.apiCall(
        async () => {
          const { data } = await this.client.get<JiraCommentsResponse>(
            `/rest/api/3/issue/${issueKey}/comment`,
            { params: { maxResults, startAt, expand: 'renderedBody' } },
          );
          return data;
        },
        `fetching comments for ${issueKey} (offset ${startAt})`,
      );

      comments.push(...data.comments);

      if (startAt + data.comments.length >= data.total) break;
      startAt += maxResults;
    }

    return comments;
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Execute an API call with rate limiting and retry.
   *
   * Waits for the rate limiter before each attempt, retries transient
   * failures with exponential backoff, and formats errors via
   * {@link handleError} when all retries are exhausted.
   */
  private async apiCall<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await withRetry(
        async () => {
          await this.rateLimiter.wait();
          return fn();
        },
        { maxRetries: this.maxRetries, context },
      );
    } catch (err: unknown) {
      this.handleError(err, context);
    }
  }

  /**
   * Translate Axios errors into human-readable `Error` instances.
   *
   * Always throws — the `never` return type lets callers skip an explicit
   * return after the catch block.
   */
  private handleError(err: unknown, context: string): never {
    if (axios.isAxiosError(err) && err.response) {
      const { status } = err.response;
      const data = err.response.data as Record<string, unknown> | undefined;
      const errorMessages = data?.errorMessages;
      let msg: string;

      if (Array.isArray(errorMessages)) {
        msg = (errorMessages as string[]).join(', ');
      } else if (typeof data?.message === 'string') {
        msg = data.message;
      } else {
        msg = JSON.stringify(data);
      }

      throw new Error(`Jira API error ${status} while ${context}: ${msg}`);
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error while ${context}: ${message}`);
  }
}
