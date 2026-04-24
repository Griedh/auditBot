import type { Finding } from "../models/finding.js";

export function renderMarkdownSummary(findings: Finding[]): string {
  const lines = ["# auditBot Report", "", `Total findings: ${findings.length}`, ""];

  for (const finding of findings) {
    lines.push(`## ${finding.title}`);
    lines.push(`- id: ${finding.id}`);
    lines.push(`- scanner: ${finding.scanner}`);
    lines.push(`- severity: ${finding.severity}`);
    lines.push(`- confidence: ${finding.confidence}`);
    lines.push(`- file: ${finding.file ?? "n/a"}`);
    lines.push(`- autofix: ${finding.autofix}`);
    lines.push("");
    lines.push(finding.description);
    lines.push("");
  }

  return lines.join("\n");
}
