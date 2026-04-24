export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AutofixLevel = "none" | "safe" | "risky";

export interface PatchMetadata {
  strategy: "none" | "manual" | "dependency-upgrade" | "codemod" | "eslint-fix";
  targetVersion?: string;
  patchPreview?: string;
}

export interface Finding {
  id: string;
  scanner: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  file?: string;
  confidence: number;
  autofix: AutofixLevel;
  patchMetadata: PatchMetadata;
  raw?: unknown;
}

export interface FixEngineMetadata {
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
  commitMessage?: string;
  prUrl?: string;
  mrUrl?: string;
  skipped?: string;
  appliedFindingIds: string[];
  summaryTable: string;
  beforeArtifact: string;
  afterArtifact: string;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  source: string;
  workspacePath: string;
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
  monorepo: boolean;
  workspaces: string[];
  findings: Finding[];
  fixEngine: FixEngineMetadata;
  logsFile: string;
  markdownFile: string;
  diffPreviewFile: string;
}
