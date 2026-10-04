/**
 * Migration orchestrator.
 *
 * Coordinates the full Jira → Plane migration flow: fetching issues,
 * building maps, creating work items (parents first), and migrating
 * comments and attachments.
 *
 * Designed for resilience at scale:
 * - Per-issue error isolation (one failure doesn't stop the batch)
 * - Attachment size limits to avoid OOM on large files
 * - Detailed progress reporting with duration and ETA
 * - Structured summary report on completion
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import type { JiraClient } from '../clients/jira.js';
import type { PlaneClient } from '../clients/plane.js';
import type { JiraIssue, JiraComment, JiraUser } from '../types/jira.js';
import type { CreateWorkItemPayload, CreateCommentPayload } from '../types/plane.js';
import type { MigrationConfig, StateMappingFile, UsersFile } from '../types/config.js';
import { log } from '../utils/logger.js';
import { escapeHtml, formatDate, formatSize, formatDuration, progress } from '../utils/helpers.js';
import {
  mapPriority,
  buildStatusMap,
  buildUserMap,
  ensureTypeLabel,
  extractStatuses,
  extractUsers,
  extractIssueTypes,
} from './mapper.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Options for the migration run. */
export interface MigrationOptions {
  jira: JiraClient;
  plane: PlaneClient;
  projectKey: string;
  planeProjectId: string;
  dryRun: boolean;
  reimport: boolean;
  config: MigrationConfig;
  usersFile?: UsersFile;
  stateMappingFile?: StateMappingFile;
}

/** Internal parameters passed to the single-issue migration helper. */
interface MigrateIssueParams {
  issue: JiraIssue;
  index: number;
  total: number;
  jira: JiraClient;
  plane: PlaneClient;
  planeProjectId: string;
  statusMap: Record<string, string>;
  userMap: Record<string, string>;
  labelCache: Map<string, string>;
  workItemMap: Map<string, string>;
  maxAttachmentBytes: number;
  /** Existing Plane work item ID if updating, undefined if creating new. */
  existingWorkItemId: string | undefined;
}

/** Per-issue migration result for stats tracking. */
interface IssueResult {
  commentsMigrated: number;
  commentsFailed: number;
  attachmentsMigrated: number;
  attachmentsSkipped: number;
  attachmentsFailed: number;
}

