import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { ESLINT_SAFE_RULES } from "./eslintSafeRules.js";
import { StaticScanner } from "./scanners/staticScanner.js";
import { EslintFixer } from "./fixers/eslintFixer.js";

async function setupRepo(stdout: string): Promise<{ repoPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eslint-safe-rules-test-"));
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  await mkdir(repoPath, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(repoPath, ".eslintrc.json"), "{}\n", "utf8");

  const script = `#!/usr/bin/env bash\nprintf '%s' '${stdout.replaceAll("'", "'\\''")}'\n`;
  const npxPath = path.join(fakeBin, "npx");
  await writeFile(npxPath, script, "utf8");
  await chmod(npxPath, 0o755);

  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBin}:${previousPath}`;
  return {
    repoPath,
    cleanup: async () => {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("shared ESLint safe-rules source drives scanner and fixer", async () => {
  const safeRule = ESLINT_SAFE_RULES.values().next().value;
  assert.equal(typeof safeRule, "string");

  const eslintJson = JSON.stringify([
    {
      filePath: "index.js",
      messages: [
        {
          ruleId: safeRule,
          message: "safe rule violation",
          severity: 1,
          fix: { range: [0, 0], text: "const x = 1;\n" }
        }
      ]
    }
  ]);

  const { repoPath, cleanup } = await setupRepo(eslintJson);
  try {
    const scanner = new StaticScanner();
    const findings = await scanner.run({ repoPath, packageManager: "npm" });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.autofix, "safe");

    const fixer = new EslintFixer();
    const candidate = fixer.buildCandidate(findings[0]!);
    assert.ok(candidate);
  } finally {
    await cleanup();
  }
});
