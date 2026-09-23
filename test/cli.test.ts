import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram, main } from "../src/cli.js";
import { fromRoot } from "../src/lib/paths.js";
import { validateContract } from "../src/contracts/validate.js";
import { PR_BASE_SHA, PR_HEAD_SHA, pullRequestJson } from "./helpers.js";

const run = (...args: string[]): Promise<void> => main(["node", "spr", ...args]);

/**
 * Runs something with the fake LLM provider, so the Review stage needs no model.
 *
 * The cache goes to a temporary folder for the same reason {@link withFakeProviders} sends the
 * clips to one: without it a test writes model answers into the developer's own `.cache/spr`,
 * keyed on the real prompt and the real schema. A later run then gets served whatever the fake
 * happened to answer at the time - which is exactly how a stale answer survived a prompt change
 * during this step and looked like a cache-invalidation bug.
 */
async function withFakeProvider(body: () => Promise<void>): Promise<void> {
  const previous = { provider: process.env.SPR_LLM_PROVIDER, cache: process.env.SPR_CACHE_DIR };
  process.env.SPR_LLM_PROVIDER = "fake";
  process.env.SPR_CACHE_DIR ??= tempDir();
  try {
    await body();
  } finally {
    if (previous.provider === undefined) delete process.env.SPR_LLM_PROVIDER;
    else process.env.SPR_LLM_PROVIDER = previous.provider;
    if (previous.cache === undefined) delete process.env.SPR_CACHE_DIR;
    else process.env.SPR_CACHE_DIR = previous.cache;
  }
}

/**
 * Runs something with no model and no speech container: `SPR_TTS_PROVIDER=fake` returns
 * real WAV bytes, so the whole pipeline walks offline. The cache goes to a temporary folder
 * so a test never writes clips into the developer's own `.cache/spr`.
 */
async function withFakeProviders(cacheDir: string, body: () => Promise<void>): Promise<void> {
  const previous = { tts: process.env.SPR_TTS_PROVIDER, cache: process.env.SPR_CACHE_DIR };
  process.env.SPR_TTS_PROVIDER = "fake";
  process.env.SPR_CACHE_DIR = cacheDir;
  try {
    await withFakeProvider(body);
  } finally {
    if (previous.tts === undefined) delete process.env.SPR_TTS_PROVIDER;
    else process.env.SPR_TTS_PROVIDER = previous.tts;
    if (previous.cache === undefined) delete process.env.SPR_CACHE_DIR;
    else process.env.SPR_CACHE_DIR = previous.cache;
  }
}

const GOLDEN_DIFF = fromRoot("golden", "sample-02-inventory-consumer", "diff.patch");

/**
 * Runs something with GitHub answered by `respond` instead of the network, and with no token
 * in the environment, so the developer's own `GITHUB_TOKEN` neither leaks into a request nor
 * changes an error message.
 */