/** Aggregate migration statistics. */
interface MigrationStats {
  total: number;
  migrated: number;
  updated: number;
  skipped: number;
  failed: number;
  commentsMigrated: number;
  commentsFailed: number;
  attachmentsMigrated: number;
  attachmentsSkipped: number;
  attachmentsFailed: number;
  failures: Array<{ key: string; summary: string; error: string }>;
  startTime: number;
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

/**
 * Run the full migration flow.
 *
 * 1. Fetch all Jira issues for the project
 * 2. Extract unique statuses, assignees, and issue types
 * 3. Fetch Plane metadata (states, members, existing work items)
 * 4. Build status and user maps (auto-match + interactive fallback)
 * 5. Create work items in Plane (parents first, then children)
 * 6. Migrate comments and attachments for each issue
 * 7. Print a structured summary report
 */
export async function runMigration(options: MigrationOptions): Promise<void> {
  const { jira, plane, projectKey, planeProjectId, dryRun, reimport, config } = options;
  const maxAttachmentBytes = config.maxAttachmentSizeMb * 1024 * 1024;

  // ── Fetch Jira issues ──────────────────────────────────────────────────
  log.heading('Fetching Jira issues');
  const issues = await jira.searchIssues(projectKey);
  log.success(`Found ${issues.length} issues`);

  if (issues.length === 0) {
    log.info('No issues to migrate');
    return;
  }

  // ── Extract metadata ───────────────────────────────────────────────────
  const statuses = extractStatuses(issues);
  const assignees = extractUsers(issues);
  const issueTypes = extractIssueTypes(issues);

  log.info(
    `Found ${statuses.length} statuses, ${assignees.length} users, ${issueTypes.length} issue types`,
  );

  // ── Fetch Plane metadata ───────────────────────────────────────────────
  log.heading('Fetching Plane metadata');
  const [planeStates, planeMembers, existingWorkItems] = await Promise.all([
    plane.listStates(planeProjectId),
    plane.listMembers(planeProjectId),
    plane.listWorkItems(planeProjectId),
  ]);

  // Build set of already-migrated issue keys for incremental migration
  const migratedItems = existingWorkItems.filter(
    (w) => w.external_source === 'jira-importer',
  );
  const migratedKeys = new Set(
    migratedItems.map((w) => w.external_id).filter((key): key is string => !!key),
  );

  // Track created work items by Jira key (including previously migrated)
  const workItemMap = new Map<string, string>();
  for (const wi of migratedItems) {
    if (wi.external_id) {
      workItemMap.set(wi.external_id, wi.id);
    }
  }

  // ── Update/reimport decision ─────────────────────────────────────────
  const shouldUpdate = await resolveUpdateMode(
    reimport,
    migratedKeys.size,
    dryRun,
    !!options.usersFile && !!options.stateMappingFile,
  );

  // ── Build mappings ─────────────────────────────────────────────────────
  log.heading('Building status mapping');
  const statusMap = await buildStatusMap(statuses, planeStates, options.stateMappingFile);

  log.heading('Building user mapping');
  const userMap = await buildUserMap(assignees, planeMembers, options.usersFile);

  // ── Label cache ────────────────────────────────────────────────────────
  const labelCache = new Map<string, string>();
  const existingLabels = await plane.listLabels(planeProjectId);
  for (const label of existingLabels) {
    labelCache.set(label.name, label.id);
  }

  // ── Order issues: parents first, then children ─────────────────────────
  const parents = issues.filter((i) => !i.fields.parent);
  const children = issues.filter((i) => i.fields.parent);
  const orderedIssues = [...parents, ...children];

  // In update mode, process all issues; otherwise only new ones
  const toMigrate = shouldUpdate
    ? orderedIssues
    : orderedIssues.filter((i) => !migratedKeys.has(i.key));
  const skippedCount = orderedIssues.length - toMigrate.length;

  if (toMigrate.length === 0) {
    log.success('All issues have already been migrated!');
    return;
  }

  logMigrationPlan(toMigrate, migratedKeys, shouldUpdate, skippedCount, config);

  // ── Dry run ────────────────────────────────────────────────────────────
  if (dryRun) {
    log.heading('Dry run — would migrate:');
    for (const issue of toMigrate) {
      log.item(`${issue.key}: ${issue.fields.summary}`);
    }
    return;
  }

  // ── Migrate issues ─────────────────────────────────────────────────────
  log.heading('Migrating issues');

  const stats = await migrateAll({
    issues: toMigrate,
    totalIssues: orderedIssues.length,
    skippedCount,
    jira,
    plane,
    planeProjectId,
    statusMap,
    userMap,
    labelCache,
    workItemMap,
    maxAttachmentBytes,
  });

  printSummary(stats);

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Log what the migration will do (counts, update vs create). */
function logMigrationPlan(
  toMigrate: JiraIssue[],
  migratedKeys: Set<string>,
  shouldUpdate: boolean,
  skippedCount: number,
  config: MigrationConfig,
): void {
  if (shouldUpdate) {
    const updateCount = toMigrate.filter((i) => migratedKeys.has(i.key)).length;
    const newCount = toMigrate.length - updateCount;
    log.info(`${updateCount} issues to update, ${newCount} new issues to create`);
  } else {
    log.info(`${toMigrate.length} new issues to migrate (${skippedCount} already done)`);
  }

  if (config.maxAttachmentSizeMb < Infinity) {
    log.dim(`  Attachment size limit: ${config.maxAttachmentSizeMb}MB`);
  }
}

/** Prompt user for update vs new-only mode, or resolve automatically. */
async function resolveUpdateMode(
  reimport: boolean,
  migratedCount: number,
  dryRun: boolean,
  fileMappings: boolean,
): Promise<boolean> {
  if (reimport) return true;
  if (migratedCount === 0 || dryRun) return false;
  if (fileMappings) {
    log.info(`Skipping ${migratedCount} previously migrated issues; use --reimport to update them`);
    return false;
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: `Found ${migratedCount} previously migrated issues. What would you like to do?`,
      choices: [
        { name: `Import new only (skip ${migratedCount} existing)`, value: 'new' },
        { name: `Update all (update ${migratedCount} existing + import new)`, value: 'update' },
      ],
    },
  ]);
  return mode === 'update';
}

// ─── Batch Migration ─────────────────────────────────────────────────────────

