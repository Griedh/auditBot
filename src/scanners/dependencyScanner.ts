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

interface AuditFindingInput {
  dependency: string;
  title: string;
  overview: string;
  severity?: string;
  fixVersion?: string;
  raw: unknown;
}

function buildFinding(scanner: string, input: AuditFindingInput): Finding {
  return {
    id: stableId([scanner, input.dependency, input.title]),
    source: "npm-audit",
    message: input.title,
    autofixable: Boolean(input.fixVersion),
    fixType: input.fixVersion ? "dependency-upgrade" : "manual",
    scanner,
    title: input.title,
    description: input.overview,
    severity: toSeverity(input.severity),
    file: "package.json",
    confidence: 0.95,
    autofix: input.fixVersion ? "safe" : "none",
    patchMetadata: {
      strategy: input.fixVersion ? "dependency-upgrade" : "manual",
      targetVersion: input.fixVersion
    },
    raw: input.raw
  };
}

export class DependencyScanner implements Scanner {
  name = "dependency-audit";

  async run(context: ScanContext): Promise<Finding[]> {
    const args = npmArgs(context.packageManager);
    if (!args) return [];

    const command = context.packageManager;
    const result = await execCommand(command, args, context.repoPath);

    const findings: Finding[] = [];
    const payload = `${result.stdout}\n${result.stderr}`.trim();
    if (!payload) return findings;

    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const vulnerabilities = parsed.vulnerabilities;
      if (vulnerabilities && typeof vulnerabilities === "object") {
        for (const [name, entry] of Object.entries(vulnerabilities as Record<string, Record<string, unknown>>)) {
          const severity = entry.severity as string | undefined;
          const via = Array.isArray(entry.via) ? entry.via : [];
          const firstVia = via.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
          const title = String(firstVia?.title ?? `${name} vulnerability`);
          const overview = String(firstVia?.url ?? firstVia?.overview ?? "Dependency vulnerability detected.");
          const fixAvailable = entry.fixAvailable;
          const fixVersion =
            fixAvailable && typeof fixAvailable === "object"
              ? (fixAvailable as Record<string, unknown>).name === name
                ? String((fixAvailable as Record<string, unknown>).version ?? "")
                : undefined
              : undefined;
          findings.push(
            buildFinding(this.name, {
              dependency: name,
              title,
              overview,
              severity,
              fixVersion: fixVersion || undefined,
              raw: entry
            })
          );
        }
      }
    } catch {
      const lines = result.stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if ((parsed.type as string | undefined) !== "auditAdvisory") continue;
          const data = parsed.data as Record<string, unknown>;
          const advisory = data.advisory as Record<string, unknown>;
          findings.push(
            buildFinding(this.name, {
              dependency: String(advisory.module_name ?? "unknown-module"),
              title: String(advisory.title ?? "Dependency vulnerability"),
              overview: String(advisory.overview ?? "Package advisory"),
              severity: advisory.severity as string | undefined,
              fixVersion: String(advisory.recommendation ?? "") || undefined,
              raw: advisory
            })
          );
        } catch {
          // Ignore non-JSON lines.
        }
      }
    }

    findings.sort((a, b) => a.id.localeCompare(b.id));
    return findings;
  }
}