async function withGitHub(
  respond: (url: string, accept: string, method: string) => Response,
  body: () => Promise<void>,
  token?: string,
): Promise<void> {
  const previous = { github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  if (token !== undefined) process.env.GITHUB_TOKEN = token;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    return Promise.resolve(respond(url, headers.Accept ?? "", init.method ?? "GET"));
  });
  try {
    await body();
  } finally {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    if (previous.github !== undefined) process.env.GITHUB_TOKEN = previous.github;
    if (previous.gh !== undefined) process.env.GH_TOKEN = previous.gh;
  }
}

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-cli-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("spr CLI", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("validate accepts the golden fixtures", async () => {
    const dir = fromRoot("golden", "sample-02-inventory-consumer");
    await run("validate", `${dir}/review.expected.json`, `${dir}/script.expected.json`);
    expect(process.exitCode).toBeUndefined();
    expect(out).toHaveLength(2);
    expect(out.every((line) => line.startsWith("ok"))).toBe(true);
  });

  it("validate fails when the contract cannot be inferred", async () => {
    await run("validate", fromRoot("config", "default.json"));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("pass --schema");
  });

  it("validate knows the golden labels and an eval report by name", async () => {
    await run("validate", fromRoot("golden", "sample-01-order-outbox", "labels.json"));
    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("(labels)");
  });

  it("validate --schema reports schema errors", async () => {
    await run("validate", "--schema", "timeline", fromRoot("config", "default.json"));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("FAIL");
  });

  it("stage publish --dry-run renders comment.md and posts nothing", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "verify", "--out", runDir),
    );
    out.length = 0;
    await run("stage", "publish", "--run", runDir, "--dry-run");

    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain(`comment: ${path.join(runDir, "comment.md")} (2 findings)`);
    expect(readFileSync(path.join(runDir, "comment.md"), "utf8")).toMatch(
      /^<!-- shadow-pr-review -->\n/,
    );
  });

  it("stage publish without a token says so and keeps the comment", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "verify", "--out", runDir),
    );
    err.length = 0;
    await withGitHub(
      () => new Response("unexpected", { status: 500 }),
      () => run("stage", "publish", "--run", runDir),
    );
    expect(process.exitCode).toBe(1);
    expect(err).toEqual([
      `spr: [publish] This run reviewed a local diff with no GitHub repository behind it, so ` +
        `there is nothing to post to. The comment is in ${path.join(runDir, "comment.md")}.`,
    ]);
  });

  it("stage publish posts the comment on the pull request the run reviewed", async () => {
    const runDir = tempDir();
    const diff = readFileSync(GOLDEN_DIFF, "utf8");
    const writes: string[] = [];
    await withGitHub(
      (url, accept, method) => {
        if (url.endsWith("/pulls/142")) {
          return accept === "application/vnd.github.diff"
            ? new Response(diff)
            : new Response(JSON.stringify(pullRequestJson()));
        }
        if (method === "GET") return new Response("[]");
        writes.push(`${method} ${url}`);
        return new Response(
          JSON.stringify({
            id: 9,
            body: "x",
            html_url: "https://github.com/acme/shop/pull/142#c9",
          }),
          { status: 201 },
        );
      },
      async () => {
        await withFakeProvider(() =>
          run("run", "--pr", "142", "--repo", "acme/shop", "--until", "verify", "--out", runDir),
        );
        out.length = 0;
        await run(
          "stage",
          "publish",
          "--run",
          runDir,
          "--video-url",
          "https://github.com/acme/shop/actions/runs/1/artifacts/2",
        );
      },
      "test-token",
    );

    expect(err).toEqual([]);
    expect(writes).toEqual(["POST https://api.github.com/repos/acme/shop/issues/142/comments"]);
    expect(out.join("\n")).toContain("posted: created https://github.com/acme/shop/pull/142#c9");
    // --until verify made no video, so the URL is not linked to a video this review lacks.
    expect(out.join("\n")).toContain("--video-url ignored");
  });

  it("stage refuses publish's options on other stages", async () => {
    await run("stage", "direct", "--run", tempDir(), "--dry-run");
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("--video-url, --dry-run and --commit-comment go with publish");
  });

  it("a clean run renders the no-findings comment and exits 0 without a video", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run(
        "run",
        "--diff",
        fromRoot("golden", "sample-03-email-value-object", "diff.patch"),
        "--out",
        runDir,
      ),
    );
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(path.join(runDir, "comment.md"), "utf8")).toContain("**No findings**.");
    expect(existsSync(path.join(runDir, "final.mp4"))).toBe(false);
  });

  it("run --pr reads the pull request from GitHub and writes the same three files", async () => {
    const requests: { url: string; accept: string }[] = [];
    const diff = readFileSync(GOLDEN_DIFF, "utf8");
    const runDir = tempDir();
    await withGitHub(
      (url, accept) => {
        requests.push({ url, accept });
        return accept === "application/vnd.github.diff"
          ? new Response(diff)
          : new Response(JSON.stringify(pullRequestJson()));
      },
      () => run("run", "--pr", "142", "--repo", "acme/shop", "--until", "ingest", "--out", runDir),
    );

    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/shop/pulls/142",
        accept: "application/vnd.github+json",
      },
      {
        url: "https://api.github.com/repos/acme/shop/pulls/142",
        accept: "application/vnd.github.diff",
      },
    ]);
    const ingest = JSON.parse(readFileSync(path.join(runDir, "ingest.json"), "utf8")) as {
      source: unknown;
    };
    expect(ingest.source).toEqual({
      type: "pull_request",
      repo: "acme/shop",
      pr_number: 142,
      ref: "feature/outbox",
      base_sha: PR_BASE_SHA,
      head_sha: PR_HEAD_SHA,
      title: "Publish OrderPlaced through the outbox",
    });
    expect(readFileSync(path.join(runDir, "diff.raw.patch"), "utf8")).toBe(diff);
  });

  it("run --pr on a pull request GitHub cannot find prints one line and exits 1", async () => {
    await withGitHub(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      () => run("run", "--pr", "7", "--repo", "acme/shop", "--out", tempDir()),
    );
    expect(process.exitCode).toBe(1);
    expect(err).toEqual([
      "spr: [ingest] Pull request acme/shop#7 was not found. If acme/shop is private, " +
        "set GITHUB_TOKEN to a token that can read it.",
    ]);
  });

  it("run refuses a --pr that is not a pull request number", async () => {
    // Commander rejects an option value itself and exits the process, so ask it to throw.
    const program = buildProgram();
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({ writeErr: () => undefined });
    }
    for (const value of ["12a", "0", "-3", "1.5"]) {
      await expect(program.parseAsync(["node", "spr", "run", "--pr", value])).rejects.toThrow(
        `Expected a pull request number such as 142, got "${value}"`,
      );
    }
  });

  it("run refuses a second source beside --pr, and --repo without it", async () => {
    await run("run", "--pr", "12", "--diff", GOLDEN_DIFF);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("Pass exactly one of --diff, --git or --pr");

    err.length = 0;
    await run("run", "--diff", GOLDEN_DIFF, "--repo", "acme/shop");
    expect(err.join("\n")).toContain("--repo goes with --pr");
  });

  it("run --until ingest writes the three files and exits cleanly", async () => {
    const runDir = tempDir();
    await run("run", "--diff", GOLDEN_DIFF, "--until", "ingest", "--out", runDir);

    expect(process.exitCode).toBeUndefined();
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain(`run folder: ${runDir}`);
    expect(out.join("\n")).toContain("2 files: 2 kept (+31 -0)");
    for (const name of ["diff.raw.patch", "diff.patch", "ingest.json"]) {
      expect(existsSync(path.join(runDir, name))).toBe(true);
    }
  });

  it("run --until review writes a review and exits cleanly", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "review", "--out", runDir),
    );

    // The fake provider has no scripted turns, so the model contributes nothing; the
    // deterministic checks still produce a valid review, which is the point of the split.
    expect(existsSync(path.join(runDir, "review.raw.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "trace.jsonl"))).toBe(true);
    expect(out.join("\n")).toContain("from checks");
  });

  it("run --until verify writes review.json and exits cleanly", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "verify", "--out", runDir),
    );

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(runDir, "review.json"))).toBe(true);
    // The analyzers find the NOT NULL column and the empty down(), and both survive.
    expect(out.join("\n")).toContain("2 findings kept, none dropped");
  });

  it("run --until narrate writes script.json and exits cleanly", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "narrate", "--out", runDir),
    );

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(runDir, "script.json"))).toBe(true);
    // Two findings survive verify, so the script is intro + two + wrap-up.
    expect(out.join("\n")).toContain("script: 2 steps");
    // One cost.json covers every stage of the run, not just the last one that called a model.
    expect(existsSync(path.join(runDir, "cost.json"))).toBe(true);
  });

  it("run --until direct walks the whole pipeline that costs nothing to run", async () => {
    // This used to be the "run with no --until" test, asserting the exit code 2 at the first
    // unbuilt stage. Now that `record` is built, a bare `spr run` records a video in real
    // time - about forty seconds for this sample - which does not belong in a unit suite. The
    // unbuilt-stage message is covered by the `stage compose` test below, and the full
    // no---until path is exercised by Milestone 2 step 6's end-to-end run.
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "direct", "--out", runDir),
    );

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(path.join(runDir, "script.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "audio", "manifest.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "timeline.json"))).toBe(true);
  });

  it("run --until direct writes a timeline that matches the clips it measured", async () => {
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "direct", "--out", runDir),
    );

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toMatch(/timeline: 2 steps, \d+ actions, \d+:\d{2} of video/);

    const timeline: unknown = JSON.parse(readFileSync(path.join(runDir, "timeline.json"), "utf8"));
    const result = validateContract("timeline", timeline);
    expect(result.ok ? [] : result.errors).toEqual([]);

    // The windows are the measured durations, not the script's word-count estimates.
    const manifest = JSON.parse(
      readFileSync(path.join(runDir, "audio", "manifest.json"), "utf8"),
    ) as { clips: { step_id: string; duration_ms: number }[] };
    const windows = (
      timeline as { step_windows: { step_id: string; start_ms: number; end_ms: number }[] }
    ).step_windows;
    for (const clip of manifest.clips) {
      const window = windows.find((w) => w.step_id === clip.step_id);
      expect(window && window.end_ms - window.start_ms).toBe(clip.duration_ms);
    }
  });

  it("stage direct re-runs from script.json and audio/manifest.json", async () => {
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "direct", "--out", runDir),
    );
    out.length = 0;

    // No provider needed: the stage reads two files and writes one, with no model and no audio.
    await run("stage", "direct", "--run", runDir);

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("re-running direct");
    expect(out.join("\n")).toContain("timeline: 2 steps");
  });

  it("stage direct says which file is missing when tts has not run", async () => {
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "narrate", "--out", runDir),
    );

    await run("stage", "direct", "--run", runDir);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/\[direct\] Cannot read .*manifest\.json/);
  });

  it("run --until tts writes the clips and the manifest, with no container", async () => {
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "tts", "--out", runDir),
    );

    expect(process.exitCode).toBeUndefined();
    // Two findings survive verify, and a script is one step per finding (ADR-042).
    for (const id of ["S00", "S01"]) {
      expect(existsSync(path.join(runDir, "audio", `${id}.wav`))).toBe(true);
    }
    expect(out.join("\n")).toMatch(/audio: 2 clips, \d+:\d{2} of speech/);

    const manifest: unknown = JSON.parse(
      readFileSync(path.join(runDir, "audio", "manifest.json"), "utf8"),
    );
    const result = validateContract("audio-manifest", manifest);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("stage tts re-runs from script.json, and the second run is a cache hit", async () => {
    const runDir = tempDir();
    const cacheDir = tempDir();
    await withFakeProviders(cacheDir, () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "tts", "--out", runDir),
    );
    out.length = 0;

    await withFakeProviders(cacheDir, () => run("stage", "tts", "--run", runDir));

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("re-running tts");
    expect(out.join("\n")).toContain("(2 cached)");
  });

  it("stage tts says which file is missing when there is no script yet", async () => {
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "ingest", "--out", runDir),
    );

    await withFakeProviders(tempDir(), () => run("stage", "tts", "--run", runDir));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/\[tts\] Cannot read .*script\.json/);
  });

  it("stops after verify with no video when nothing was found, and exits cleanly", async () => {
    // ADR-042: a video exists to explain issues that were found. sample-03's only finding
    // comes from the model, so under the fake provider its review is genuinely clean - and a
    // clean review is a correct outcome, not a failure, so there is no exit code to set.
    const runDir = tempDir();
    await withFakeProviders(tempDir(), () =>
      run(
        "run",
        "--diff",
        fromRoot("golden", "sample-03-email-value-object", "diff.patch"),
        "--out",
        runDir,
      ),
    );

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("no findings survived verification");
    expect(existsSync(path.join(runDir, "review.json"))).toBe(true);
    for (const file of ["script.json", "timeline.json", "video.webm", "final.mp4"]) {
      expect(existsSync(path.join(runDir, file)), file).toBe(false);
    }
  });

  it("stage narrate re-runs the Narrator over an existing run folder", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "verify", "--out", runDir),
    );
    out.length = 0;

    await withFakeProvider(() => run("stage", "narrate", "--run", runDir));

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("re-running narrate");
    expect(out.join("\n")).toContain("script: 2 steps");
    const script = JSON.parse(readFileSync(path.join(runDir, "script.json"), "utf8")) as {
      steps: { id: string; finding_id: string }[];
    };
    expect(script.steps.map((s) => s.id)).toEqual(["S00", "S01"]);
    expect(script.steps.map((s) => s.finding_id)).toEqual(["F01", "F02"]);
  });

  it("stage verify re-runs the checks on an existing run folder, with no model", async () => {
    const runDir = tempDir();
    await withFakeProvider(() =>
      run("run", "--diff", GOLDEN_DIFF, "--until", "review", "--out", runDir),
    );
    out.length = 0;

    // No SPR_LLM_PROVIDER here: the stage reads two files and writes one.
    await run("stage", "verify", "--run", runDir);

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("re-running verify");
    expect(out.join("\n")).toContain("findings kept");
  });

  it("run needs exactly one source", async () => {
    await run("run");
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("Pass exactly one of --diff, --git or --pr");
  });

  it("run refuses a run folder that already has files", async () => {
    const runDir = tempDir();
    writeFileSync(path.join(runDir, "leftover.txt"), "x", "utf8");
    await run("run", "--diff", GOLDEN_DIFF, "--until", "ingest", "--out", runDir);
    expect(process.exitCode).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("[ingest] Run folder is not empty");

    process.exitCode = undefined;
    await run("run", "--diff", GOLDEN_DIFF, "--until", "ingest", "--out", runDir, "--force");
    expect(process.exitCode).toBeUndefined();
  });

  it("stage ingest re-filters the raw diff with the current config", async () => {
    const runDir = tempDir();
    await run("run", "--diff", GOLDEN_DIFF, "--until", "ingest", "--out", runDir);

    const extraConfig = path.join(tempDir(), "extra.json");
    writeFileSync(
      extraConfig,
      JSON.stringify({ ingest: { ignoreGlobs: ["**/migrations/**"] } }),
      "utf8",
    );
    const previous = process.env.SPR_CONFIG;
    process.env.SPR_CONFIG = extraConfig;
    out.length = 0;
    try {
      await run("stage", "ingest", "--run", runDir);
    } finally {
      if (previous === undefined) delete process.env.SPR_CONFIG;
      else process.env.SPR_CONFIG = previous;
    }

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("2 files: 1 kept (+20 -0), 1 skipped (1 ignored_by_config)");
    const ingest = JSON.parse(readFileSync(path.join(runDir, "ingest.json"), "utf8")) as {
      source: { type: string };
      skipped: { file: string }[];
    };
    // The source survives a re-run; only the filtering is redone.
    expect(ingest.source.type).toBe("local_diff");
    expect(ingest.skipped).toHaveLength(1);
  });

  it("eval scores the golden set and writes a report", async () => {
    const outDir = tempDir();
    await withFakeProvider(() => run("eval", "--out", outDir));

    expect(process.exitCode).toBeUndefined();
    const file = path.join(outDir, "eval.json");
    expect(existsSync(file)).toBe(true);

    const report: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = validateContract("eval", report);
    expect(result.ok ? [] : result.errors).toEqual([]);

    const text = out.join("\n");
    expect(text).toContain("sample-01-order-outbox");
    expect(text).toContain("TOTAL");
    // With no model, only the deterministic analyzers contribute (ADR-022), and they never
    // invent anything: the run misses judgement calls but keeps its precision. Asserted as a
    // rate rather than a count, because the count moves every time the golden set grows.
    const totals = text.split("\n").find((line) => line.startsWith("TOTAL"));
    expect(totals).toMatch(/must_find/);
    expect(totals).toMatch(/\s1\.000\s/);
    // A sample that kept nothing has nothing to narrate (ADR-042), which is not a failure of the
    // Narrate stage. The fake provider keeps nothing on several samples, restraint ones included.
    const { models } = report as {
      models: { samples: { review: { kept: number }; script: unknown }[] }[];
    };
    const clean = (models[0]?.samples ?? []).filter((s) => s.review.kept === 0);
    expect(clean.length).toBeGreaterThan(0);
    for (const s of clean) expect(s.script).toEqual({ narrated: null, failure: null });
    expect(text).toContain("nothing to narrate");
    expect(text).not.toContain("narrate failed");
    // A single model prints no comparison table.
    expect(text).not.toContain("comparison");
  });

  it("eval compares several models in one table", async () => {
    const outDir = tempDir();
    await withFakeProvider(() =>
      run("eval", "--out", outDir, "--model", "alpha", "--model", "beta"),
    );

    const text = out.join("\n");
    expect(text).toContain("comparison");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");

    const report = JSON.parse(readFileSync(path.join(outDir, "eval.json"), "utf8")) as {
      models: { model: string }[];
    };
    expect(report.models.map((m) => m.model)).toEqual(["alpha", "beta"]);
  });

  it("stage rejects an unknown name", async () => {
    await run("stage", "nonsense", "--run", tempDir());
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("Expected one of: ingest");
  });

  it("validate accepts an ingest.json written by a run", async () => {
    const runDir = tempDir();
    await run("run", "--diff", GOLDEN_DIFF, "--until", "ingest", "--out", runDir);
    out.length = 0;
    await run("validate", path.join(runDir, "ingest.json"));
    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("(ingest)");
  });

  it("config prints the resolved config without secret values", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-secret-value";
    try {
      await run("config");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
    const text = out.join("\n");
    expect(text).toContain('"maxFindings": 10');
    expect(text).toContain("ANTHROPIC_API_KEY: set");
    expect(text).not.toContain("sk-secret-value");
  });
});
