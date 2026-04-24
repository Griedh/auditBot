import { readFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "../utils/fs.js";

export type FixCategory = "deps" | "lint" | "code-style" | "test-only";

export interface StagedApprovalConfig {
  enabled: boolean;
  readyForReviewOnChecksPass: boolean;
}

export interface PolicyConfig {
  allowedFixCategories: FixCategory[];
  maxFilesChanged?: number;
  maxLinesChanged?: number;
  forbiddenPaths: string[];
  requiredConfidenceThreshold: number;
  dryRun: boolean;
  stagedApprovals: StagedApprovalConfig;
}

const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  allowedFixCategories: ["deps", "lint", "code-style", "test-only"],
  forbiddenPaths: [],
  requiredConfidenceThreshold: 0,
  dryRun: false,
  stagedApprovals: {
    enabled: false,
    readyForReviewOnChecksPass: true
  }
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function normalizeFixCategory(value: unknown): FixCategory | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim() as FixCategory;
  return ["deps", "lint", "code-style", "test-only"].includes(normalized) ? normalized : undefined;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }

    if (line.startsWith("  ")) {
      throw new Error("Unsupported YAML shape: top-level indentation is not allowed");
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!keyMatch) {
      throw new Error(`Invalid YAML line: ${line}`);
    }

    const key = keyMatch[1];
    const inlineValue = keyMatch[2];

    if (inlineValue && inlineValue.trim() !== "") {
      root[key] = parseScalar(inlineValue);
      index += 1;
      continue;
    }

    const listValues: unknown[] = [];
    const objectValues: Record<string, unknown> = {};
    let sawList = false;
    let sawObject = false;
    index += 1;

    while (index < lines.length) {
      const nestedRaw = lines[index].replace(/\t/g, "  ");
      if (!nestedRaw.trim() || nestedRaw.trim().startsWith("#")) {
        index += 1;
        continue;
      }

      if (!nestedRaw.startsWith("  ")) {
        break;
      }

      const nested = nestedRaw.slice(2);
      const listMatch = nested.match(/^-\s+(.*)$/);
      if (listMatch) {
        sawList = true;
        listValues.push(parseScalar(listMatch[1]));
        index += 1;
        continue;
      }

      const nestedKeyMatch = nested.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
      if (!nestedKeyMatch) {
        throw new Error(`Invalid nested YAML line: ${nestedRaw}`);
      }

      sawObject = true;
      objectValues[nestedKeyMatch[1]] = parseScalar(nestedKeyMatch[2] ?? "");
      index += 1;
    }

    if (sawList && sawObject) {
      throw new Error(`Unsupported YAML mix for key '${key}'`);
    }

    if (sawList) {
      root[key] = listValues;
    } else if (sawObject) {
      root[key] = objectValues;
    } else {
      root[key] = "";
    }
  }

  return root;
}

function normalizePolicyConfig(raw: Record<string, unknown>): PolicyConfig {
  const allowedRaw = Array.isArray(raw.allowedFixCategories) ? raw.allowedFixCategories : undefined;
  const allowedFixCategories = allowedRaw
    ?.map((value) => normalizeFixCategory(value))
    .filter((value): value is FixCategory => value !== undefined);

  const forbiddenPaths = Array.isArray(raw.forbiddenPaths)
    ? raw.forbiddenPaths
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  const stagedApprovalsRaw =
    raw.stagedApprovals && typeof raw.stagedApprovals === "object"
      ? (raw.stagedApprovals as Record<string, unknown>)
      : {};

  return {
    allowedFixCategories:
      allowedFixCategories && allowedFixCategories.length > 0
        ? allowedFixCategories
        : DEFAULT_POLICY_CONFIG.allowedFixCategories,
    maxFilesChanged: toNumber(raw.maxFilesChanged),
    maxLinesChanged: toNumber(raw.maxLinesChanged),
    forbiddenPaths,
    requiredConfidenceThreshold:
      toNumber(raw.requiredConfidenceThreshold) ?? DEFAULT_POLICY_CONFIG.requiredConfidenceThreshold,
    dryRun: toBoolean(raw.dryRun) ?? DEFAULT_POLICY_CONFIG.dryRun,
    stagedApprovals: {
      enabled: toBoolean(stagedApprovalsRaw.enabled) ?? DEFAULT_POLICY_CONFIG.stagedApprovals.enabled,
      readyForReviewOnChecksPass:
        toBoolean(stagedApprovalsRaw.readyForReviewOnChecksPass) ??
        DEFAULT_POLICY_CONFIG.stagedApprovals.readyForReviewOnChecksPass
    }
  };
}

export async function loadPolicyConfig(repoPath: string): Promise<PolicyConfig> {
  const jsonPath = path.join(repoPath, "auditbot.config.json");
  const ymlPath = path.join(repoPath, "auditbot.config.yml");
  const yamlPath = path.join(repoPath, "auditbot.config.yaml");

  if (await exists(jsonPath)) {
    const content = await readFile(jsonPath, "utf8");
    return normalizePolicyConfig(JSON.parse(content) as Record<string, unknown>);
  }

  const yamlConfigPath = (await exists(ymlPath)) ? ymlPath : (await exists(yamlPath) ? yamlPath : undefined);
  if (yamlConfigPath) {
    const content = await readFile(yamlConfigPath, "utf8");
    return normalizePolicyConfig(parseSimpleYaml(content));
  }

  return DEFAULT_POLICY_CONFIG;
}
