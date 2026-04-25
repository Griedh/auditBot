import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Finding } from "../models/finding.js";
import { createDeterministicBranch, buildCommitMessage, commitAll, diffStat, getCurrentBranch, getDefaultRemote, getRepositorySlug, hasWorkingTreeChanges, pushBranch } from "../git/client.js";
import { loadPolicyConfig } from "../config/schema.js";
import { DependencyPinFixer } from "../fixers/dependencyPinFixer.js";
import { EslintFixer } from "../fixers/eslintFixer.js";
import type { FixCandidate, RuleFixer } from "../fixers/types.js";
import { selectCandidatesByPolicy } from "../policy/engine.js";
import { createGithubPullRequest, markGithubPullRequestReady } from "../providers/github.js";
import { createGitlabMergeRequest } from "../providers/gitlab.js";
import { readJson } from "../utils/fs.js";
import { execCommand } from "../utils/exec.js";
import { evaluateChangePolicyGates, shouldCreateDraftPr, shouldPromoteDraft } from "./gates.js";

export interface FixEngineResult {
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
  commitMessage?: string;
  prUrl?: string;
  mrUrl?: string;
  draftPr?: boolean;
  skipped?: string;
  appliedFindingIds: string[];
  summaryTable: string;
  beforeArtifact: string;
  afterArtifact: string;
}

interface FixEngineInput {
  repoPath: string;
  runId: string;
  findings: Finding[];
  runDir: string;
  requireHumanReview?: boolean;
}

function getFixers(): RuleFixer[] {
  return [new DependencyPinFixer(), new EslintFixer()];
}

interface PackageJson {
  scripts?: Record<string, string>;
}

async function testsPassIfConfigured(repoPath: string): Promise<GateResult> {
  const pkg = await readJson<PackageJson>(path.join(repoPath, "package.json"));
  const testScript = pkg?.scripts?.test;
  if (!testScript) {
    return { allowed: true };
  }

  const result = await execCommand("npm", ["run", "test"], repoPath);
  if (result.code !== 0) {
    return { allowed: false, reason: "Test command failed after applying fixes" };
  }

  return { allowed: true };
}

interface GateResult {
  allowed: boolean;
  reason?: string;
}

function markdownTable(candidates: FixCandidate[], applied: Set<string>): string {
  const header = "| Finding ID | Summary | Risk | Applied |\n|---|---|---|---|";
  const rows = candidates.map((candidate) => {
    const appliedState = applied.has(candidate.findingId) ? "yes" : "no";
    return `| ${candidate.findingId} | ${candidate.summary} | ${candidate.risk} | ${appliedState} |`;
  });

  return [header, ...rows].join("\n");
}

function providerFromRemote(url: string): "github" | "gitlab" | "unknown" {
  if (url.includes("github.com")) return "github";
  if (url.includes("gitlab")) return "gitlab";
  return "unknown";
}

function buildReviewBody(summaryTable: string, beforeArtifact: string, afterArtifact: string): string {
  return [
    "## Auto-fix summary",
    "",
    summaryTable,
    "",
    "## Risk label",
    "`risk:safe-autofix`",
    "",
    "## Rollback guidance",
    "- Revert commit in this branch: `git revert <commit-sha>`.",
    "- Or close this PR/MR and delete the branch if fix scope is not acceptable.",
    "",
    "## Artifacts",
    `- Before: ${beforeArtifact}`,
    `- After: ${afterArtifact}`,
    "",
    "## Merge guardrail",
    "- Auto-merge is disabled. Human review is required unless explicitly configured."
  ].join("\n");
}