/** Parameters for the batch migration loop. */
interface MigrateAllParams {
  issues: JiraIssue[];
  totalIssues: number;
  skippedCount: number;
  jira: JiraClient;
  plane: PlaneClient;
  planeProjectId: string;
  statusMap: Record<string, string>;
  userMap: Record<string, string>;
  labelCache: Map<string, string>;
  workItemMap: Map<string, string>;
  maxAttachmentBytes: number;
}

/** Run the migration loop over all issues, accumulating stats. */
async function migrateAll(params: MigrateAllParams): Promise<MigrationStats> {
  const { issues, totalIssues, skippedCount } = params;

  const stats: MigrationStats = {
    total: totalIssues, migrated: 0, updated: 0, skipped: skippedCount,
    failed: 0, commentsMigrated: 0, commentsFailed: 0,
    attachmentsMigrated: 0, attachmentsSkipped: 0, attachmentsFailed: 0,
    failures: [], startTime: Date.now(),
  };

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    try {
      const existingWorkItemId = params.workItemMap.get(issue.key);
      const result = await migrateIssue({
        ...params,
        issue,
        index: i + 1,
        total: issues.length,
        existingWorkItemId,
      });
      accumulateResult(stats, result, !!existingWorkItemId);
    } catch (err: unknown) {
      stats.failed++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      stats.failures.push({ key: issue.key, summary: issue.fields.summary, error: errorMsg });
      log.error(`  Failed to migrate ${issue.key}: ${errorMsg}`);
    }
  }

  return stats;
}

/** Merge a single-issue result into aggregate stats. */
function accumulateResult(stats: MigrationStats, result: IssueResult, wasUpdate: boolean): void {
  if (wasUpdate) { stats.updated++; } else { stats.migrated++; }
  stats.commentsMigrated += result.commentsMigrated;
  stats.commentsFailed += result.commentsFailed;
  stats.attachmentsMigrated += result.attachmentsMigrated;
  stats.attachmentsSkipped += result.attachmentsSkipped;
  stats.attachmentsFailed += result.attachmentsFailed;
}

// ─── Single Issue Migration ──────────────────────────────────────────────────

/** Migrate a single Jira issue to Plane (create/update + comments + attachments). */
async function migrateIssue(params: MigrateIssueParams): Promise<IssueResult> {
  const { issue, index, total, jira, plane, planeProjectId, existingWorkItemId } = params;

  const isUpdate = !!existingWorkItemId;
  const result: IssueResult = {
    commentsMigrated: 0, commentsFailed: 0,
    attachmentsMigrated: 0, attachmentsSkipped: 0, attachmentsFailed: 0,
  };

  log.info(
    `${progress(index, total)} ${isUpdate ? 'Updating' : 'Migrating'} ${issue.key}: ${issue.fields.summary}`,
  );

  const fullIssue = await jira.getIssue(issue.key);
  const payload = await buildWorkItemPayload({ issue, fullIssue, params });

  const workItemId = isUpdate
    ? (await plane.updateWorkItem(planeProjectId, existingWorkItemId, payload), existingWorkItemId)
    : (await plane.createWorkItem(planeProjectId, payload)).id;

  params.workItemMap.set(issue.key, workItemId);

  // Plane v1 applies a project's default assignee on creation, even for an empty list.
  if (!isUpdate && payload.assignees?.length === 0) {
    await plane.updateWorkItem(planeProjectId, workItemId, { assignees: [] });
  }

  const [existingCommentIds, existingAttachmentIds] = isUpdate
    ? await Promise.all([
        plane.listCommentExternalIds(planeProjectId, workItemId),
        plane.listAttachmentExternalIds(planeProjectId, workItemId),
      ])
    : [new Set<string>(), new Set<string>()];

  await migrateIssueComments({
    jira, plane, planeProjectId, workItemId, issueKey: issue.key,
    existingIds: existingCommentIds, isUpdate, result,
  });
  await migrateIssueAttachments({
    jira, plane, planeProjectId, workItemId, fields: fullIssue.fields,
    existingIds: existingAttachmentIds, isUpdate,
    maxAttachmentBytes: params.maxAttachmentBytes, result,
  });

  log.success(`  ${issue.key} → ${workItemId}${isUpdate ? ' (updated)' : ''}`);
  return result;
}

// ─── Payload Builder ─────────────────────────────────────────────────────────

interface BuildPayloadArgs {
  issue: JiraIssue;
  fullIssue: JiraIssue;
  params: MigrateIssueParams;
}

