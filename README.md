# ✈ plane-jira-importer

Migrate issues from **Jira Cloud** to **[Plane](https://plane.so)** (self-hosted).

Interactive CLI that handles the full migration: issues, descriptions, comments, attachments, priorities, statuses, labels, assignees, and parent-child relationships.

Written in **TypeScript** with full type safety, built for reliability at scale.

## Features

- **Interactive project selection** — pick source (Jira) and target (Plane) projects from a list
- **Full issue migration** — title, HTML description, priority, status, labels, assignees, dates
- **Comment migration** — preserves author attribution and timestamps
- **Attachment migration** — downloads from Jira and uploads to Plane (3-step presigned upload)
- **Status → State mapping** — use a reusable JSON file or map interactively (auto-matches by name)
- **User mapping** — use a reusable JSON file or map interactively (auto-matches by email)
- **Original attribution** — preserves Jira reporters and unmapped assignees in descriptions
- **Issue type labels** — creates "Jira: Bug", "Jira: Story", etc. labels in Plane
- **Priority mapping** — Highest→urgent, High→high, Medium→medium, Low/Lowest→low
- **Parent-child relationships** — preserves sub-task hierarchy
- **Incremental migration** — tracks migrated issues via `external_id` to avoid duplicates
- **Dry run mode** — preview what would be migrated without making changes
- **Jira reference links** — each migrated issue includes a link back to the original Jira issue

### Reliability & Scale

- **Retry with exponential backoff** — transient failures (5xx, 429, network errors) are automatically retried with jitter
- **Rate limiting on both APIs** — configurable request-per-minute limits for Jira and Plane
- **Per-issue error isolation** — one failed issue doesn't stop the entire migration
- **Fault-tolerant comments & attachments** — individual failures are logged and skipped, not fatal
- **Attachment size limits** — skip oversized files before downloading to avoid OOM
- **Retry-After support** — respects HTTP 429 `Retry-After` headers from both APIs
- **Structured summary report** — clear end-of-run report with counts, failures, and duration

## Prerequisites

- Node.js 22.21+ for source development, builds, and tests (see `.mise.toml`)
- The built CLI supports Node.js 18+; use Node.js 22.21+ when a proxy is required
- Jira Cloud account with API token
- Plane instance with API key

Node.js 18 emits an experimental File API warning during attachment uploads.
Use Node.js 22.21+ to avoid this warning.

## Setup

```bash
# Clone or copy the project
cd plane-jira-importer

# Install dependencies
npm install

# Configure credentials
cp .env.example .env
# Edit .env with your credentials
```

### HTTP proxies

Requests use Node.js native `fetch`. To use `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY`, run with Node.js 22.21+ and enable proxy support when starting Node:

```bash
NODE_USE_ENV_PROXY=1 npm start
# Or run the built CLI:
NODE_USE_ENV_PROXY=1 node dist/index.js
```

Older Node.js versions cannot use these proxy settings with this importer.
Node.js 22.22.3 emits an experimental EnvHttpProxyAgent warning with this option.

### Getting Jira credentials

1. Go to [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Create a new API token
3. Note your Jira host (e.g., `your-company.atlassian.net`)
4. Use the email associated with your Atlassian account

### Getting Plane credentials

1. Go to your Plane instance → Settings → API Tokens
2. Create a new API token
3. Note your workspace slug from the URL (e.g., `https://plane.example.com/my-workspace/` → `my-workspace`)

### Environment variables

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `JIRA_HOST` | Jira Cloud hostname (without `https://`) | `acme.atlassian.net` |
| `JIRA_EMAIL` | Email for Jira authentication | `you@acme.com` |
| `JIRA_API_TOKEN` | Jira API token | `abc123...` |
| `PLANE_HOST` | Full URL of your Plane instance | `https://plane.acme.com` |
| `PLANE_API_KEY` | Plane API key | `pl_...` |
| `PLANE_WORKSPACE_SLUG` | Plane workspace slug | `acme` |

#### Optional tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `JIRA_RATE_LIMIT` | `30` | Jira API requests per minute |
| `PLANE_RATE_LIMIT` | `60` | Plane API requests per minute |
| `MAX_RETRIES` | `3` | Retry attempts for transient API failures |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | Skip attachments larger than this (MB) |
| `DEBUG` | — | Set to `1` for full error stack traces |

## Usage

### Interactive mode (recommended)

```bash
npm start
```

The tool will:
1. List your Jira projects — pick one
2. List your Plane projects — pick one
3. Show Jira statuses — map each to a Plane state
4. Show Jira assignees — map each to a Plane member
5. Run the migration with progress reporting

### Non-interactive mode

```bash
# Supply projects and both mapping files to run without prompts
npm start -- --project-key MYPROJ --plane-project <plane-project-uuid> \
  --users-file data/users.json --state-mapping-file data/states.json

# Preview without making changes
npm start -- --dry-run

# Preview the same file-based migration
npm start -- --project-key MYPROJ --plane-project <uuid> \
  --users-file data/users.json --state-mapping-file data/states.json --dry-run
```

### Mapping files

Store local mapping files in `data/`, which is ignored by Git because user files contain personal information.

`data/users.json` maps Jira account IDs to member emails in the selected Plane project:

```json
{
  "jira-account-id": { "email": "alice@example.com" },
  "former-user-account-id": { "email": null }
}
```

Emails match without regard to case. Destination users must be active, assignable members of the selected project. Missing entries, `null` emails, and emails with no project member leave the user unmapped and produce a count warning. Unmapped assignees retain their original Jira name and email (when Jira provides it) in the description. The importer clears any project default assignee applied during creation. Reporters are always preserved there; Plane's native creator remains the API user. Optional `display_name` and other metadata from existing user files are accepted; only `email` selects the Plane member.

`data/states.json` maps exact Jira status names to Plane state names or IDs:

```json
{
  "mapping": {
    "To Do": "Backlog",
    "In Progress": "state-uuid",
    "Done": "Completed"
  }
}
```

Plane state names match without regard to case; use an ID for duplicate names. Every status encountered must have a valid target in the selected project. Missing, `null`, unknown, or ambiguous targets fail before writes. Malformed files also fail before migration. You can supply just one file and select the remaining mappings interactively.

### CLI flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview migration without creating anything in Plane |
| `--reimport` | Update all previously migrated issues (skips the interactive prompt) |
| `--project-key KEY` | Skip Jira project selection, use this project key |
| `--plane-project ID` | Skip Plane project selection, use this project UUID |
| `--users-file PATH` | Load Jira account ID to Plane member email mappings from JSON |
| `--state-mapping-file PATH` | Load Jira status to Plane state name or ID mappings from JSON |

## What gets migrated

| Jira | Plane | Notes |
|------|-------|-------|
| Summary | Work item name | |
| Description (HTML) | `description_html` | Rendered HTML from Jira |
| Status | State | Mapped by file or interactively |
| Priority | Priority | Highest→urgent, High→high, Medium→medium, Low/Lowest→low |
| Assignee | Assignees | Mapped by file or interactively; original attribution retained when unmapped |
| Reporter | Description | Original Jira name and email when available |
| Issue type | Label | Created as "Jira: Bug", "Jira: Story", etc. |
| Due date | Target date | |
| Start date | Start date | From `customfield_10015` if available |
| Parent/sub-task | Parent link | Preserves hierarchy |
| Comments | Comments | Includes "Originally by {author} on {date}:" prefix |
| Attachments | Attachments | Downloaded from Jira, uploaded to Plane storage |
| Issue key | Reference link | Added to description as a link back to Jira |

### What's NOT migrated

- Custom fields (beyond start date)
- Watchers / followers
- Sprint information
- Workflow transitions / history
- Time tracking

## Error handling

The tool is designed to be resilient:

- **Transient API errors** (5xx, 429, network timeouts) are retried with exponential backoff and jitter. The `Retry-After` header is respected when present.
- **Per-issue isolation** — if one issue fails to migrate (e.g., a persistent API error), the tool logs the failure and continues with the remaining issues.
- **Comment & attachment failures** are handled individually — a failed attachment won't prevent other attachments or comments from being migrated on the same issue.
- **Attachment size limits** — files exceeding `MAX_ATTACHMENT_SIZE_MB` are skipped before downloading, avoiding unnecessary bandwidth and memory usage.

At the end of each run, a summary report shows exactly what succeeded, what failed, and why:

```
══════════════════════════════════════════════════
  Migration Summary
══════════════════════════════════════════════════
  Total issues:           60
  ✓ Migrated:             57
  ○ Skipped (existing):   3
  
  Comments migrated:      142
  Attachments migrated:   23
  Attachments skipped:    2 (size limit)
  
  Duration:               4m 32s
══════════════════════════════════════════════════
```

## Incremental migration

The tool tracks which issues have been migrated using `external_id` (Jira issue key) and `external_source` ("jira-importer"). Running the tool again on the same project will prompt you to choose:

- **Import new only** — skip previously migrated issues, only create new ones
- **Update all** — update existing migrated issues with the latest Jira data and import any new ones (comments and attachments are also de-duplicated)

With both mapping files, reruns skip existing issues without prompting. Pass `--reimport` to update all, including their mapping and attribution. Updates clear the Plane assignee when the Jira assignee is unmapped or absent.

This makes it safe to re-run after failures — already-migrated issues won't be duplicated, and you can update them if the source data changed.

## Development

### Quick start

```bash
# Run in development mode (tsx with watch)
npm run dev

# Run once
npm start

# Dry run
npm start -- --dry-run
```

### Building

```bash
# Build with tsup (ESM output with declarations)
npm run build

# Clean build artifacts
npm run clean
```

### Testing

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch
```

### Type checking

```bash
npm run typecheck
```

### Linting & formatting

```bash
# Lint
npm run lint

# Lint and auto-fix
npm run lint:fix

# Format with Prettier
npm run format
```

## Project structure

```
src/
├── index.ts              # CLI entry point
├── types/
│   ├── jira.ts           # Jira API response types
│   ├── plane.ts          # Plane API response types
│   └── config.ts         # Configuration & CLI types
├── clients/
│   ├── jira.ts           # Jira Cloud API client (rate-limited + retry)
│   └── plane.ts          # Plane API client (rate-limited + retry)
├── services/
│   ├── mapper.ts         # Priority/status/user mapping
│   └── migrator.ts       # Migration orchestrator
└── utils/
    ├── logger.ts         # Coloured console logger
    ├── rate-limiter.ts   # Token-bucket rate limiter
    ├── retry.ts          # Exponential backoff retry with jitter
    └── helpers.ts        # CLI args, date/size formatting, etc.

tests/
├── helpers.test.ts       # Utility function tests
├── rate-limiter.test.ts  # Rate limiter tests
├── retry.test.ts         # Retry utility tests
├── mapper.test.ts        # Mapping logic tests
├── jira-client.test.ts   # Jira client tests
└── plane-client.test.ts  # Plane client tests
```

## Troubleshooting

### "Missing environment variables"
Copy `.env.example` to `.env` and fill in all values.

### "Jira API error 401"
Check your `JIRA_EMAIL` and `JIRA_API_TOKEN`. The token may have expired.

### "Jira API error 410"
The Jira search endpoint was updated. Make sure you're running the latest version of this tool which uses `/rest/api/3/search/jql`.

### "Plane API error 401"
Check your `PLANE_API_KEY`. Ensure it has workspace-level permissions.

### "Plane API error 429"
The rate limiter should handle this automatically. If you see repeated 429 errors, try lowering `PLANE_RATE_LIMIT` (e.g., `30`).

### Large migrations (1000+ issues)
- Expect ~2-3 seconds per issue due to rate limiting
- The tool is fault-tolerant: if it crashes or is interrupted, re-run it and it will skip already-migrated issues
- Consider lowering rate limits if you see frequent retries
- Set `MAX_ATTACHMENT_SIZE_MB` to skip very large files

## License

MIT — see [LICENSE](LICENSE).
