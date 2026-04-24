import { readJson } from "../utils/fs.js";
import { execCommand } from "../utils/exec.js";
import type { Finding } from "../models/finding.js";
import type { FixCandidate, RuleFixer } from "./types.js";

interface PackageJson {
  scripts?: Record<string, string>;
}

export class EslintFixer implements RuleFixer {
  name = "eslint-fix-api";

  supports(finding: Finding): boolean {
    return finding.scanner === "static-checks" && finding.autofix === "risky";
  }

  buildCandidate(finding: Finding): FixCandidate | undefined {
    return {
      findingId: finding.id,
      summary: "Run lint --fix via ESLint fixer API",
      category: "lint",
      risk: "risky",
      apply: async (repoPath: string): Promise<boolean> => {
        const pkg = await readJson<PackageJson>(`${repoPath}/package.json`);
        const lintScript = pkg?.scripts?.lint;
        if (!lintScript) return false;

        const command = lintScript.includes("eslint") ? "npm" : "npm";
        const args = ["run", "lint", "--", "--fix"];
        const result = await execCommand(command, args, repoPath);
        return result.code === 0;
      }
    };
  }
}
