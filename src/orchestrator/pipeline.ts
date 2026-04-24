import type { Finding, RunReport } from "../models/finding.js";
import { ensureDir } from "../utils/fs.js";
import { stableId } from "../utils/hash.js";
import { DependencyScanner } from "../scanners/dependencyScanner.js";
import { PolicyScanner } from "../scanners/policyScanner.js";
import { StaticScanner } from "../scanners/staticScanner.js";
import { persistArtifacts } from "../reporting/persistArtifacts.js";
import { detectRepositoryLayout } from "./detection.js";
import { prepareWorkspace } from "./repository.js";

export async function runPipeline(repoInput: string, artifactsRoot: string): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const workspace = await prepareWorkspace(repoInput);
  const layout = await detectRepositoryLayout(workspace.workspacePath);

  const scanners = [new DependencyScanner(), new StaticScanner(), new PolicyScanner()];

  const findings: Finding[] = [];
  const logs: string[] = [];

  for (const scanner of scanners) {
    const scannerFindings = await scanner.run({
      repoPath: workspace.workspacePath,
      packageManager: layout.packageManager
    });
    findings.push(...scannerFindings);
    logs.push(`${scanner.name}: ${scannerFindings.length} finding(s)`);
  }

  findings.sort((a, b) => a.id.localeCompare(b.id));

  const finishedAt = new Date().toISOString();
  const runId = stableId([workspace.source, startedAt]);
  const runDir = `${artifactsRoot}/${runId}`;
  await ensureDir(runDir);

  const artifacts = await persistArtifacts({
    runDir,
    findings,
    logs,
    source: workspace.source,
    workspacePath: workspace.workspacePath,
    layout,
    startedAt,
    finishedAt,
    runId
  });

  return {
    ...artifacts,
    runId,
    startedAt,
    finishedAt,
    source: workspace.source,
    workspacePath: workspace.workspacePath,
    packageManager: layout.packageManager,
    monorepo: layout.monorepo,
    workspaces: layout.workspaces,
    findings
  };
}
