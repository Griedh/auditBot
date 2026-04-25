import { execCommand } from "../utils/exec.js";
import process from "node:process";
import type { GitRemoteInfo } from "./types.js";

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const result = await execCommand("git", args, repoPath);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function getDefaultRemote(repoPath: string): Promise<GitRemoteInfo | undefined> {
  const name = (await runGit(repoPath, ["remote"]))
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!name) return undefined;

  const url = await runGit(repoPath, ["remote", "get-url", name]);
  return { remoteName: name, url };
}

export async function createDeterministicBranch(repoPath: string, runId: string, category: string): Promise<string> {
  const shortRunId = runId.slice(0, 8);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const branch = `auditbot/${dateStamp}/${shortRunId}-${category}`;
  await runGit(repoPath, ["checkout", "-B", branch]);
  return branch;
}

export async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
  const output = await runGit(repoPath, ["status", "--porcelain"]);
  return output.trim().length > 0;
}

export async function commitAll(repoPath: string, message: string): Promise<string> {
  await runGit(repoPath, ["add", "-A"]);
  await runGit(repoPath, ["commit", "-m", message]);
  return runGit(repoPath, ["rev-parse", "HEAD"]);
}

export async function pushBranch(repoPath: string, branch: string, remoteName: string): Promise<void> {
  const repoToken = process.env.AUDITBOT_REPO_TOKEN;
  if (repoToken) {
    const remoteUrl = await runGit(repoPath, ["remote", "get-url", remoteName]);
    if (remoteUrl.startsWith("https://")) {
      const tokenUrl = remoteUrl.replace("https://", `https://x-access-token:${repoToken}@`);
      await runGit(repoPath, ["push", "-u", tokenUrl, branch]);
      return;
    }
  }

  await runGit(repoPath, ["push", "-u", remoteName, branch]);
}

export function buildCommitMessage(findingIds: string[]): string {
  const uniqueIds = [...new Set(findingIds)].sort();
  return [
    "fix(auditbot): apply safe lint/dependency remediations",
    "",
    `finding-ids: ${uniqueIds.join(",")}`,
    "guardrails: autofix=safe only"
  ].join("\n");
}

export async function getRepositorySlug(repoPath: string): Promise<string | undefined> {
  const remote = await getDefaultRemote(repoPath);
  if (!remote) return undefined;

  const sshMatch = remote.url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return sshMatch?.[1];
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function diffStat(repoPath: string): Promise<string> {
  return runGit(repoPath, ["diff", "--stat", "HEAD~1", "HEAD"]);
}
