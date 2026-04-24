import path from "node:path";
import type { Finding } from "../models/finding.js";
import { exists, readJson } from "../utils/fs.js";
import { stableId } from "../utils/hash.js";
import type { ScanContext, Scanner } from "./types.js";

interface PackageJson {
  private?: boolean;
}

export class PolicyScanner implements Scanner {
  name = "policy-checks";

  async run(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
    const hasLock = await Promise.all(lockfiles.map((file) => exists(path.join(context.repoPath, file))));

    if (!hasLock.some(Boolean)) {
      findings.push({
        id: stableId([this.name, "missing-lockfile"]),
        scanner: this.name,
        title: "No lockfile detected",
        description: "Repository should include a lockfile for deterministic dependency resolution.",
        severity: "high",
        file: "package.json",
        confidence: 0.95,
        autofixable: false,
        patchMetadata: { strategy: "manual" }
      });
    }

    const pkg = await readJson<PackageJson>(path.join(context.repoPath, "package.json"));
    if (pkg && pkg.private !== true) {
      findings.push({
        id: stableId([this.name, "pkg-private"]),
        scanner: this.name,
        title: "Package should be private",
        description: "Set package.json private=true to reduce accidental publishes.",
        severity: "low",
        file: "package.json",
        confidence: 0.7,
        autofixable: true,
        patchMetadata: {
          strategy: "manual",
          patchPreview: "diff --git a/package.json b/package.json\n+  \"private\": true"
        }
      });
    }

    findings.sort((a, b) => a.id.localeCompare(b.id));
    return findings;
  }
}
