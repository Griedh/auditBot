import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createReviewRequest, type Provider } from "@auditbot/integrations";

export interface Finding {
  id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  autofix: "none" | "safe" | "risky";
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
  fixEngine: {
    prUrl?: string;
    mrUrl?: string;
    skipped?: string;
    appliedFindingIds: string[];
    summaryTable: string;
    beforeArtifact: string;
    afterArtifact: string;
  };
  logsFile: string;
  markdownFile: string;
  diffPreviewFile: string;
}

export interface RunOptions {
  repo: string;
  provider?: Provider;
  dryRun?: boolean;
  outDir: string;
}

interface AuditBotConfig {
  provider?: Provider;
  dryRun?: boolean;
  baseBranch?: string;
  outDir?: string;
}

interface PreparedRepo {
  source: string;
  workspacePath: string;
  packageManager: RunReport["packageManager"];
  monorepo: boolean;
  workspaces: string[];
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function isGitUrl(input: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(input) || input.endsWith(".git");
}

async function execGit(args: string[], cwd?: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed (${code})`))));
    child.on("error", reject);
  });
}

export async function prepareRepo(repoInput: string): Promise<PreparedRepo> {
  const workspacePath = path.join(tmpdir(), `auditbot-${stableId(`${repoInput}:${Date.now()}`)}`);
  await mkdir(workspacePath, { recursive: true });

  if (isGitUrl(repoInput)) {
    await execGit(["clone", "--depth", "1", repoInput, workspacePath], process.cwd());
  } else {
    await cp(path.resolve(repoInput), workspacePath, { recursive: true });
  }

  const npm = existsSync(path.join(workspacePath, "package-lock.json"));
  const yarn = existsSync(path.join(workspacePath, "yarn.lock"));
  const pnpm = existsSync(path.join(workspacePath, "pnpm-lock.yaml"));
  const packageManager = pnpm ? "pnpm" : yarn ? "yarn" : npm ? "npm" : "unknown";

  const packageJsonPath = path.join(workspacePath, "package.json");
  let workspaces: string[] = [];
  if (existsSync(packageJsonPath)) {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { workspaces?: string[] | { packages?: string[] } };
    if (Array.isArray(parsed.workspaces)) workspaces = parsed.workspaces;
    else if (parsed.workspaces?.packages) workspaces = parsed.workspaces.packages;
  }

  return {
    source: isGitUrl(repoInput) ? repoInput : path.resolve(repoInput),
    workspacePath,
    packageManager,
    monorepo: workspaces.length > 0,
    workspaces
  };
}

export async function scan(repoPath: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const gitDir = path.join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    findings.push({
      id: "repo-missing-git",
      title: "Repository is missing .git metadata",
      description: "Branch/PR automation is unavailable without git metadata.",
      severity: "medium",
      autofix: "none"
    });
  }

  return findings;
}

export function planFixes(findings: Finding[]): { safeFindingIds: string[]; riskyFindingIds: string[] } {
  return {
    safeFindingIds: findings.filter((f) => f.autofix === "safe").map((f) => f.id),
    riskyFindingIds: findings.filter((f) => f.autofix === "risky").map((f) => f.id)
  };
}

export async function applyFixes(input: { runDir: string; dryRun: boolean }): Promise<RunReport["fixEngine"]> {
  const beforeArtifact = path.join(input.runDir, "fixes-before.txt");
  const afterArtifact = path.join(input.runDir, "fixes-after.txt");
  await writeFile(beforeArtifact, "No concrete fixes generated in this scaffold.\n", "utf8");
  await writeFile(afterArtifact, input.dryRun ? "Dry-run mode: no fixes applied.\n" : "No-op fix phase.\n", "utf8");

  return {
    skipped: input.dryRun ? "Dry-run enabled" : "No-op fixer",
    appliedFindingIds: [],
    summaryTable: "| Finding ID | Summary | Risk | Applied |\n|---|---|---|---|",
    beforeArtifact,
    afterArtifact
  };
}

async function loadAuditBotConfig(repoPath: string): Promise<AuditBotConfig> {
  const configPath = path.join(repoPath, "auditbot.config.json");
  if (!existsSync(configPath)) {
    return {};
  }

  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const provider =
    parsed.provider === "github" || parsed.provider === "gitlab" ? (parsed.provider as Provider) : undefined;
  const dryRun = typeof parsed.dryRun === "boolean" ? parsed.dryRun : undefined;
  const baseBranch = typeof parsed.baseBranch === "string" && parsed.baseBranch.trim() ? parsed.baseBranch.trim() : undefined;
  const outDir = typeof parsed.outDir === "string" && parsed.outDir.trim() ? parsed.outDir.trim() : undefined;

  return { provider, dryRun, baseBranch, outDir };
}

export async function createBranchAndPR(input: {
  provider: Provider;
  repo: string;
  runId: string;
  dryRun: boolean;
  baseBranch: string;
}): Promise<{ prUrl?: string; mrUrl?: string }> {
  if (input.dryRun || isGitUrl(input.repo) === false) {
    return {};
  }

  const repository = input.repo.replace(/^https?:\/\/github.com\//, "").replace(/\.git$/, "");
  const branchDate = new Date().toISOString().slice(0, 10);
  const shortRunId = input.runId.slice(0, 8);
  const headBranch = `auditbot/${branchDate}/${shortRunId}`;
  const response = await createReviewRequest({
    provider: input.provider,
    repository,
    title: "fix(auditbot): apply safe lint/dependency remediations",
    body: "Automated auditBot follow-up review request.",
    head: headBranch,
    base: input.baseBranch,
    labels: ["auditbot"]
  });

  return input.provider === "github" ? { prUrl: response.url } : { mrUrl: response.url };
}

export async function emitReport(input: {
  runDir: string;
  report: Omit<RunReport, "logsFile" | "markdownFile" | "diffPreviewFile">;
  logs: string[];
}): Promise<RunReport> {
  const logsFile = path.join(input.runDir, "run.log");
  const markdownFile = path.join(input.runDir, "report.md");
  const diffPreviewFile = path.join(input.runDir, "diff-preview.patch");

  await writeFile(logsFile, `${input.logs.join("\n")}\n`, "utf8");
  await writeFile(markdownFile, `# auditBot Report\n\nTotal findings: ${input.report.findings.length}\n`, "utf8");
  await writeFile(diffPreviewFile, "", "utf8");
  await writeFile(path.join(input.runDir, "report.json"), JSON.stringify(input.report, null, 2), "utf8");

  return { ...input.report, logsFile, markdownFile, diffPreviewFile };
}

export async function runAudit(options: RunOptions): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const prepared = await prepareRepo(options.repo);
  const config = await loadAuditBotConfig(prepared.workspacePath);
  const provider = options.provider ?? config.provider ?? "github";
  const dryRun = options.dryRun ?? config.dryRun ?? false;
  const outDir = config.outDir ? path.resolve(config.outDir) : options.outDir;
  const baseBranch = config.baseBranch ?? "main";
  const findings = await scan(prepared.workspacePath);
  const plan = planFixes(findings);