/** Build a Plane work item payload from a Jira issue. */
async function buildWorkItemPayload(args: BuildPayloadArgs): Promise<CreateWorkItemPayload> {
  const { issue, fullIssue, params } = args;
  const { jira, plane, planeProjectId, statusMap, userMap, labelCache, workItemMap } = params;

  const jiraLink = `https://${jira.host}/browse/${issue.key}`;
  const renderedDesc = fullIssue.renderedFields?.description ?? '';
  const attribution: string[] = [];
  if (issue.fields.assignee && !userMap[issue.fields.assignee.accountId]) {
    attribution.push(originalUser('assignee', issue.fields.assignee));
  }
  if (issue.fields.reporter) {
    attribution.push(originalUser('reporter', issue.fields.reporter));
  }
  const descriptionHtml = `<p><a href="${escapeHtml(jiraLink)}" target="_blank">${escapeHtml(issue.key)} on Jira</a></p>${attribution.join('')}${renderedDesc}`;

  const priority = mapPriority(issue.fields.priority?.name ?? null);
  const stateId = issue.fields.status?.name ? statusMap[issue.fields.status.name] : undefined;

  const assigneeIds: string[] = [];
  if (issue.fields.assignee?.accountId && userMap[issue.fields.assignee.accountId]) {
    assigneeIds.push(userMap[issue.fields.assignee.accountId]);
  }

  const labelIds: string[] = [];
  if (issue.fields.issuetype?.name) {
    const labelId = await ensureTypeLabel(
      plane,
      planeProjectId,
      issue.fields.issuetype.name,
      labelCache,
    );
    if (labelId) labelIds.push(labelId);
  }

  return {
    name: issue.fields.summary,
    description_html: descriptionHtml,
    priority,
    external_id: issue.key,
    external_source: 'jira-importer',
    state: stateId,
    assignees: assigneeIds,
    labels: labelIds.length > 0 ? labelIds : undefined,
    parent: issue.fields.parent?.key ? workItemMap.get(issue.fields.parent.key) : undefined,
    start_date: formatDate(issue.fields.customfield_10015) ?? undefined,
    target_date: formatDate(issue.fields.duedate) ?? undefined,
  };
}

function originalUser(role: string, user: JiraUser): string {
  const name = user.displayName || user.accountId;
  const identity = user.emailAddress ? `${name} (${user.emailAddress})` : name;
  return `<p><strong>Original Jira ${role}:</strong> ${escapeHtml(identity)}</p>`;
}

// ─── Comment Migration ───────────────────────────────────────────────────────

interface CommentMigrationArgs {
  jira: JiraClient;
  plane: PlaneClient;
  planeProjectId: string;
  workItemId: string;
  issueKey: string;
  existingIds: Set<string>;
  isUpdate: boolean;
  result: IssueResult;
}

/** Migrate all new comments for an issue, with per-comment fault tolerance. */
async function migrateIssueComments(args: CommentMigrationArgs): Promise<void> {
  const { jira, plane, planeProjectId, workItemId, issueKey, existingIds, isUpdate, result } = args;

  const comments = await jira.getComments(issueKey);
  if (comments.length === 0) return;

  const newComments = comments.filter(
    (c) => !existingIds.has(`${issueKey}-comment-${c.id}`),
  );

  if (newComments.length === 0) {
    if (isUpdate) log.dim(`  All ${comments.length} comments already exist`);
    return;
  }

  log.dim(`  Migrating ${newComments.length} comments (${comments.length - newComments.length} existing)`);
  for (const comment of newComments) {
    try {
      await migrateSingleComment(plane, planeProjectId, workItemId, comment, issueKey);
      result.commentsMigrated++;
    } catch (err: unknown) {
      result.commentsFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`    Failed to migrate comment ${comment.id}: ${msg}`);
    }
  }
}

// ─── Attachment Migration ────────────────────────────────────────────────────

interface AttachmentMigrationArgs {
  jira: JiraClient;
  plane: PlaneClient;
  planeProjectId: string;
  workItemId: string;
  fields: JiraIssue['fields'];
  existingIds: Set<string>;
  isUpdate: boolean;
  maxAttachmentBytes: number;
  result: IssueResult;
}

