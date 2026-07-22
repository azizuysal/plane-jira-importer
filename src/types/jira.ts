/**
 * Jira Cloud API response types.
 *
 * Covers the subset of the Jira REST API v3 used by this importer:
 * projects, issues (with search/pagination), comments, and attachments.
 */

// ─── Core Entities ───────────────────────────────────────────────────────────

/** Jira Cloud project. */
export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
}

/** Jira user (assignee, reporter, comment author). */
export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
}

/** Jira priority level. */
export interface JiraPriority {
  id: string;
  name: string;
}

/** Jira workflow status. */
export interface JiraStatus {
  id: string;
  name: string;
  statusCategory?: {
    id: number;
    key: string;
    name: string;
  };
}

/** Jira issue type (Bug, Story, Task, Sub-task, etc.). */
export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/** Raw attachment metadata as returned by the Jira API. */
export interface JiraAttachmentRaw {
  id: string;
  filename: string;
  mimeType?: string;
  size: number;
  /** Direct download URL for the attachment content. */
  content: string;
  author?: JiraUser;
  created: string;
}

/** Parsed attachment info used internally by the importer. */
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
  author: string;
  created: string;
}

// ─── Issues ──────────────────────────────────────────────────────────────────

/** Fields present on a Jira issue. */
export interface JiraIssueFields {
  summary: string;
  status?: JiraStatus;
  priority?: JiraPriority;
  issuetype?: JiraIssueType;
  assignee?: JiraUser;
  reporter?: JiraUser;
  creator?: JiraUser;
  labels?: string[];
  parent?: { key: string; id: string };
  /** Sprint start date (common custom field). */
  customfield_10015?: string;
  duedate?: string;
  attachment?: JiraAttachmentRaw[];
  created?: string;
  updated?: string;
  /** Atlassian Document Format (ADF) body — opaque at this level. */
  description?: unknown;
}

/** Jira issue with optional rendered (HTML) fields. */
export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
  renderedFields?: {
    description?: string;
    [key: string]: string | undefined;
  };
}

// ─── Comments ────────────────────────────────────────────────────────────────

/** A single comment on a Jira issue. */
export interface JiraComment {
  id: string;
  author?: JiraUser;
  /** ADF body — opaque at this level. */
  body?: unknown;
  /** Server-rendered HTML of the comment body. */
  renderedBody?: string;
  created?: string;
  updated?: string;
}

// ─── API Responses ───────────────────────────────────────────────────────────

/**
 * Response from `/rest/api/3/search/jql`.
 *
 * This endpoint uses token-based pagination — it ignores `startAt` and does
 * not return `total`. Follow `nextPageToken` until `isLast` is true.
 */
export interface JiraSearchResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** Paginated response from the issue comments endpoint. */
export interface JiraCommentsResponse {
  comments: JiraComment[];
  total: number;
  startAt: number;
  maxResults: number;
}

// ─── Derived / Helper Types ──────────────────────────────────────────────────

/** De-duplicated user info extracted from issues for the mapping step. */
export interface ExtractedUser {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}