  const runId = stableId(`${prepared.source}:${startedAt}`);
  const runDir = path.join(outDir, runId);
  await mkdir(runDir, { recursive: true });

  const fixEngine = await applyFixes({ runDir, dryRun });
  const review = await createBranchAndPR({ provider, repo: options.repo, runId, dryRun, baseBranch });

  const finishedAt = new Date().toISOString();
  return emitReport({
    runDir,
    logs: [
      `prepareRepo: ${prepared.workspacePath}`,
      `config: ${existsSync(path.join(prepared.workspacePath, "auditbot.config.json")) ? "loaded" : "default"}`,
      `scan: ${findings.length} finding(s)`,
      `planFixes: safe=${plan.safeFindingIds.length} risky=${plan.riskyFindingIds.length}`,
      `applyFixes: ${fixEngine.skipped ?? "done"}`,
      `createBranchAndPR: ${review.prUrl ?? review.mrUrl ?? "skipped"}`,
      `emitReport: ${finishedAt}`
    ],
    report: {
      runId,
      startedAt,
      finishedAt,
      source: prepared.source,
      workspacePath: prepared.workspacePath,
      packageManager: prepared.packageManager,
      monorepo: prepared.monorepo,
      workspaces: prepared.workspaces,
      findings,
      fixEngine: {
        ...fixEngine,
        ...review
      }
    }
  });
}
