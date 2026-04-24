import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../models/finding.js";
import type { FixCandidate, RuleFixer } from "./types.js";

interface EslintFixData {
  range?: [number, number];
  text?: string;
}

interface EslintFindingRaw {
  ruleId?: string | null;
  fix?: EslintFixData;
}

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

function parseFix(raw: unknown): EslintFixData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const fix = (raw as EslintFindingRaw).fix;
  if (!fix || !Array.isArray(fix.range) || fix.range.length !== 2 || typeof fix.text !== "string") return undefined;
  const [start, end] = fix.range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return undefined;
  return { range: [start, end], text: fix.text };
}

function parseRuleId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as EslintFindingRaw).ruleId;
  return typeof value === "string" ? value : undefined;
}

export class EslintFixer implements RuleFixer {
  name = "eslint-fix-api";

  supports(finding: Finding): boolean {
    return finding.patchMetadata.strategy === "eslint-fix" && finding.autofix === "safe";
  }

  buildCandidate(finding: Finding): FixCandidate | undefined {
    const file = finding.file;
    const fix = parseFix(finding.raw);
    const ruleId = parseRuleId(finding.raw);

    if (!file || !fix?.range || !SAFE_AUTOFIX_RULES.has(ruleId ?? "")) {
      return undefined;
    }

    return {
      findingId: finding.id,
      summary: `Apply ESLint safe autofix (${ruleId})`,
      category: "lint",
      risk: "safe",
      touches: [file],
      apply: async (repoPath: string): Promise<boolean> => {
        const filePath = path.resolve(repoPath, file);
        const content = await readFile(filePath, "utf8");
        const [start, end] = fix.range as [number, number];

        if (end > content.length) return false;

        const nextContent = `${content.slice(0, start)}${fix.text ?? ""}${content.slice(end)}`;
        if (nextContent === content) return false;

        await writeFile(filePath, nextContent, "utf8");
        return true;
      }
    };
  }
}
