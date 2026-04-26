# auditBot

CLI-first TypeScript service for deterministic repository audits.

## Features

- Monorepo package layout with dedicated CLI, core orchestration, and provider integrations.
- Isolated workspace setup from a git URL or local path.
- Config file support via `auditbot.config.json` in the target repository.
- Package manager/workspace layout detection (`npm`, `yarn`, `pnpm`, monorepo signals).
- Read-only scanners (with guarded autofix metadata):
  - dependency vulnerabilities
  - lint/static check pass/fail signal
  - custom policy checks
- Guarded fix engine: applies only `autofix: safe` findings in deterministic temp branches.
- API retry logic for GitHub/GitLab review creation calls (handles transient `408`, `429`, and `5xx` responses).
- Clear CLI exit codes for automation-friendly CI behavior.

## Packages

- `packages/cli` entrypoint command (`auditbot`).
- `packages/core` orchestration phases and scan/fix pipeline.
- `packages/integrations` GitHub/GitLab review-request adapters.

## Core orchestration phases

`@auditbot/core` now exposes and composes:

- `prepareRepo()`
- `scan()`
- `planFixes()`
- `applyFixes()`
- `createBranchAndPR()`
- `emitReport()`

## Usage

```bash
npm install
npm run build
node packages/cli/dist/index.js run --repo <url|path> [--provider github|gitlab] [--dry-run] [--out <dir>]
```

The CLI prints final run metadata as JSON and writes traceable artifacts into `--out/<runId>/`.

## Configuration (`auditbot.config.json`)

Place `auditbot.config.json` in the target repository root to define defaults:

```json
{
  "provider": "github",
  "dryRun": true,
  "baseBranch": "main",
  "outDir": ".auditbot-runs"
}
```

### Config precedence

1. CLI flags (highest priority).
2. `auditbot.config.json`.
3. Internal defaults (e.g., provider=`github`, dryRun=`false`, baseBranch=`main`).

## Setup tokens

Set only the token required for your provider:

- GitHub: `GITHUB_TOKEN`
- GitLab: `GITLAB_TOKEN`
- Optional GitLab self-managed override: `GITLAB_API_URL`

## Required permissions

### GitHub token

- Pull requests: **Read and write**
- Issues/metadata for labels (if used by your workflow): **Read and write**
- Repository contents for branch operations performed by your CI/runtime: **Read and write**

### GitLab token

- API scope sufficient to create merge requests.
- Repository write access for pushing branches from your runtime.

## Supported repository types

- Remote git repositories (HTTPS/SSH/git URLs ending in `.git` or standard git URL forms).
- Local repository paths.
- JavaScript/TypeScript repositories with lockfiles for package manager detection:
  - `package-lock.json` (`npm`)
  - `yarn.lock` (`yarn`)
  - `pnpm-lock.yaml` (`pnpm`)

## Safety defaults

- `--dry-run` (or config `dryRun: true`) performs **no git writes** and skips review request creation.
- Auto-merge is not enabled by default.
- Review requests are created only when a provider token is configured.
- Network review calls use bounded retries with exponential backoff to reduce flaky failures without infinite loops.

## Exit codes

- `0`: success
- `1`: runtime/internal failure
- `2`: invalid CLI usage or arguments
