import { cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execCommand } from "../utils/exec.js";
import { stableId } from "../utils/hash.js";

export interface WorkspaceInfo {
  source: string;
  workspacePath: string;
}

function isGitUrl(input: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(input) || input.endsWith(".git");
}

export async function prepareWorkspace(input: string): Promise<WorkspaceInfo> {
  const suffix = stableId([input, "workspace"]);
  const workspacePath = path.join(tmpdir(), `auditbot-${suffix}`);
  await mkdir(workspacePath, { recursive: true });

  if (isGitUrl(input)) {
    const result = await execCommand("git", ["clone", "--depth", "1", input, workspacePath], process.cwd());
    if (result.code !== 0) {
      throw new Error(`Unable to clone repository: ${result.stderr || result.stdout}`);
    }
    return { source: input, workspacePath };
  }

  await cp(path.resolve(input), workspacePath, { recursive: true });
  return { source: path.resolve(input), workspacePath };
}
