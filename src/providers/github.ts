interface GithubPullRequestInput {
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
  labels: string[];
  requireHumanReview: boolean;
  draft?: boolean;
}

export interface PullRequestResult {
  url?: string;
  number?: number;
  skipped: boolean;
  reason?: string;
}

export async function createGithubPullRequest(input: GithubPullRequestInput): Promise<PullRequestResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      skipped: true,
      reason: "GITHUB_TOKEN not configured"
    };
  }

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
      body: `${input.body}\n\nAuto-merge: disabled. Human review required${
        input.requireHumanReview ? "" : " unless explicitly configured."
      }`,
      maintainer_can_modify: false,
      draft: input.draft ?? false
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    return { skipped: true, reason: `GitHub PR creation failed: ${errorBody}` };
  }

  const created = (await response.json()) as { html_url?: string; number?: number };

  if (input.labels.length > 0 && created.number) {
    await fetch(`https://api.github.com/repos/${input.repository}/issues/${created.number}/labels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ labels: input.labels })
    });
  }

  return { skipped: false, url: created.html_url, number: created.number };
}

export async function markGithubPullRequestReady(repository: string, pullNumber: number): Promise<PullRequestResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { skipped: true, reason: "GITHUB_TOKEN not configured" };
  }

  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pullNumber}/ready_for_review`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    return { skipped: true, reason: `GitHub PR ready-for-review failed: ${await response.text()}` };
  }

  const body = (await response.json()) as { html_url?: string };
  return { skipped: false, url: body.html_url };
}
