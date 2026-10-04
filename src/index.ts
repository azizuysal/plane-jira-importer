#!/usr/bin/env node

/**
 * CLI entry point for plane-jira-importer.
 *
 * Validates the environment, initialises clients, presents interactive
 * project selection, and kicks off the migration.
 */

import 'dotenv/config';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { parseArgs, validateEnv, requireEnv } from './utils/helpers.js';
import { log } from './utils/logger.js';
import { JiraClient } from './clients/jira.js';
import { PlaneClient } from './clients/plane.js';
import { RateLimiter } from './utils/rate-limiter.js';
import { runMigration } from './services/migrator.js';
import { loadUsersFile, loadStateMappingFile } from './utils/mapping-files.js';
import type { RequiredEnvVar, MigrationConfig } from './types/config.js';

// ─── Banner ──────────────────────────────────────────────────────────────────

const BANNER = `
${chalk.blue.bold('✈  Plane ← Jira Importer')}
${chalk.dim('Migrate issues, comments, and attachments from Jira Cloud to Plane')}
`;

// ─── Environment Helpers ─────────────────────────────────────────────────────

/** Read a numeric env var with a default, clamped to a minimum. */
function envInt(key: string, defaultValue: number, min = 1): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) {
    log.warn(`Invalid ${key}="${raw}" — using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(BANNER);

  // Parse CLI flags
  const flags = parseArgs();
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const reimport = flags['reimport'] === true || flags['reimport'] === 'true';
  const usersFile = await loadUsersFile(flags['users-file']);
  const stateMappingFile = await loadStateMappingFile(flags['state-mapping-file']);

  for (const key of ['project-key', 'plane-project'] as const) {
    const value = flags[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error(`--${key} requires a value`);
    }
  }

  if (
    !process.stdin.isTTY &&
    (!flags['project-key'] || !flags['plane-project'] || !usersFile || !stateMappingFile)
  ) {
    throw new Error(
      'Non-interactive runs require --project-key, --plane-project, --users-file, and --state-mapping-file',
    );
  }

  if (dryRun) {
    log.warn('Dry run mode — no changes will be made');
  }
  if (reimport) {
    log.warn('Reimport mode — existing migrated items will be updated');
  }

  // Validate required environment variables
  const required: RequiredEnvVar[] = [
    'JIRA_HOST',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'PLANE_HOST',
    'PLANE_API_KEY',
    'PLANE_WORKSPACE_SLUG',
  ];

  const missing = validateEnv(required);
  if (missing.length > 0) {
    log.error(`Missing environment variables: ${missing.join(', ')}`);
    log.dim('Copy .env.example to .env and fill in all values');
    process.exit(1);
  }

  // Read optional configuration
  const jiraRateLimit = envInt('JIRA_RATE_LIMIT', 30);
  const planeRateLimit = envInt('PLANE_RATE_LIMIT', 60);
  const maxRetries = envInt('MAX_RETRIES', 3);
  const maxAttachmentSizeMb = envInt('MAX_ATTACHMENT_SIZE_MB', 100, 0);

  const migrationConfig: MigrationConfig = {
    maxRetries,
    maxAttachmentSizeMb,
  };

  // Show active configuration
  log.dim(`  Jira rate limit: ${jiraRateLimit} req/min`);
  log.dim(`  Plane rate limit: ${planeRateLimit} req/min`);
  log.dim(`  Max retries: ${maxRetries}`);
  log.dim(`  Max attachment size: ${maxAttachmentSizeMb}MB`);

  // Initialize clients (env vars guaranteed present by validateEnv above)
  const jiraHost = requireEnv('JIRA_HOST');
  const jiraEmail = requireEnv('JIRA_EMAIL');
  const jiraApiToken = requireEnv('JIRA_API_TOKEN');
  const planeHost = requireEnv('PLANE_HOST');
  const planeApiKey = requireEnv('PLANE_API_KEY');
  const planeWorkspaceSlug = requireEnv('PLANE_WORKSPACE_SLUG');

  const jira = new JiraClient({
    host: jiraHost,
    email: jiraEmail,
    apiToken: jiraApiToken,
    rateLimiter: new RateLimiter(jiraRateLimit),
    maxRetries,
  });

  const plane = new PlaneClient({
    host: planeHost,
    apiKey: planeApiKey,
    workspaceSlug: planeWorkspaceSlug,
    rateLimiter: new RateLimiter(planeRateLimit),
    maxRetries,
  });

  // ── Select Jira project ──────────────────────────────────────────────
  const projectKey = flags['project-key'] ?? (await selectJiraProject(jira));

  // ── Select Plane project ─────────────────────────────────────────────
  const planeProjectId = flags['plane-project'] ?? (await selectPlaneProject(plane));

  // ── Run migration ────────────────────────────────────────────────────
  await runMigration({
    jira,
    plane,
    projectKey,
    planeProjectId,
    dryRun,
    reimport,
    config: migrationConfig,
    usersFile,
    stateMappingFile,
  });
}

// ─── Interactive Selection ───────────────────────────────────────────────────

async function selectJiraProject(jira: JiraClient): Promise<string> {
  log.heading('Jira Projects');
  const jiraProjects = await jira.listProjects();

  if (jiraProjects.length === 0) {
    log.error('No Jira projects found');
    process.exit(1);
  }

  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message: 'Select a Jira project to migrate from:',
      choices: jiraProjects.map((p) => ({
        name: `${p.key} — ${p.name}`,
        value: p.key,
      })),
    },
  ]);

  return selected;
}

async function selectPlaneProject(plane: PlaneClient): Promise<string> {
  log.heading('Plane Projects');
  const planeProjects = await plane.listProjects();

  if (planeProjects.length === 0) {
    log.error('No Plane projects found');
    process.exit(1);
  }

  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message: 'Select a Plane project to migrate to:',
      choices: planeProjects.map((p) => ({
        name: `${p.identifier} — ${p.name}`,
        value: p.id,
      })),
    },
  ]);

  return selected;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

try {
  await main();
} catch (err: unknown) {
  log.error(err instanceof Error ? err.message : String(err));

  if (process.env.DEBUG === '1' && err instanceof Error) {
    console.error(err.stack);
  }

  process.exit(1);
}