export async function runFixEngine(input: FixEngineInput): Promise<FixEngineResult> {
  const policyConfig = await loadPolicyConfig(input.repoPath);
  const safeFindings = input.findings.filter((finding) => finding.autofix === "safe");

  const fixers = getFixers();
  const candidates: FixCandidate[] = [];

  for (const finding of safeFindings) {
    const fixer = fixers.find((ruleFixer) => ruleFixer.supports(finding));
    if (!fixer) continue;

    const candidate = fixer.buildCandidate(finding);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const safeCandidates = candidates.filter((candidate) => candidate.risk === "safe");
  const findingsById = new Map<string, Finding>(input.findings.map((finding) => [finding.id, finding]));
  const policySelection = selectCandidatesByPolicy(safeCandidates, findingsById, policyConfig);
  const beforeArtifact = path.join(input.runDir, "fixes-before.txt");
  const afterArtifact = path.join(input.runDir, "fixes-after.txt");
  await writeFile(
    beforeArtifact,
    policySelection.allowedCandidates.map((candidate) => `${candidate.findingId}: ${candidate.summary}`).join("\n"),
    "utf8"
  );

  if (policySelection.allowedCandidates.length === 0) {
    await writeFile(afterArtifact, "No safe candidates generated.", "utf8");
    return {
      skipped:
        policySelection.skipped.length > 0
          ? `Policy blocked all autofix candidates: ${policySelection.skipped.map((entry) => `${entry.findingId} (${entry.reason})`).join("; ")}`
          : "No safe autofix candidates available",
      appliedFindingIds: [],
      summaryTable: markdownTable(candidates, new Set<string>()),
      beforeArtifact,
      afterArtifact
    };
  }

  if (policyConfig.dryRun) {
    await writeFile(afterArtifact, "Dry run mode enabled in policy config. No code changes were applied.", "utf8");
    return {
      skipped: "Dry-run mode enabled by policy",
      appliedFindingIds: [],
      summaryTable: markdownTable(candidates, new Set<string>()),
      beforeArtifact,
      afterArtifact
    };
  }

  const baseBranch = await getCurrentBranch(input.repoPath);
  const branch = await createDeterministicBranch(input.repoPath, input.runId, "safe");
  const appliedFindingIds = new Set<string>();
  const commitsByCategory: Array<{ category: string; commitSha: string; findingIds: string[]; commitMessage: string }> = [];
  const candidatesByCategory = new Map<string, FixCandidate[]>();
  for (const candidate of policySelection.allowedCandidates) {
    const grouped = candidatesByCategory.get(candidate.category) ?? [];
    grouped.push(candidate);
    candidatesByCategory.set(candidate.category, grouped);
  }

  for (const [category, categoryCandidates] of candidatesByCategory.entries()) {
    const categoryAppliedIds: string[] = [];
    for (const candidate of categoryCandidates) {
      const changed = await candidate.apply(input.repoPath);
      if (changed) {
        appliedFindingIds.add(candidate.findingId);
        categoryAppliedIds.push(candidate.findingId);
      }
    }

    if (!(await hasWorkingTreeChanges(input.repoPath))) {
      continue;
    }

    const gateResult = await evaluateChangePolicyGates(input.repoPath, policyConfig);
    if (!gateResult.allowed) {
      await writeFile(afterArtifact, gateResult.reason ?? "Change gates blocked update", "utf8");
      return {
        skipped: gateResult.reason ?? "Policy gate blocked changes",
        branch,
        baseBranch,
        appliedFindingIds: [...appliedFindingIds],
        summaryTable: markdownTable(candidates, appliedFindingIds),
        beforeArtifact,
        afterArtifact
      };
    }

    const testGateResult = await testsPassIfConfigured(input.repoPath);
    if (!testGateResult.allowed) {
      await writeFile(afterArtifact, testGateResult.reason ?? "Test gate failed", "utf8");
      return {
        skipped: testGateResult.reason ?? "Test gate failed",
        branch,
        baseBranch,
        appliedFindingIds: [...appliedFindingIds],
        summaryTable: markdownTable(candidates, appliedFindingIds),
        beforeArtifact,
        afterArtifact
      };
    }

    const commitMessage = buildCommitMessage(categoryAppliedIds);
    const commitSha = await commitAll(input.repoPath, commitMessage);
    commitsByCategory.push({ category, commitSha, findingIds: categoryAppliedIds, commitMessage });
  }

  if (commitsByCategory.length === 0) {
    await writeFile(afterArtifact, "Safe fixes produced no repository changes.", "utf8");
    return {
      skipped: "Safe fixes produced no repository changes",
      branch,
      baseBranch,
      appliedFindingIds: [],
      summaryTable: markdownTable(candidates, appliedFindingIds),
      beforeArtifact,
      afterArtifact
    };
  }

  const commitSha = commitsByCategory[commitsByCategory.length - 1]?.commitSha;
  const commitMessage = commitsByCategory.map((entry) => `${entry.category}: ${entry.commitMessage}`).join("\n\n");
  const diffSummary = await diffStat(input.repoPath);
  await writeFile(afterArtifact, diffSummary, "utf8");

  const remote = await getDefaultRemote(input.repoPath);
  if (!remote) {
    return {
      skipped: "No git remote configured",
      branch,
      baseBranch,
      commitSha,
      commitMessage,
      appliedFindingIds: [...appliedFindingIds],
      summaryTable: markdownTable(candidates, appliedFindingIds),
      beforeArtifact,
      afterArtifact
    };
  }

  await pushBranch(input.repoPath, branch, remote.remoteName);

  const repository = await getRepositorySlug(input.repoPath);
  const summaryTable = markdownTable(candidates, appliedFindingIds);
  const checksPassed = process.env.AUDITBOT_CHECKS_PASSED === "true";
  const draftPr = shouldCreateDraftPr(policyConfig);
  const prBody = buildReviewBody(summaryTable, beforeArtifact, afterArtifact);
  const provider = providerFromRemote(remote.url);

  if (provider === "github" && repository) {
    const pr = await createGithubPullRequest({
      repository,
      title: `auditBot safe autofix ${input.runId}`,
      body: prBody,
      head: branch,
      base: baseBranch,
      labels: ["risk:safe-autofix", "autofix"],
      requireHumanReview: input.requireHumanReview ?? true,
      draft: draftPr
    });

    if (!pr.skipped && pr.number && shouldPromoteDraft(policyConfig, checksPassed)) {
      await markGithubPullRequestReady(repository, pr.number);
    }

    return {
      branch,
      baseBranch,
      commitSha,
      commitMessage,
      prUrl: pr.url,
      draftPr,
      skipped: pr.skipped ? pr.reason : undefined,
      appliedFindingIds: [...appliedFindingIds],
      summaryTable,
      beforeArtifact,
      afterArtifact
    };
  }

  if (provider === "gitlab" && repository) {
    const mr = await createGitlabMergeRequest({
      projectPath: repository,
      title: `auditBot safe autofix ${input.runId}`,
      description: prBody,
      sourceBranch: branch,
      targetBranch: baseBranch,
      labels: ["risk:safe-autofix", "autofix"],
      requireHumanReview: input.requireHumanReview ?? true,
      draft: draftPr
    });

    return {
      branch,
      baseBranch,
      commitSha,
      commitMessage,
      mrUrl: mr.url,
      draftPr,
      skipped: mr.skipped ? mr.reason : undefined,
      appliedFindingIds: [...appliedFindingIds],
      summaryTable,
      beforeArtifact,
      afterArtifact
    };
  }

  return {
    branch,
    baseBranch,
    commitSha,
    commitMessage,
    skipped: `Unsupported git provider remote: ${remote.url}`,
    appliedFindingIds: [...appliedFindingIds],
    summaryTable,
    beforeArtifact,
    afterArtifact
  };
}
