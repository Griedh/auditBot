#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runAudit, type RunOptions } from "@auditbot/core";
type Provider = "github" | "gitlab";

const EXIT_CODE_USAGE = 2;
const EXIT_CODE_RUNTIME = 1;

class CliUsageError extends Error {}

function parseArgs(argv: string[]): RunOptions {
  const [command, ...rest] = argv;

  if (command !== "run") {
    throw new CliUsageError(
      "Usage: auditbot run --repo <url|path> [--provider <github|gitlab>] [--dry-run] [--out <dir>]"
    );
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
  const providerFlag = options.get("--provider");
  const provider = providerFlag ? (providerFlag as Provider) : undefined;
  const outDir = options.get("--out") ?? path.resolve(process.cwd(), ".auditbot-runs");
  const dryRun = rest.includes("--dry-run") ? true : undefined;

  if (!repo) {
    throw new CliUsageError("Missing required flag: --repo");
  }

  if (provider !== undefined && provider !== "github" && provider !== "gitlab") {
    throw new CliUsageError("Invalid --provider value. Expected github or gitlab.");
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
  process.exitCode = error instanceof CliUsageError ? EXIT_CODE_USAGE : EXIT_CODE_RUNTIME;
});
