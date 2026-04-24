import path from "node:path";
import { exists } from "../utils/fs.js";
import { execCommand } from "../utils/exec.js";
import { stableId } from "../utils/hash.js";
import type { Finding } from "../models/finding.js";
import type { Scanner, ScanContext } from "./types.js";

interface EslintResultEntry {
  filePath: string;
  messages?: Array<{
    ruleId?: string | null;
    message?: string;
    severity?: number;
    fix?: unknown;
  }>;
}

const ESLINT_CONFIG_FILES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.mjs",
  "eslint.config.ts"
];

const SAFE_AUTOFIX_RULES = new Set<string>([
  "array-bracket-spacing",
  "arrow-spacing",
  "comma-dangle",
  "eol-last",
  "keyword-spacing",
  "no-multiple-empty-lines",
  "no-trailing-spaces",
  "object-curly-spacing",
  "quotes",
  "semi",
  "space-before-blocks",
  "space-in-parens"
]);

function severityFromEslint(value: number | undefined): Finding["severity"] {
  if (value === 2) return "high";
  if (value === 1) return "low";
  return "info";
}

export class StaticScanner implements Scanner {
  name = "static-checks";

  async run(context: ScanContext): Promise<Finding[]> {
    const hasConfig = (
      await Promise.all(ESLINT_CONFIG_FILES.map((file) => exists(path.join(context.repoPath, file))))
    ).some(Boolean);
    if (!hasConfig) {
      return [];
    }

    const result = await execCommand("npx", ["eslint", ".", "-f", "json"], context.repoPath);
    const output = result.stdout.trim();
    if (!output) return [];

    const parsed = JSON.parse(output) as EslintResultEntry[];
    const findings: Finding[] = [];
    for (const entry of parsed) {
      const messages = entry.messages ?? [];
      for (const item of messages) {
        const ruleId = item.ruleId ?? "eslint";
        const message = item.message ?? "ESLint violation";
        findings.push({
          id: stableId([this.name, entry.filePath, ruleId, message]),
          source: "eslint",
          message,
          autofixable: Boolean(item.fix),
          fixType: item.fix ? "eslint-fix" : "manual",
          scanner: this.name,
          title: ruleId,
          description: message,
          severity: severityFromEslint(item.severity),
          file: entry.filePath,
          confidence: 0.9,
          autofix: item.fix && SAFE_AUTOFIX_RULES.has(ruleId) ? "safe" : item.fix ? "risky" : "none",
          patchMetadata: { strategy: item.fix ? "eslint-fix" : "manual" },
          raw: item
        });
      }
    }

    findings.sort((a, b) => a.id.localeCompare(b.id));
    return findings;
  }
}
