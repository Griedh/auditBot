interface GitlabMergeRequestInput {
  projectPath: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  labels: string[];
  requireHumanReview: boolean;
}

export interface MergeRequestResult {
  url?: string;
  skipped: boolean;
  reason?: string;
}

function encodeProjectPath(path: string): string {
  return encodeURIComponent(path);
}

export async function createGitlabMergeRequest(input: GitlabMergeRequestInput): Promise<MergeRequestResult> {
  const token = process.env.GITLAB_TOKEN;
  const apiBase = process.env.GITLAB_API_URL ?? "https://gitlab.com/api/v4";

  if (!token) {
    return { skipped: true, reason: "GITLAB_TOKEN not configured" };
  }

  const response = await fetch(`${apiBase}/projects/${encodeProjectPath(input.projectPath)}/merge_requests`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: input.title,
      description: `${input.description}\n\nAuto-merge: disabled. Human review required${
        input.requireHumanReview ? "" : " unless explicitly configured."
      }`,
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      remove_source_branch: false,
      squash: false,
      labels: input.labels.join(",")
    })
  });

  if (!response.ok) {
    return { skipped: true, reason: `GitLab MR creation failed: ${await response.text()}` };
  }

  const body = (await response.json()) as { web_url?: string };
  return { skipped: false, url: body.web_url };
}
