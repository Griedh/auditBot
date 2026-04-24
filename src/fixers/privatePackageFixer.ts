import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../models/finding.js";
import type { FixCandidate, RuleFixer } from "./types.js";

export class PrivatePackageFixer implements RuleFixer {
  name = "private-package-codemod";

  supports(finding: Finding): boolean {
    return finding.scanner === "policy-checks" && finding.id.includes("pkg-private");
  }

  buildCandidate(finding: Finding): FixCandidate | undefined {
    return {
      findingId: finding.id,
      summary: "Set package.json private=true",
      category: "safe",
      risk: "safe",
      apply: async (repoPath: string): Promise<boolean> => {
        const packageJsonPath = path.join(repoPath, "package.json");
        const content = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(content) as Record<string, unknown>;

        if (parsed.private === true) {
          return false;
        }

        parsed.private = true;
        await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        return true;
      }
    };
  }
}
