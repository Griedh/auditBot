import type { Finding } from "../models/finding.js";
import { stableId } from "../utils/hash.js";
import { execCommand } from "../utils/exec.js";
import type { ScanContext, Scanner } from "./types.js";

function toSeverity(input: string | undefined): Finding["severity"] {
  if (input === "critical" || input === "high" || input === "medium" || input === "low") {
    return input;
  }
  return "info";
}

function npmArgs(pm: ScanContext["packageManager"]): string[] | undefined {
  if (pm === "npm") return ["audit", "--json"];
  if (pm === "pnpm") return ["audit", "--json"];
  if (pm === "yarn") return ["npm", "audit", "--json"];
  return undefined;
}

export class DependencyScanner implements Scanner {
  name = "dependency-audit";

  async run(context: ScanContext): Promise<Finding[]> {
    const args = npmArgs(context.packageManager);
    if (!args) return [];

    const command = context.packageManager;
    const result = await execCommand(command, args, context.repoPath);

    const findings: Finding[] = [];
    const lines = result.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if ((parsed.type as string | undefined) !== "auditAdvisory") {
          continue;
        }
        const data = parsed.data as Record<string, unknown>;
        const advisory = data.advisory as Record<string, unknown>;
        const moduleName = String(advisory.module_name ?? "unknown-module");
        const title = String(advisory.title ?? "Dependency vulnerability");
        findings.push({
          id: stableId([this.name, moduleName, title]),
          scanner: this.name,
          title,
          description: String(advisory.overview ?? "Package advisory"),
          severity: toSeverity(advisory.severity as string | undefined),
          file: "package.json",
          confidence: 0.95,
          autofix: "safe",
          patchMetadata: {
            strategy: "dependency-upgrade",
            targetVersion: String(advisory.recommendation ?? "") || undefined
          },
          raw: advisory
        });
      } catch {
        // Ignore non-JSON lines.
      }
    }

    findings.sort((a, b) => a.id.localeCompare(b.id));
    return findings;
  }
}
