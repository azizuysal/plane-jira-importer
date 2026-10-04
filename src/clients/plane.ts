/**
 * Plane API client.
 *
 * Uses `X-API-Key` authentication and the v1 API.
 * All operations respect rate limits and retry transient failures
 * with exponential backoff.
 */

import { HttpError, httpRequest, jsonRequest } from '../utils/http.js';
import type { JsonRequestOptions } from '../utils/http.js';
import { withRetry } from '../utils/retry.js';
import type { IRateLimiter, PlaneConfig } from '../types/config.js';
import type {
  PlaneProject,
  PlaneState,
  PlaneLabel,
  PlaneMember,
  PlaneWorkItem,
  PlaneComment,
  PlaneAttachment,
  PlaneUploadCredentials,
  PlaneApiResponse,
  CreateWorkItemPayload,
  CreateCommentPayload,
  ExternalMeta,
} from '../types/plane.js';

const EMPTY_EXTERNAL_META: ExternalMeta = { external_id: '', external_source: '' };

export class PlaneClient {
  private readonly workspaceSlug: string;
  private readonly rateLimiter: IRateLimiter;
  private readonly maxRetries: number;
  private readonly baseUrl: string;
  private readonly headers: HeadersInit;

  constructor(config: PlaneConfig) {
    this.workspaceSlug = config.workspaceSlug;
    this.rateLimiter = config.rateLimiter;
    this.maxRetries = config.maxRetries ?? 3;

    this.baseUrl = `${config.host.replace(/\/+$/, '')}/api/v1`;
    this.headers = { 'X-API-Key': config.apiKey };
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  /** List all projects in the workspace. */
  async listProjects(): Promise<PlaneProject[]> {
    const results: PlaneProject[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.apiCall(
        async () => {
          const data = await this.request<PlaneApiResponse<PlaneProject>>(
            `/workspaces/${this.workspaceSlug}/projects/`,
            { params: cursor ? { cursor } : {} },
          );
          return data;
        },
        cursor ? `listing projects (cursor ${cursor})` : 'listing projects',
      );

      if (Array.isArray(page)) {
        results.push(...page);
        break;
      } else if (page.results) {
        results.push(...page.results);
        if (page.next_page_results && page.next_cursor) {
          cursor = page.next_cursor;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return results;
  }

  // ── States ───────────────────────────────────────────────────────────────

  /** List all states for a project. */
  async listStates(projectId: string): Promise<PlaneState[]> {
    return this.apiCall(async () => {
      const data = await this.request<PlaneApiResponse<PlaneState>>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`,
      );
      return Array.isArray(data) ? data : (data.results ?? []);
    }, 'listing Plane states');
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  /** List all labels for a project. */
  async listLabels(projectId: string): Promise<PlaneLabel[]> {
    return this.apiCall(async () => {
      const data = await this.request<PlaneApiResponse<PlaneLabel>>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`,
      );
      return Array.isArray(data) ? data : (data.results ?? []);
    }, 'listing Plane labels');
  }

  /**
   * Create a label in a project.
   *
   * If the label already exists (409 Conflict) the existing label is returned.
   * Uses `withRetry` directly (instead of `apiCall`) so the raw HTTP error
   * is available for 409 detection before `handleError` transforms it.
   */
  async createLabel(projectId: string, name: string): Promise<PlaneLabel | null> {
    try {
      return await withRetry(
        async () => {
          await this.rateLimiter.wait();
          const data = await this.request<PlaneLabel>(
            `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`,
            { method: 'POST', body: { name } },
          );
          return data;
        },
        { maxRetries: this.maxRetries, context: `creating label "${name}"` },
      );
    } catch (err: unknown) {
      // 409 Conflict = label already exists — fetch and return it
      if (err instanceof HttpError && err.status === 409) {
        const existing = await this.listLabels(projectId);
        return existing.find((l) => l.name === name) ?? null;
      }
      this.handleError(err, `creating label "${name}"`);
    }
  }

  // ── Members ──────────────────────────────────────────────────────────────

  /** List project members, or workspace members when no project is supplied. */
  async listMembers(projectId?: string): Promise<PlaneMember[]> {
    return this.apiCall(async () => {
      const data = await this.request<PlaneApiResponse<PlaneMember>>(
        projectId
          ? `/workspaces/${this.workspaceSlug}/projects/${projectId}/project-members/`
          : `/workspaces/${this.workspaceSlug}/members/`,
      );
      return Array.isArray(data) ? data : (data.results ?? []);
    }, 'listing Plane members');
  }

  // ── Work Items ───────────────────────────────────────────────────────────

  /** List all work items for a project (paginated). */
  async listWorkItems(projectId: string): Promise<PlaneWorkItem[]> {
    const results: PlaneWorkItem[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.apiCall(
        async () => {
          const data = await this.request<PlaneApiResponse<PlaneWorkItem>>(
            `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/`,
            { params: cursor ? { cursor } : {} },
          );
          return data;
        },
        cursor ? `listing work items (cursor ${cursor})` : 'listing work items',
      );

      if (Array.isArray(page)) {
        results.push(...page);
        break;
      } else if (page.results) {
        results.push(...page.results);
        if (page.next_page_results && page.next_cursor) {
          cursor = page.next_cursor;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return results;
  }

  /** Delete a work item from a project. */
  async deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
    await this.apiCall(async () => {
      const response = await httpRequest(
        `${this.baseUrl}/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/`,
        { method: 'DELETE', headers: this.headers },
      );
      await response.arrayBuffer();
    }, `deleting work item ${workItemId}`);
  }

  /** Update an existing work item in a project. */
  async updateWorkItem(
    projectId: string,
    workItemId: string,
    payload: Partial<CreateWorkItemPayload>,
  ): Promise<PlaneWorkItem> {
    return this.apiCall(async () => {
      const data = await this.request<PlaneWorkItem>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/`,
        { method: 'PATCH', body: payload },
      );
      return data;
    }, `updating work item ${workItemId}`);
  }

  /** List comments on a work item. Returns external_ids of existing comments. */
  async listCommentExternalIds(projectId: string, workItemId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const page = await this.apiCall(async () => {
        const data = await this.request<PlaneApiResponse<PlaneComment>>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/comments/`,
          { params: cursor ? { cursor } : {} },
        );
        return data;
      }, `listing comments for ${workItemId}`);

      const items = Array.isArray(page) ? page : (page.results ?? []);
      for (const c of items) {
        if (c.external_id && c.external_source === 'jira-importer') {
          ids.add(c.external_id);
        }
      }

      if (!Array.isArray(page) && page.next_page_results && page.next_cursor) {
        cursor = page.next_cursor;
      } else {
        break;
      }
    }

    return ids;
  }

  /** List attachment external_ids on a work item. */
  async listAttachmentExternalIds(projectId: string, workItemId: string): Promise<Set<string>> {
    const ids = new Set<string>();

    const items = await this.apiCall(async () => {
      const data = await this.request<PlaneAttachment[]>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/`,
      );
      return data;
    }, `listing attachments for ${workItemId}`);

    for (const a of items) {
      if (a.external_id && a.external_source === 'jira-importer') {
        ids.add(a.external_id);
      }
    }

    return ids;
  }

  /** Create a work item in a project. */
  async createWorkItem(projectId: string, payload: CreateWorkItemPayload): Promise<PlaneWorkItem> {
    return this.apiCall(async () => {
      const data = await this.request<PlaneWorkItem>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/`,
        { method: 'POST', body: payload },
      );
      return data;
    }, `creating work item "${payload.name}"`);
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  /** Add a comment to a work item. */
  async addComment(
    projectId: string,
    workItemId: string,
    payload: CreateCommentPayload,
  ): Promise<PlaneComment> {
    return this.apiCall(async () => {
      const data = await this.request<PlaneComment>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/comments/`,
        { method: 'POST', body: payload },
      );
      return data;
    }, `adding comment to work item ${workItemId}`);
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  /**
   * Upload an attachment to a work item.
   *
   * Three-step process:
   * 1. Get upload credentials (presigned POST)
   * 2. Upload file to storage (S3 / MinIO)
   * 3. Confirm upload completion
   *
   * Each step is individually retried on transient failures.
   */
  async uploadAttachment(
    projectId: string,
    workItemId: string,
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    size: number,
    external: ExternalMeta = EMPTY_EXTERNAL_META,
  ): Promise<PlaneAttachment> {
    // Step 1: Get upload credentials
    const credentials = await this.apiCall(async () => {
      const data = await this.request<PlaneUploadCredentials>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/`,
        { method: 'POST', body: { name: filename, type: mimeType, size, ...external } },
      );
      return data;
    }, `getting upload credentials for "${filename}"`);

    const assetId = credentials.asset_id ?? credentials.id;
    const uploadData = credentials.upload_data;
    if (!assetId || !uploadData?.url || !uploadData.fields) {
      throw new Error(`Plane returned incomplete upload credentials for "${filename}"`);
    }

    // Step 2: Upload file to storage via presigned form fields
    await this.apiCall(async () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(uploadData.fields)) {
        form.append(key, value);
      }
      form.append('file', new Blob([Uint8Array.from(fileBuffer)], { type: mimeType }), filename);
      const response = await httpRequest(uploadData.url, { method: 'POST', body: form }, 120_000);
      await response.arrayBuffer();
    }, `uploading "${filename}" to storage`);

    // Step 3: Confirm upload
    return this.apiCall(async () => {
      const data = await this.request<PlaneAttachment>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/${assetId}/`,
        { method: 'PATCH' },
      );
      return data;
    }, `confirming upload for "${filename}"`);
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

  private request<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
    return jsonRequest<T>(`${this.baseUrl}${path}`, { ...options, headers: this.headers });
  }

  private handleError(err: unknown, context: string): never {
    if (err instanceof HttpError) {
      throw new Error(`Plane API error ${err.status} while ${context}: ${err.message}`);
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error while ${context}: ${message}`);
  }
}
