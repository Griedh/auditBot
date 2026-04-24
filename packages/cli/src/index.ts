#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runAudit, type RunOptions } from "@auditbot/core";
type Provider = "github" | "gitlab";

function parseArgs(argv: string[]): RunOptions {
  const [command, ...rest] = argv;

  if (command !== "run") {
    throw new Error("Usage: auditbot run --repo <url|path> --provider <github|gitlab> [--dry-run] [--out <dir>]");
  }

  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key?.startsWith("--") && value && !value.startsWith("--")) {
      options.set(key, value);
      i += 1;
    }
  }

  const repo = options.get("--repo");
  const provider = (options.get("--provider") ?? "github") as Provider;
  const outDir = options.get("--out") ?? path.resolve(process.cwd(), ".auditbot-runs");
  const dryRun = rest.includes("--dry-run");

  if (!repo) {
    throw new Error("Missing required flag: --repo");
  }

  if (provider !== "github" && provider !== "gitlab") {
    throw new Error("Invalid --provider value. Expected github or gitlab.");
  }

  return { repo, provider, outDir, dryRun };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runAudit(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
