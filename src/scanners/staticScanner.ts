import { readJson } from "../utils/fs.js";
import { execCommand } from "../utils/exec.js";
import { stableId } from "../utils/hash.js";
import type { Finding } from "../models/finding.js";
import type { Scanner, ScanContext } from "./types.js";

interface PackageJson {
  scripts?: Record<string, string>;
}

export class StaticScanner implements Scanner {
  name = "static-checks";

  async run(context: ScanContext): Promise<Finding[]> {
    const pkg = await readJson<PackageJson>(`${context.repoPath}/package.json`);
    if (!pkg?.scripts?.lint) {
      return [];
    }

    const args = context.packageManager === "yarn" ? ["lint"] : ["run", "lint"];
    const result = await execCommand(context.packageManager, args, context.repoPath);

    if (result.code === 0) {
      return [];
    }

    const summary = result.stderr || result.stdout;
    return [
      {
        id: stableId([this.name, "lint", summary]),
        scanner: this.name,
        title: "Lint/static checks failed",
        description: summary.slice(0, 500),
        severity: "medium",
        confidence: 0.8,
        autofix: "risky",
        patchMetadata: { strategy: "eslint-fix" },
        raw: { code: result.code }
      }
    ];
  }
}
