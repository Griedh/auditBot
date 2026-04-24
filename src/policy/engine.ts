import type { Finding } from "../models/finding.js";
import type { FixCandidate } from "../fixers/types.js";
import type { PolicyConfig } from "../config/schema.js";

export interface PolicySelectionResult {
  allowedCandidates: FixCandidate[];
  skipped: Array<{ findingId: string; reason: string }>;
}

function normalizePathPrefix(pathPrefix: string): string {
  return pathPrefix.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\\/g, "/");
}

function pathBlocked(filePath: string, forbiddenPaths: string[]): boolean {
  const normalizedPath = normalizePathPrefix(filePath);
  return forbiddenPaths.some((forbiddenPath) => {
    const normalizedPrefix = normalizePathPrefix(forbiddenPath);
    return normalizedPrefix.length > 0 && normalizedPath.startsWith(normalizedPrefix);
  });
}

export function selectCandidatesByPolicy(
  candidates: FixCandidate[],
  findingsById: Map<string, Finding>,
  config: PolicyConfig
): PolicySelectionResult {
  const skipped: Array<{ findingId: string; reason: string }> = [];
  const allowedCandidates: FixCandidate[] = [];

  for (const candidate of candidates) {
    if (!config.allowedFixCategories.includes(candidate.category)) {
      skipped.push({
        findingId: candidate.findingId,
        reason: `category '${candidate.category}' is not allowed by policy`
      });
      continue;
    }

    const finding = findingsById.get(candidate.findingId);
    if (!finding) {
      skipped.push({ findingId: candidate.findingId, reason: "candidate finding metadata was not found" });
      continue;
    }

    if (finding.confidence < config.requiredConfidenceThreshold) {
      skipped.push({
        findingId: candidate.findingId,
        reason: `confidence ${finding.confidence.toFixed(2)} < threshold ${config.requiredConfidenceThreshold.toFixed(2)}`
      });
      continue;
    }

    const blockedPath = candidate.touches?.find((filePath) => pathBlocked(filePath, config.forbiddenPaths));
    if (blockedPath) {
      skipped.push({
        findingId: candidate.findingId,
        reason: `target path '${blockedPath}' matches forbidden path policy`
      });
      continue;
    }

    allowedCandidates.push(candidate);
  }

  return { allowedCandidates, skipped };
}
