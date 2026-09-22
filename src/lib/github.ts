/**
 * The GitHub REST calls this tool makes, over Node's own `fetch` (ADR-051).
 *
 * Five calls - read a pull request and its diff (ADR-051), then list, create and update its
 * comments (ADR-052) - do not need Octokit. `fetch` is injected, so tests hand in canned
 * responses and never touch the network (CLAUDE.md). Every failure becomes one
 * {@link GitHubError} whose message says what to do about it: set a token, grant a permission,
 * wait for the rate limit, or check out the pull request and use `--git`.
 */

/** Where the REST API lives. GitHub Enterprise Server is not supported yet. */
export const GITHUB_API = "https://api.github.com";

/** The REST API version this client was written against (docs.github.com, September 2026). */
export const GITHUB_API_VERSION = "2026-03-10";

/** How long one request may take before it is abandoned. */
const TIMEOUT_MS = 30_000;

/** Most pages of comments read while looking for ours: 100 a page, so 5,000 comments. */
const MAX_COMMENT_PAGES = 50;

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

/** A comment on a pull request's conversation. */
export interface IssueComment {
  id: number;
  body: string;
  /** Where it can be seen, for the CLI to print. */
  htmlUrl: string;
}

/** What the tool reads from GitHub, and the one thing it writes. */
export interface GitHubClient {
  /** @throws GitHubError with a message that says what to do. */
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  /** The pull request's diff, base...head, as GitHub renders it. @throws GitHubError */
  getPullRequestDiff(repo: string, number: number): Promise<string>;
  /** Every comment on the pull request's conversation, oldest first. @throws GitHubError */
  listIssueComments(repo: string, number: number): Promise<IssueComment[]>;
  /** @throws GitHubError */
  createIssueComment(repo: string, number: number, body: string): Promise<IssueComment>;
  /** @throws GitHubError */
  updateIssueComment(repo: string, commentId: number, body: string): Promise<IssueComment>;
}

/** A GitHub request that failed, with a message meant to be printed as it is. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";

  /** GitHub refused to render the diff because of its size. */
  readonly tooLarge: boolean;
  /** A primary or secondary rate limit stopped the request; trying something else will not help. */
  readonly rateLimited: boolean;

  constructor(
    message: string,
    /** The HTTP status, or null when GitHub was never reached. */
    readonly status: number | null,
    details: { tooLarge?: boolean; rateLimited?: boolean; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.tooLarge = details.tooLarge ?? false;
    this.rateLimited = details.rateLimited ?? false;
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
  writing: boolean,
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
        { rateLimited: true },
      );
    }
    if (headers.get("x-ratelimit-remaining") === "0") {
      const reset = utcClock(headers.get("x-ratelimit-reset"));
      const when = reset === null ? "" : ` It resets at ${reset}.`;
      const hint = hasToken
        ? ""
        : " Without GITHUB_TOKEN the limit is 60 requests an hour; set it for more.";
      return new GitHubError(`GitHub's rate limit is used up.${when}${hint}`, status, {
        rateLimited: true,
      });
    }
    if (writing) {
      return new GitHubError(
        `GitHub refused to write ${what} (${said}). The token needs pull-requests: write - in ` +
          "Actions, `permissions: pull-requests: write` - and a pull request from a fork only " +
          "ever gets a read-only one.",
        status,
      );
    }
  }
  if (tooLarge || status === 406) {
    return new GitHubError(`GitHub will not render the diff of ${what} (${said}).`, status, {
      tooLarge: true,
    });
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

/** Narrows one comment from GitHub's JSON, or fails saying what was missing. */
export function parseIssueComment(json: unknown): IssueComment {
  const comment = (typeof json === "object" && json !== null ? json : {}) as Record<
    string,
    unknown
  >;
  if (typeof comment.id !== "number" || !Number.isInteger(comment.id)) {
    throw new GitHubError("GitHub's comment response has no id.", null);
  }
  return {
    id: comment.id,
    // A comment's body can be empty, and GitHub then sends null.
    body: typeof comment.body === "string" ? comment.body : "",
    htmlUrl: typeof comment.html_url === "string" ? comment.html_url : "",
  };
}

/** The `rel="next"` URL of a `Link` header, when there is one. */
export function nextPage(link: string | null): string | null {
  if (link === null) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  return match?.[1] ?? null;
}

/** Parses a JSON body, or fails naming what it was for. */
function jsonOf(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new GitHubError(`GitHub's answer for ${what} is not JSON.`, null, { cause });
  }
}

