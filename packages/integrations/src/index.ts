export type Provider = "github" | "gitlab";

export interface ReviewRequestInput {
  provider: Provider;
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
  labels?: string[];
  draft?: boolean;
}

export interface ReviewRequestResult {
  url?: string;
  skipped: boolean;
  reason?: string;
}

export async function createReviewRequest(input: ReviewRequestInput): Promise<ReviewRequestResult> {
  if (input.provider === "github") {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { skipped: true, reason: "GITHUB_TOKEN not configured" };

    const response = await fetch(`https://api.github.com/repos/${input.repository}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft ?? false
      })
    });

    if (!response.ok) {
      return { skipped: true, reason: `GitHub PR creation failed: ${await response.text()}` };
    }

    const created = (await response.json()) as { html_url?: string };
    return { skipped: false, url: created.html_url };
  }

  const token = process.env.GITLAB_TOKEN;
  const apiBase = process.env.GITLAB_API_URL ?? "https://gitlab.com/api/v4";
  if (!token) return { skipped: true, reason: "GITLAB_TOKEN not configured" };

  const response = await fetch(`${apiBase}/projects/${encodeURIComponent(input.repository)}/merge_requests`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: input.title,
      description: input.body,
      source_branch: input.head,
      target_branch: input.base,
      labels: (input.labels ?? []).join(","),
      draft: input.draft ?? false
    })
  });

  if (!response.ok) {
    return { skipped: true, reason: `GitLab MR creation failed: ${await response.text()}` };
  }

  const created = (await response.json()) as { web_url?: string };
  return { skipped: false, url: created.web_url };
}