/** Migrate all new attachments for an issue, with per-attachment fault tolerance. */
async function migrateIssueAttachments(args: AttachmentMigrationArgs): Promise<void> {
  const { jira, plane, planeProjectId, workItemId, fields, existingIds, isUpdate, maxAttachmentBytes, result } = args;

  const attachments = jira.getAttachments(fields);
  if (attachments.length === 0) return;

  const newAttachments = attachments.filter((a) => !existingIds.has(a.id));

  if (newAttachments.length === 0) {
    if (isUpdate) log.dim(`  All ${attachments.length} attachments already exist`);
    return;
  }

  log.dim(`  Migrating ${newAttachments.length} attachments (${attachments.length - newAttachments.length} existing)`);
  for (const attachment of newAttachments) {
    if (maxAttachmentBytes > 0 && attachment.size > maxAttachmentBytes) {
      result.attachmentsSkipped++;
      log.warn(
        `    Skipping "${attachment.filename}" (${formatSize(attachment.size)} exceeds ${formatSize(maxAttachmentBytes)} limit)`,
      );
      continue;
    }

    try {
      const buffer = await jira.downloadAttachment(attachment.contentUrl);
      await plane.uploadAttachment(
        planeProjectId, workItemId, buffer,
        attachment.filename, attachment.mimeType, attachment.size,
        { external_id: attachment.id, external_source: 'jira-importer' },
      );
      result.attachmentsMigrated++;
      log.dim(`    ✓ ${attachment.filename}`);
    } catch (err: unknown) {
      result.attachmentsFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`    Failed to migrate attachment "${attachment.filename}": ${msg}`);
    }
  }
}

// ─── Single Comment Helper ───────────────────────────────────────────────────

/**
 * Migrate a single Jira comment to a Plane work item.
 *
 * Prefixes the comment body with the original author and date.
 */
async function migrateSingleComment(
  plane: PlaneClient,
  projectId: string,
  workItemId: string,
  comment: JiraComment,
  issueKey: string,
): Promise<void> {
  const author = escapeHtml(comment.author?.displayName ?? 'Unknown');
  const date = escapeHtml(comment.created ?? 'unknown date');
  const body = comment.renderedBody ?? '<p>(empty comment)</p>';

  const commentHtml = `<p><strong>Originally by ${author} on ${date}:</strong></p>${body}`;

  const payload: CreateCommentPayload = {
    comment_html: commentHtml,
    external_source: 'jira-importer',
    external_id: `${issueKey}-comment-${comment.id}`,
  };

  await plane.addComment(projectId, workItemId, payload);
}

// ─── Summary Report ──────────────────────────────────────────────────────────

/** Print a structured migration summary to the console. */
function printSummary(stats: MigrationStats): void {
  const duration = Date.now() - stats.startTime;
  const separator = '═'.repeat(50);

  console.log('\n' + chalk.bold(separator));
  console.log(chalk.bold('  Migration Summary'));
  console.log(chalk.bold(separator));

  console.log(`  Total issues:           ${stats.total}`);
  if (stats.migrated > 0) {
    console.log(chalk.green(`  ✓ Created:              ${stats.migrated}`));
  }
  if (stats.updated > 0) {
    console.log(chalk.blue(`  ↻ Updated:              ${stats.updated}`));
  }
  if (stats.skipped > 0) {
    console.log(chalk.dim(`  ○ Skipped (existing):   ${stats.skipped}`));
  }
  if (stats.failed > 0) {
    console.log(chalk.red(`  ✗ Failed:               ${stats.failed}`));
  }

  console.log('');
  console.log(`  Comments migrated:      ${stats.commentsMigrated}`);
  if (stats.commentsFailed > 0) {
    console.log(chalk.yellow(`  Comments failed:        ${stats.commentsFailed}`));
  }
  console.log(`  Attachments migrated:   ${stats.attachmentsMigrated}`);
  if (stats.attachmentsSkipped > 0) {
    console.log(chalk.yellow(`  Attachments skipped:    ${stats.attachmentsSkipped} (size limit)`));
  }
  if (stats.attachmentsFailed > 0) {
    console.log(chalk.yellow(`  Attachments failed:     ${stats.attachmentsFailed}`));
  }

  console.log('');
  console.log(`  Duration:               ${formatDuration(duration)}`);
  console.log(chalk.bold(separator));

  if (stats.failures.length > 0) {
    console.log('\n' + chalk.red.bold('  Failed issues:'));
    for (const f of stats.failures) {
      console.log(chalk.red(`    ${f.key}: ${f.error}`));
    }
    console.log('');
  }
}