/** One request to the REST API. */
interface Request {
  method?: "GET" | "POST" | "PATCH";
  /** Must start with {@link GITHUB_API}: the token is never sent anywhere else. */
  url: string;
  accept?: string;
  /** Names the thing asked for, in error messages: "pull request acme/shop#7". */
  what: string;
  repo: string;
  body?: unknown;
}

/** Builds a client for the public GitHub REST API. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const { token } = options;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));

  /** Sends one request and returns the response when it succeeded. @throws GitHubError */
  async function send(request: Request): Promise<Response> {
    const { method = "GET", url, accept = "application/vnd.github+json", what, repo } = request;
    if (!isRepoName(repo)) {
      throw new GitHubError(`Expected a repository as owner/name, got "${repo}".`, null);
    }
    if (!url.startsWith(`${GITHUB_API}/`)) {
      throw new GitHubError(`Refusing to send a request outside ${GITHUB_API}: ${url}`, null);
    }
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "shadow-pr-review",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.name === "TimeoutError"
          ? `no answer within ${String(TIMEOUT_MS / 1000)} s`
          : cause instanceof Error
            ? cause.message
            : String(cause);
      throw new GitHubError(`Cannot reach GitHub for ${what} (${reason}).`, null, { cause });
    }
    if (!response.ok) {
      throw await failure(response, what, repo, token !== undefined, method !== "GET");
    }
    return response;
  }

  const repoUrl = (repo: string, path: string): string => `${GITHUB_API}/repos/${repo}${path}`;

  return {
    async getPullRequest(repo, number) {
      const what = `pull request ${repo}#${String(number)}`;
      const response = await send({ url: repoUrl(repo, `/pulls/${String(number)}`), what, repo });
      return parsePullRequest(jsonOf(await response.text(), what));
    },

    async getPullRequestDiff(repo, number) {
      const response = await send({
        url: repoUrl(repo, `/pulls/${String(number)}`),
        accept: "application/vnd.github.diff",
        what: `pull request ${repo}#${String(number)}`,
        repo,
      });
      return response.text();
    },

    async listIssueComments(repo, number) {
      const what = `pull request ${repo}#${String(number)}`;
      const comments: IssueComment[] = [];
      let url: string | null = repoUrl(repo, `/issues/${String(number)}/comments?per_page=100`);
      for (let page = 0; url !== null && page < MAX_COMMENT_PAGES; page += 1) {
        const response = await send({ url, what, repo });
        const json = jsonOf(await response.text(), what);
        if (!Array.isArray(json)) {
          throw new GitHubError(`GitHub's comment list for ${what} is not a list.`, null);
        }
        comments.push(...json.map(parseIssueComment));
        url = nextPage(response.headers.get("link"));
      }
      return comments;
    },

    async createIssueComment(repo, number, body) {
      const what = `a comment on pull request ${repo}#${String(number)}`;
      const response = await send({
        method: "POST",
        url: repoUrl(repo, `/issues/${String(number)}/comments`),
        what,
        repo,
        body: { body },
      });
      return parseIssueComment(jsonOf(await response.text(), what));
    },

    async updateIssueComment(repo, commentId, body) {
      const what = `comment ${String(commentId)} on ${repo}`;
      const response = await send({
        method: "PATCH",
        url: repoUrl(repo, `/issues/comments/${String(commentId)}`),
        what,
        repo,
        body: { body },
      });
      return parseIssueComment(jsonOf(await response.text(), what));
    },
  };
}
