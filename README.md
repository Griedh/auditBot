# auditBot

CLI-first TypeScript service for deterministic repository audits.

## Features

- Monorepo package layout with dedicated CLI, core orchestration, and provider integrations.
- Isolated workspace setup from a git URL or local path.
- Package manager/workspace layout detection (`npm`, `yarn`, `pnpm`, monorepo signals).
- Read-only scanners (with guarded autofix metadata):
  - dependency vulnerabilities
  - lint/static check pass/fail signal
  - custom policy checks
- Guarded fix engine: applies only `autofix: safe` findings in deterministic temp branches.

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
node packages/cli/dist/index.js run --repo <url|path> --provider github --dry-run
```

The CLI prints final run metadata as JSON and writes traceable artifacts into `--out/<runId>/`.
