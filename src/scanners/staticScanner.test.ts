import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { StaticScanner } from "./staticScanner.js";

async function setupRepo(stdout: string, stderr: string, exitCode = 0): Promise<{ repoPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-scanner-test-"));
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  await mkdir(repoPath, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(repoPath, ".eslintrc.json"), "{}\n", "utf8");

  const script = `#!/usr/bin/env bash
printf '%s' '${stdout.replaceAll("'", "'\\''")}'
printf '%s' '${stderr.replaceAll("'", "'\\''")}' 1>&2
exit ${exitCode}
`;
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

test("returns deterministic synthetic finding when eslint output is malformed", async () => {
  const { repoPath, cleanup } = await setupRepo("not json", "eslint parser error", 2);
  try {
    const scanner = new StaticScanner();
    const findings = await scanner.run({ repoPath, packageManager: "npm" });

    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(finding.title, "ESLint scanner parse failure");
    assert.equal(finding.severity, "info");
    assert.equal(finding.confidence, 0.2);
    assert.deepEqual(finding.patchMetadata, { strategy: "manual" });
    assert.deepEqual(finding.raw, {
      event: "scanner-failure",
      reason: "invalid-eslint-json",
      command: "npx",
      args: ["eslint", ".", "-f", "json"],
      exitCode: 2,
      stdout: { text: "not json", truncated: false },
      stderr: { text: "eslint parser error", truncated: false }
    });
  } finally {
    await cleanup();
  }
});

test("returns empty findings for empty eslint stdout", async () => {
  const { repoPath, cleanup } = await setupRepo("   \n\n", "", 0);
  try {
    const scanner = new StaticScanner();
    const findings = await scanner.run({ repoPath, packageManager: "npm" });

    assert.deepEqual(findings, []);
  } finally {
    await cleanup();
  }
});
