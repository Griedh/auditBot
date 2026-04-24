import type { Finding } from "../models/finding.js";

export interface ScanContext {
  repoPath: string;
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
}

export interface Scanner {
  name: string;
  run(context: ScanContext): Promise<Finding[]>;
}
