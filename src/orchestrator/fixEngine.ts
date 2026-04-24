import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Finding } from "../models/finding.js";
import { createDeterministicBranch, buildCommitMessage, commitAll, diffStat, getCurrentBranch, getDefaultRemote, getRepositorySlug, hasWorkingTreeChanges, pushBranch } from "../git/client.js";
import { DependencyPinFixer } from "../fixers/dependencyPinFixer.js";
import { EslintFixer } from "../fixers/eslintFixer.js";
import { PrivatePackageFixer } from "../fixers/privatePackageFixer.js";
import type { FixCandidate, RuleFixer } from "../fixers/types.js";
import { createGithubPullRequest } from "../providers/github.js";
import { createGitlabMergeRequest } from "../providers/gitlab.js";

export interface FixEngineResult {
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

interface FixEngineInput {
  repoPath: string;
  runId: string;
  findings: Finding[];
  runDir: string;
  requireHumanReview?: boolean;
}

function getFixers(): RuleFixer[] {
  return [new DependencyPinFixer(), new PrivatePackageFixer(), new EslintFixer()];
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
  const safeFindings = input.findings.filter((finding) => finding.autofix === "safe");
  const riskyFindings = input.findings.filter((finding) => finding.autofix === "risky");

  const fixers = getFixers();
  const candidates: FixCandidate[] = [];

  for (const finding of [...safeFindings, ...riskyFindings]) {
    const fixer = fixers.find((ruleFixer) => ruleFixer.supports(finding));
    if (!fixer) continue;

    const candidate = fixer.buildCandidate(finding);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const safeCandidates = candidates.filter((candidate) => candidate.risk === "safe");
  const beforeArtifact = path.join(input.runDir, "fixes-before.txt");
  const afterArtifact = path.join(input.runDir, "fixes-after.txt");
  await writeFile(beforeArtifact, safeCandidates.map((candidate) => `${candidate.findingId}: ${candidate.summary}`).join("\n"), "utf8");

  if (safeCandidates.length === 0) {
    await writeFile(afterArtifact, "No safe candidates generated.", "utf8");
    return {
      skipped: "No safe autofix candidates available",
      appliedFindingIds: [],
      summaryTable: markdownTable(candidates, new Set<string>()),
      beforeArtifact,
      afterArtifact
    };
  }

  const baseBranch = await getCurrentBranch(input.repoPath);
  const branch = await createDeterministicBranch(input.repoPath, input.runId, "safe");
  const appliedFindingIds = new Set<string>();

  for (const candidate of safeCandidates) {
    const changed = await candidate.apply(input.repoPath);
    if (changed) {
      appliedFindingIds.add(candidate.findingId);
    }
  }

  if (!(await hasWorkingTreeChanges(input.repoPath))) {
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

  const commitMessage = buildCommitMessage([...appliedFindingIds]);
  const commitSha = await commitAll(input.repoPath, commitMessage);
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
      requireHumanReview: input.requireHumanReview ?? true
    });

    return {
      branch,
      baseBranch,
      commitSha,
      commitMessage,
      prUrl: pr.url,
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
      requireHumanReview: input.requireHumanReview ?? true
    });

    return {
      branch,
      baseBranch,
      commitSha,
      commitMessage,
      mrUrl: mr.url,
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
