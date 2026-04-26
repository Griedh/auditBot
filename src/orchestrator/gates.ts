import { execCommand } from "../utils/exec.js";
import type { PolicyConfig } from "../config/schema.js";

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

interface ChangeSummary {
  filesChanged: number;
  linesChanged: number;
  changedFiles: string[];
}

async function collectWorkingTreeChanges(repoPath: string): Promise<ChangeSummary> {
  const numstat = await execCommand("git", ["diff", "--numstat"], repoPath);
  if (numstat.code !== 0) {
    throw new Error(`Unable to collect git diff numstat: ${numstat.stderr || numstat.stdout}`);
  }

  let filesChanged = 0;
  let linesChanged = 0;

  for (const line of numstat.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [addedRaw, removedRaw] = line.split("\t");
    const added = addedRaw === "-" ? 0 : Number(addedRaw);
    const removed = removedRaw === "-" ? 0 : Number(removedRaw);
    filesChanged += 1;
    linesChanged += (Number.isFinite(added) ? added : 0) + (Number.isFinite(removed) ? removed : 0);
  }

  const names = await execCommand("git", ["diff", "--name-only"], repoPath);
  if (names.code !== 0) {
    throw new Error(`Unable to collect changed file names: ${names.stderr || names.stdout}`);
  }

  const changedFiles = names.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return { filesChanged, linesChanged, changedFiles };
}

function normalizePathPrefix(pathPrefix: string): string {
  return pathPrefix.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\\/g, "/");
}

export function inForbiddenPath(filePath: string, forbiddenPaths: string[]): boolean {
  const normalizedFilePath = normalizePathPrefix(filePath);
  return forbiddenPaths.some((forbiddenPath) => {
    const normalizedForbiddenPath = normalizePathPrefix(forbiddenPath);
    return normalizedForbiddenPath.length > 0 && (
      normalizedFilePath === normalizedForbiddenPath
      || normalizedFilePath.startsWith(`${normalizedForbiddenPath}/`)
    );
  });
}

export async function evaluateChangePolicyGates(repoPath: string, config: PolicyConfig): Promise<GateResult> {
  const changes = await collectWorkingTreeChanges(repoPath);

  if (typeof config.maxFilesChanged === "number" && changes.filesChanged > config.maxFilesChanged) {
    return {
      allowed: false,
      reason: `maxFilesChanged exceeded: ${changes.filesChanged} > ${config.maxFilesChanged}`
    };
  }

  if (typeof config.maxLinesChanged === "number" && changes.linesChanged > config.maxLinesChanged) {
    return {
      allowed: false,
      reason: `maxLinesChanged exceeded: ${changes.linesChanged} > ${config.maxLinesChanged}`
    };
  }

  const forbiddenFile = changes.changedFiles.find((filePath) => inForbiddenPath(filePath, config.forbiddenPaths));
  if (forbiddenFile) {
    return {
      allowed: false,
      reason: `changed file '${forbiddenFile}' violates forbiddenPaths policy`
    };
  }

  return { allowed: true };
}

export function shouldCreateDraftPr(config: PolicyConfig): boolean {
  return config.stagedApprovals.enabled;
}

export function shouldPromoteDraft(config: PolicyConfig, checksPass: boolean): boolean {
  return config.stagedApprovals.enabled && config.stagedApprovals.readyForReviewOnChecksPass && checksPass;
}
