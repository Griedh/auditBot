import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../models/finding.js";
import type { RepositoryLayout } from "../orchestrator/detection.js";
import { renderMarkdownSummary } from "./markdown.js";

interface PersistInput {
  runDir: string;
  runId: string;
  source: string;
  workspacePath: string;
  layout: RepositoryLayout;
  findings: Finding[];
  logs: string[];
  startedAt: string;
  finishedAt: string;
}

export async function persistArtifacts(input: PersistInput): Promise<{
  logsFile: string;
  markdownFile: string;
  diffPreviewFile: string;
}> {
  const logsFile = path.join(input.runDir, "run.log");
  const jsonFile = path.join(input.runDir, "report.json");
  const markdownFile = path.join(input.runDir, "report.md");
  const diffPreviewFile = path.join(input.runDir, "diff-preview.patch");

  await writeFile(logsFile, input.logs.join("\n"), "utf8");
  await writeFile(
    jsonFile,
    JSON.stringify(
      {
        runId: input.runId,
        source: input.source,
        workspacePath: input.workspacePath,
        packageManager: input.layout.packageManager,
        monorepo: input.layout.monorepo,
        workspaces: input.layout.workspaces,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        findings: input.findings
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(markdownFile, renderMarkdownSummary(input.findings), "utf8");
  await writeFile(
    diffPreviewFile,
    input.findings
      .filter((finding) => Boolean(finding.patchMetadata.patchPreview))
      .map((finding) => `# ${finding.id}\n${finding.patchMetadata.patchPreview}`)
      .join("\n\n"),
    "utf8"
  );

  return { logsFile, markdownFile, diffPreviewFile };
}
