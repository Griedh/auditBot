import type { Finding } from "../models/finding.js";

export type FixRisk = "safe" | "risky";

export interface FixCandidate {
  findingId: string;
  summary: string;
  category: string;
  risk: FixRisk;
  apply(repoPath: string): Promise<boolean>;
}

export interface RuleFixer {
  name: string;
  supports(finding: Finding): boolean;
  buildCandidate(finding: Finding): FixCandidate | undefined;
}
