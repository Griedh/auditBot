export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface PatchMetadata {
  strategy: "none" | "manual" | "dependency-upgrade" | "codemod";
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
  autofixable: boolean;
  patchMetadata: PatchMetadata;
  raw?: unknown;
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
  logsFile: string;
  markdownFile: string;
  diffPreviewFile: string;
}
