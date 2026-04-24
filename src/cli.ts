#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runPipeline } from "./orchestrator/pipeline.js";

interface CliArgs {
  repo: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith("--") && value && !value.startsWith("--")) {
      options.set(key, value);
      i += 1;
    }
  }

  const repo = options.get("--repo") ?? argv[0];
  const outDir = options.get("--out") ?? path.resolve(process.cwd(), ".auditbot-runs");

  if (!repo) {
    throw new Error("Usage: auditbot --repo <url-or-local-path> [--out <artifacts-dir>]");
  }

  return { repo, outDir };
}

async function main(): Promise<void> {
  const { repo, outDir } = parseArgs(process.argv.slice(2));
  const report = await runPipeline(repo, outDir);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
