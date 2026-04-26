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
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
  requireHumanReview?: boolean;
}

function getFixers(): RuleFixer[] {
  return [new DependencyPinFixer(), new EslintFixer()];
}

interface PackageJson {
  scripts?: Record<string, string>;
}

interface TestCommand {
  command: string;
  args: string[];
  display: string;
}

function testCommandForPackageManager(packageManager: FixEngineInput["packageManager"]): TestCommand {
  if (packageManager === "pnpm") {
    return { command: "pnpm", args: ["test"], display: "pnpm test" };
  }

  if (packageManager === "yarn") {
    return { command: "yarn", args: ["test"], display: "yarn test" };
  }

  return { command: "npm", args: ["run", "test"], display: "npm run test" };
}

async function testsPassIfConfigured(repoPath: string, packageManager: FixEngineInput["packageManager"]): Promise<GateResult> {
  const pkg = await readJson<PackageJson>(path.join(repoPath, "package.json"));
  const testScript = pkg?.scripts?.test;
  if (!testScript) {
    return { allowed: true };
  }

  const testCommand = testCommandForPackageManager(packageManager);
  const result = await execCommand(testCommand.command, testCommand.args, repoPath);
  if (result.code !== 0) {
    return { allowed: false, reason: `Test gate failed after applying fixes: ${testCommand.display}` };
  }

  return { allowed: true, reason: `Test gate passed: ${testCommand.display}` };
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

interface ReviewBodyInput {
  detectedCount: number;
  safeCandidateCount: number;
  appliedFindingIds: string[];
  summaryTable: string;
  lintResult: string;
  testResult: string;
  auditDelta: string;
  riskLevel: string;
  beforeArtifact: string;
  afterArtifact: string;
  changesSummaryArtifact: string;
}

function buildReviewBody(input: ReviewBodyInput): string {
  const autoFixLines =
    input.appliedFindingIds.length > 0
      ? input.appliedFindingIds.map((id) => `- ${id}`)
      : ["- No findings were auto-fixed."];

  return [
    "## What was detected",
    `- Total findings detected: ${input.detectedCount}`,
    `- Safe auto-fix candidates: ${input.safeCandidateCount}`,
    "",
    "## What was auto-fixed",
    ...autoFixLines,
    "",
    "### Auto-fix matrix",
    input.summaryTable,
    "",
    "## Risk level",
    `- ${input.riskLevel}`,
    "",
    "## Validation results (lint/test/audit delta)",
    `- Lint: ${input.lintResult}`,
    `- Test: ${input.testResult}`,
    `- Audit delta: ${input.auditDelta}`,
    "",
    "## Rollback instructions",
    "- Revert commit in this branch: `git revert <commit-sha>`.",
    "- Or close this PR/MR and delete the branch if fix scope is not acceptable.",
    "",
    "## Attached artifacts",
    `- audit-before.json: ${input.beforeArtifact}`,
    `- audit-after.json: ${input.afterArtifact}`,
    `- changes-summary.md: ${input.changesSummaryArtifact}`,
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
  const beforeArtifact = path.join(input.runDir, "audit-before.json");
  const afterArtifact = path.join(input.runDir, "audit-after.json");
  const changesSummaryArtifact = path.join(input.runDir, "changes-summary.md");
  await writeFile(
    beforeArtifact,
    JSON.stringify(
      {
        runId: input.runId,
        detectedCount: input.findings.length,
        safeCandidateCount: safeCandidates.length,
        allowedCandidates: policySelection.allowedCandidates.map((candidate) => ({
          findingId: candidate.findingId,
          summary: candidate.summary,
          risk: candidate.risk
        })),
        blockedCandidates: policySelection.skipped
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(changesSummaryArtifact, "No fix changes were produced.", "utf8");

  if (policySelection.allowedCandidates.length === 0) {
    await writeFile(
      afterArtifact,
      JSON.stringify(
        {
          runId: input.runId,
          appliedFindingIds: [],
          status: "skipped",
          reason: "No safe candidates generated."
        },
        null,
        2
      ),
      "utf8"
    );
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
    await writeFile(
      afterArtifact,
      JSON.stringify(
        {
          runId: input.runId,
          appliedFindingIds: [],
          status: "skipped",
          reason: "Dry run mode enabled in policy config. No code changes were applied."
        },
        null,
        2
      ),
      "utf8"
    );
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
      await writeFile(
        afterArtifact,
        JSON.stringify(
          {
            runId: input.runId,
            appliedFindingIds: [...appliedFindingIds],
            status: "blocked",
            reason: gateResult.reason ?? "Change gates blocked update"
          },
          null,
          2
        ),
        "utf8"
      );
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

    const testGateResult = await testsPassIfConfigured(input.repoPath, input.packageManager);
    if (!testGateResult.allowed) {
      await writeFile(
        afterArtifact,
        JSON.stringify(
          {
            runId: input.runId,
            appliedFindingIds: [...appliedFindingIds],
            status: "blocked",
            reason: testGateResult.reason ?? "Test gate failed"
          },
          null,
          2
        ),
        "utf8"
      );
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
    await writeFile(
      afterArtifact,
      JSON.stringify(
        {
          runId: input.runId,
          appliedFindingIds: [],
          status: "skipped",
          reason: "Safe fixes produced no repository changes."
        },
        null,
        2
      ),
      "utf8"
    );
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
  await writeFile(
    afterArtifact,
    JSON.stringify(
      {
        runId: input.runId,
        appliedFindingIds: [...appliedFindingIds],
        commitSha,
        commits: commitsByCategory,
        diffSummary
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    changesSummaryArtifact,
    ["# Auto-fix Changes Summary", "", markdownTable(candidates, appliedFindingIds), "", "## Diff stat", diffSummary].join("\n"),
    "utf8"
  );

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
  const prBody = buildReviewBody({
    detectedCount: input.findings.length,
    safeCandidateCount: safeCandidates.length,
    appliedFindingIds: [...appliedFindingIds],
    summaryTable,
    lintResult: "not configured",
    testResult: "pass (if configured)",
    auditDelta: `${input.findings.length} findings detected, ${appliedFindingIds.size} auto-fixed`,
    riskLevel: "risk:safe-autofix",
    beforeArtifact,
    afterArtifact,
    changesSummaryArtifact
  });
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
