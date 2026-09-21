/**
 * The GitHub REST calls this tool makes, over Node's own `fetch` (ADR-051).
 *
 * Two GET requests do not need Octokit. `fetch` is injected, so tests hand in canned responses
 * and never touch the network (CLAUDE.md). Every failure becomes one {@link GitHubError} whose
 * message says what to do about it: set a token, wait for the rate limit, or check out the pull
 * request and use `--git`. Step 2's sticky comment is where pagination starts, and where Octokit
 * may start to pay; nothing here would have to be undone for it.
 */

/** Where the REST API lives. GitHub Enterprise Server is not supported yet. */
export const GITHUB_API = "https://api.github.com";

/** The REST API version this client was written against (docs.github.com, September 2026). */
export const GITHUB_API_VERSION = "2026-03-10";

/** How long one request may take before it is abandoned. */
const TIMEOUT_MS = 30_000;

/** The subset of `fetch` the client uses, so a test can supply its own. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Options for {@link createGitHubClient}. */
export interface GitHubClientOptions {
  /** `GITHUB_TOKEN`, when set. Public repositories need none. */
  token?: string;
  /** Defaults to the global `fetch`. */
  fetch?: Fetch;
}

/** The parts of a pull request that ingest records. */
export interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  /** `open` or `closed`; a merged pull request is `closed`. */
  state: string;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
}

/** What the tool reads from GitHub. */
export interface GitHubClient {
  /** @throws GitHubError with a message that says what to do. */
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  /** The pull request's diff, base...head, as GitHub renders it. @throws GitHubError */
  getPullRequestDiff(repo: string, number: number): Promise<string>;
}

/** A GitHub request that failed, with a message meant to be printed as it is. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";

  constructor(
    message: string,
    /** The HTTP status, or null when GitHub was never reached. */
    readonly status: number | null,
    /** GitHub refused to render the diff because of its size. */
    readonly tooLarge = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * True for `owner/name` as GitHub allows them. The value goes into a URL path, so anything
 * else - a slash too many, `..`, a query string - is refused rather than encoded.
 */
export function isRepoName(repo: string): boolean {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repo) &&
    !/\/\.\.?$/.test(repo)
  );
}

/** Reads GitHub's own error message out of a response body, when it has one. */
function githubMessage(body: string): { message: string | null; tooLarge: boolean } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { message: null, tooLarge: false };
  }
  if (typeof json !== "object" || json === null) return { message: null, tooLarge: false };
  const { message, errors } = json as { message?: unknown; errors?: unknown };
  const tooLarge =
    Array.isArray(errors) &&
    errors.some(
      (e: unknown) =>
        typeof e === "object" && e !== null && (e as { code?: unknown }).code === "too_large",
    );
  return { message: typeof message === "string" ? message : null, tooLarge };
}

/** `1758499200` -> `00:00 UTC`. */
function utcClock(epochSeconds: string | null): string | null {
  const seconds = Number(epochSeconds);
  if (epochSeconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return `${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC`;
}

/** Turns a failed response into the one line the CLI prints. */
async function failure(
  response: Response,
  what: string,
  repo: string,
  hasToken: boolean,
): Promise<GitHubError> {
  const { status, headers } = response;
  const { message, tooLarge } = githubMessage(await response.text().catch(() => ""));
  const said = message === null ? `${status}` : `${status}: ${message}`;

  if (status === 401) {
    return new GitHubError(`GitHub rejected GITHUB_TOKEN (${said}).`, status);
  }
  if (status === 404) {
    const subject = what.charAt(0).toUpperCase() + what.slice(1);
    return new GitHubError(
      hasToken
        ? `${subject} was not found, or GITHUB_TOKEN cannot read ${repo}.`
        : `${subject} was not found. If ${repo} is private, set GITHUB_TOKEN to a token that can read it.`,
      status,
    );
  }
  if (status === 403 || status === 429) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
      return new GitHubError(
        `GitHub's secondary rate limit stopped ${what}; wait ${retryAfter} seconds and run again.`,
        status,
      );
    }
    if (headers.get("x-ratelimit-remaining") === "0") {
      const reset = utcClock(headers.get("x-ratelimit-reset"));
      const when = reset === null ? "" : ` It resets at ${reset}.`;
      const hint = hasToken
        ? ""
        : " Without GITHUB_TOKEN the limit is 60 requests an hour; set it for more.";
      return new GitHubError(`GitHub's rate limit is used up.${when}${hint}`, status);
    }
  }
  if (tooLarge || status === 406) {
    return new GitHubError(`GitHub will not render the diff of ${what} (${said}).`, status, true);
  }
  return new GitHubError(`GitHub answered ${said} for ${what}.`, status);
}

/** Reads a string field, or fails naming it. */
function stringAt(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new GitHubError(`GitHub's pull request response has no ${field}.`, null);
  }
  return value;
}

/** Narrows GitHub's pull request JSON to the fields ingest records, checking each one. */
export function parsePullRequest(json: unknown): PullRequest {
  if (typeof json !== "object" || json === null) {
    throw new GitHubError("GitHub's pull request response is not an object.", null);
  }
  const pr = json as Record<string, unknown>;
  const head = (typeof pr.head === "object" && pr.head !== null ? pr.head : {}) as Record<
    string,
    unknown
  >;
  const base = (typeof pr.base === "object" && pr.base !== null ? pr.base : {}) as Record<
    string,
    unknown
  >;
  if (typeof pr.number !== "number" || !Number.isInteger(pr.number) || pr.number < 1) {
    throw new GitHubError("GitHub's pull request response has no number.", null);
  }
  const headSha = stringAt(head.sha, "head.sha");
  const baseSha = stringAt(base.sha, "base.sha");
  for (const [field, sha] of [
    ["head.sha", headSha],
    ["base.sha", baseSha],
  ] as const) {
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new GitHubError(`GitHub's pull request response has an invalid ${field}.`, null);
    }
  }
  return {
    number: pr.number,
    title: stringAt(pr.title, "title"),
    // Absent on old API versions, where there were no drafts.
    draft: pr.draft === true,
    state: stringAt(pr.state, "state"),
    headSha,
    headRef: stringAt(head.ref, "head.ref"),
    baseSha,
    baseRef: stringAt(base.ref, "base.ref"),
  };
}

/** Builds a client for the public GitHub REST API. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const { token } = options;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));

  async function get(repo: string, path: string, accept: string, what: string): Promise<string> {
    if (!isRepoName(repo)) {
      throw new GitHubError(`Expected a repository as owner/name, got "${repo}".`, null);
    }
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "shadow-pr-review",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await doFetch(`${GITHUB_API}/repos/${repo}${path}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.name === "TimeoutError"
          ? `no answer within ${TIMEOUT_MS / 1000} s`
          : cause instanceof Error
            ? cause.message
            : String(cause);
      throw new GitHubError(`Cannot reach GitHub for ${what} (${reason}).`, null, false, {
        cause,
      });
    }
    if (!response.ok) throw await failure(response, what, repo, token !== undefined);
    return response.text();
  }

  return {
    async getPullRequest(repo, number) {
      const what = `pull request ${repo}#${number}`;
      const body = await get(repo, `/pulls/${number}`, "application/vnd.github+json", what);
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch (cause) {
        throw new GitHubError(`GitHub's answer for ${what} is not JSON.`, null, false, { cause });
      }
      return parsePullRequest(json);
    },

    getPullRequestDiff(repo, number) {
      return get(
        repo,
        `/pulls/${number}`,
        "application/vnd.github.diff",
        `pull request ${repo}#${number}`,
      );
    },
  };
}
