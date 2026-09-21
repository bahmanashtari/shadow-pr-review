/**
 * The GitHub client against canned responses: what it sends, what it reads back, and the one
 * line each failure turns into. No request leaves the process (CLAUDE.md).
 */
import { describe, expect, it } from "vitest";
import {
  createGitHubClient,
  GITHUB_API_VERSION,
  GitHubError,
  isRepoName,
  parsePullRequest,
  type Fetch,
} from "../../src/lib/github.js";
import { PR_BASE_SHA, PR_HEAD_SHA, pullRequestJson } from "../helpers.js";

const HEAD = PR_HEAD_SHA;
const BASE = PR_BASE_SHA;

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that records each request and answers from the list, in order. */
function fakeFetch(...responses: (() => Response)[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected request ${url}`);
    return Promise.resolve(next());
  };
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

/** Catches the error a promise rejects with, typed. */
async function failureOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubError) return error;
    throw error;
  }
  throw new Error("expected a GitHubError");
}

describe("createGitHubClient", () => {
  it("reads a pull request and sends no token when there is none", async () => {
    const { fetch, calls } = fakeFetch(json(pullRequestJson()));
    const pr = await createGitHubClient({ fetch }).getPullRequest("acme/shop", 142);

    expect(pr).toEqual({
      number: 142,
      title: "Publish OrderPlaced through the outbox",
      draft: false,
      state: "open",
      headSha: HEAD,
      headRef: "feature/outbox",
      baseSha: BASE,
      baseRef: "main",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/shop/pulls/142");
    expect(calls[0]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "shadow-pr-review",
    });
  });

  it("asks for the diff media type and sends the token when there is one", async () => {
    const diff = "diff --git a/x.ts b/x.ts\n";
    const { fetch, calls } = fakeFetch(() => new Response(diff));
    const client = createGitHubClient({ fetch, token: "ghp_secret" });

    expect(await client.getPullRequestDiff("acme/shop", 142)).toBe(diff);
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.diff");
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghp_secret");
  });

  it("refuses a repository that is not owner/name, without a request", async () => {
    const { fetch, calls } = fakeFetch();
    for (const repo of ["acme", "acme/shop/pulls", "acme/..", "../x", "acme/shop?x=1", ""]) {
      const error = await failureOf(createGitHubClient({ fetch }).getPullRequest(repo, 1));
      expect(error.message).toContain("owner/name");
    }
    expect(calls).toEqual([]);
  });

  it("says a missing pull request may be a private repository without a token", async () => {
    const { fetch } = fakeFetch(json({ message: "Not Found" }, 404));
    const error = await failureOf(createGitHubClient({ fetch }).getPullRequest("acme/shop", 7));
    expect(error.message).toBe(
      "Pull request acme/shop#7 was not found. If acme/shop is private, " +
        "set GITHUB_TOKEN to a token that can read it.",
    );
    expect(error.status).toBe(404);
  });

  it("says the token may not reach the repository when there is one", async () => {
    const { fetch } = fakeFetch(json({ message: "Not Found" }, 404));
    const client = createGitHubClient({ fetch, token: "t" });
    const error = await failureOf(client.getPullRequest("acme/shop", 7));
    expect(error.message).toBe(
      "Pull request acme/shop#7 was not found, or GITHUB_TOKEN cannot read acme/shop.",
    );
  });

  it("names a rejected token", async () => {
    const { fetch } = fakeFetch(json({ message: "Bad credentials" }, 401));
    const error = await failureOf(
      createGitHubClient({ fetch, token: "t" }).getPullRequest("acme/shop", 7),
    );
    expect(error.message).toBe("GitHub rejected GITHUB_TOKEN (401: Bad credentials).");
  });

  it("says when the rate limit resets, and that a token raises it", async () => {
    const { fetch } = fakeFetch(
      json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Date.UTC(2026, 8, 21, 14, 5) / 1000),
      }),
    );
    const error = await failureOf(createGitHubClient({ fetch }).getPullRequest("acme/shop", 7));
    expect(error.message).toBe(
      "GitHub's rate limit is used up. It resets at 14:05 UTC. Without GITHUB_TOKEN the limit " +
        "is 60 requests an hour; set it for more.",
    );
  });

  it("says how long to wait on a secondary rate limit", async () => {
    const { fetch } = fakeFetch(json({ message: "slow down" }, 429, { "retry-after": "60" }));
    const error = await failureOf(createGitHubClient({ fetch }).getPullRequest("acme/shop", 7));
    expect(error.message).toBe(
      "GitHub's secondary rate limit stopped pull request acme/shop#7; wait 60 seconds and run again.",
    );
  });

  it("marks a diff GitHub will not render as too large, quoting GitHub's limit", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          message: "Sorry, the diff exceeded the maximum number of lines (20000)",
          errors: [{ resource: "PullRequest", field: "diff", code: "too_large" }],
        },
        406,
      ),
    );
    const error = await failureOf(createGitHubClient({ fetch }).getPullRequestDiff("acme/shop", 7));
    expect(error.tooLarge).toBe(true);
    expect(error.message).toBe(
      "GitHub will not render the diff of pull request acme/shop#7 " +
        "(406: Sorry, the diff exceeded the maximum number of lines (20000)).",
    );
  });

  it("reports any other status by its code", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await failureOf(createGitHubClient({ fetch }).getPullRequest("acme/shop", 7));
    expect(error.message).toBe("GitHub answered 502 for pull request acme/shop#7.");
  });

  it("says when GitHub cannot be reached at all", async () => {
    const fetch: Fetch = () => Promise.reject(new TypeError("fetch failed"));
    const error = await failureOf(createGitHubClient({ fetch }).getPullRequest("acme/shop", 7));
    expect(error.message).toBe("Cannot reach GitHub for pull request acme/shop#7 (fetch failed).");
    expect(error.status).toBeNull();
  });
});

describe("parsePullRequest", () => {
  it("treats a missing draft flag as not a draft", () => {
    const json = pullRequestJson();
    delete json.draft;
    expect(parsePullRequest(json).draft).toBe(false);
  });

  it.each([
    ["head.sha", { head: { ref: "x" } }],
    ["base.ref", { base: { sha: BASE } }],
    ["title", { title: null }],
    ["number", { number: "142" }],
  ])("names a missing %s", (field, over) => {
    expect(() => parsePullRequest(pullRequestJson(over))).toThrow(field);
  });

  it("refuses a sha that is not 40 hex characters", () => {
    expect(() => parsePullRequest(pullRequestJson({ head: { ref: "x", sha: "abc" } }))).toThrow(
      "invalid head.sha",
    );
  });
});

describe("isRepoName", () => {
  it.each([
    ["acme/shop", true],
    ["acme-co/shop.api_v2", true],
    ["acme/.github", true],
    ["-acme/shop", false],
    ["acme/.", false],
    ["acme/shop/", false],
  ])("%s -> %s", (repo, expected) => {
    expect(isRepoName(repo)).toBe(expected);
  });
});
