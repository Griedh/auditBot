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

interface RetryOptions {
  retries: number;
  initialDelayMs: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function withRetry(
  request: () => Promise<Response>,
  context: string,
  options: RetryOptions = { retries: 3, initialDelayMs: 400 }
): Promise<Response> {
  let attempt = 0;
  let delayMs = options.initialDelayMs;
  let lastError: unknown;

  while (attempt <= options.retries) {
    try {
      const response = await request();
      if (!isRetryableStatus(response.status) || attempt === options.retries) {
        return response;
      }
    } catch (error: unknown) {
      lastError = error;
      if (attempt === options.retries) {
        throw new Error(`${context} failed after ${attempt + 1} attempts: ${String(lastError)}`);
      }
    }

    await wait(delayMs);
    delayMs *= 2;
    attempt += 1;
  }

  throw new Error(`${context} failed after ${options.retries + 1} attempts: ${String(lastError)}`);
}

export async function createReviewRequest(input: ReviewRequestInput): Promise<ReviewRequestResult> {
  if (input.provider === "github") {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { skipped: true, reason: "GITHUB_TOKEN not configured" };

    let response: Response;
    try {
      response = await withRetry(
        () =>
          fetch(`https://api.github.com/repos/${input.repository}/pulls`, {
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
          }),
        "GitHub PR creation"
      );
    } catch (error: unknown) {
      return { skipped: true, reason: String(error) };
    }

    if (!response.ok) {
      return { skipped: true, reason: `GitHub PR creation failed: ${await response.text()}` };
    }

    const created = (await response.json()) as { html_url?: string };
    return { skipped: false, url: created.html_url };
  }

  const token = process.env.GITLAB_TOKEN;
  const apiBase = process.env.GITLAB_API_URL ?? "https://gitlab.com/api/v4";
  if (!token) return { skipped: true, reason: "GITLAB_TOKEN not configured" };

  let response: Response;
  try {
    response = await withRetry(
      () =>
        fetch(`${apiBase}/projects/${encodeURIComponent(input.repository)}/merge_requests`, {
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
        }),
      "GitLab MR creation"
    );
  } catch (error: unknown) {
    return { skipped: true, reason: String(error) };
  }

  if (!response.ok) {
    return { skipped: true, reason: `GitLab MR creation failed: ${await response.text()}` };
  }

  const created = (await response.json()) as { web_url?: string };
  return { skipped: false, url: created.web_url };
}
