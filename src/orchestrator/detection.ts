import path from "node:path";
import { exists, readJson } from "../utils/fs.js";

export interface RepositoryLayout {
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
  monorepo: boolean;
  workspaces: string[];
}

interface PackageJson {
  workspaces?: string[] | { packages?: string[] };
}

export async function detectRepositoryLayout(repoPath: string): Promise<RepositoryLayout> {
  const [npmLock, yarnLock, pnpmLock] = await Promise.all([
    exists(path.join(repoPath, "package-lock.json")),
    exists(path.join(repoPath, "yarn.lock")),
    exists(path.join(repoPath, "pnpm-lock.yaml"))
  ]);

  const packageManager = pnpmLock ? "pnpm" : yarnLock ? "yarn" : npmLock ? "npm" : "unknown";

  const pkg = await readJson<PackageJson>(path.join(repoPath, "package.json"));
  const workspaceField = pkg?.workspaces;
  const workspaces =
    Array.isArray(workspaceField) ? workspaceField : Array.isArray(workspaceField?.packages) ? workspaceField.packages : [];

  const monorepoSignals = await Promise.all([
    exists(path.join(repoPath, "pnpm-workspace.yaml")),
    exists(path.join(repoPath, "lerna.json")),
    exists(path.join(repoPath, "turbo.json")),
    exists(path.join(repoPath, "nx.json"))
  ]);

  const monorepo = workspaces.length > 0 || monorepoSignals.some(Boolean);

  return { packageManager, monorepo, workspaces };
}
