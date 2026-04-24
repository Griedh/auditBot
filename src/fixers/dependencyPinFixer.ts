import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../models/finding.js";
import type { FixCandidate, RuleFixer } from "./types.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
}

function normalizeVersion(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const match = input.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
  if (!match) return undefined;
  return `^${match[1]}`;
}

function moduleNameFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>).module_name;
  return typeof value === "string" ? value : undefined;
}

export class DependencyPinFixer implements RuleFixer {
  name = "dependency-pin-update";

  supports(finding: Finding): boolean {
    return finding.patchMetadata.strategy === "dependency-upgrade";
  }

  buildCandidate(finding: Finding): FixCandidate | undefined {
    const moduleName = moduleNameFromRaw(finding.raw);
    const targetVersion = normalizeVersion(finding.patchMetadata.targetVersion);

    if (!moduleName || !targetVersion) {
      return undefined;
    }

    return {
      findingId: finding.id,
      summary: `Pin ${moduleName} to ${targetVersion}`,
      category: "deps",
      risk: "safe",
      touches: ["package.json"],
      apply: async (repoPath: string): Promise<boolean> => {
        const packageJsonPath = path.join(repoPath, "package.json");
        const content = await readFile(packageJsonPath, "utf8");
        const pkg = JSON.parse(content) as PackageJson;
        let changed = false;

        const updateBuckets: Array<keyof PackageJson> = [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "overrides",
          "resolutions"
        ];

        for (const bucket of updateBuckets) {
          const deps = pkg[bucket];
          if (deps && deps[moduleName] && deps[moduleName] !== targetVersion) {
            deps[moduleName] = targetVersion;
            changed = true;
          }
        }

        if (!changed) {
          return false;
        }

        await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
        return true;
      }
    };
  }
}
