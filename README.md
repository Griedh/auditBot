# auditBot

CLI-first TypeScript service for deterministic repository audits.

## Features

- Isolated workspace setup from a git URL or local path.
- Package manager/workspace layout detection (`npm`, `yarn`, `pnpm`, monorepo signals).
- Read-only scanners:
  - dependency vulnerabilities
  - lint/static check pass/fail signal
  - custom policy checks
- Unified finding schema in `src/models/finding.ts`.
- Artifact persistence per run (`run.log`, `report.json`, `report.md`, `diff-preview.patch`).

## Structure

- `src/orchestrator/` pipeline orchestration and repository lifecycle.
- `src/scanners/` scanner providers.
- `src/models/finding.ts` normalized findings model.
- `src/reporting/` report rendering and artifact persistence.

## Usage

```bash
npm install
npm run build
node dist/cli.js --repo https://github.com/org/repo.git
# or local path
node dist/cli.js --repo ../some-repo --out ./.auditbot-runs
```

The CLI prints final run metadata as JSON and writes traceable artifacts into `--out/<runId>/`.
