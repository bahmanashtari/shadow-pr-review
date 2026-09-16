import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { fromRoot } from "../src/lib/paths.js";

const run = (...args: string[]): Promise<void> => main(["node", "spr", ...args]);

/** Runs something with the fake LLM provider, so the Review stage needs no model. */
async function withFakeProvider(body: () => Promise<void>): Promise<void> {
  const previous = process.env.SPR_LLM_PROVIDER;
  process.env.SPR_LLM_PROVIDER = "fake";
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.SPR_LLM_PROVIDER;
    else process.env.SPR_LLM_PROVIDER = previous;
  }
}

const GOLDEN_DIFF = fromRoot("golden", "sample-02-inventory-consumer", "diff.patch");

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
    await run("validate", fromRoot("golden", "sample-01-order-outbox", "labels.json"));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("pass --schema");
  });

  it("validate --schema reports schema errors", async () => {
    await run("validate", "--schema", "timeline", fromRoot("config", "default.json"));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("FAIL");
  });

  it("planned commands exit with code 2 and a clear message", async () => {
    await run("eval");
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("not implemented yet");
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
    expect(out.join("\n")).toContain("script: 4 steps");
    // One cost.json covers every stage of the run, not just the last one that called a model.
    expect(existsSync(path.join(runDir, "cost.json"))).toBe(true);
  });

  it("run without --until now stops after narrate, pointing at Milestone 2", async () => {
    const runDir = tempDir();
    await withFakeProvider(() => run("run", "--diff", GOLDEN_DIFF, "--out", runDir));

    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("tts is not implemented yet (Milestone 2, step 1)");
    expect(existsSync(path.join(runDir, "script.json"))).toBe(true);
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
    expect(out.join("\n")).toContain("script: 4 steps");
    const script = JSON.parse(readFileSync(path.join(runDir, "script.json"), "utf8")) as {
      steps: { id: string; kind: string; finding_id: string | null }[];
    };
    expect(script.steps.map((s) => s.id)).toEqual(["S00", "S01", "S02", "S03"]);
    expect(script.steps.map((s) => s.kind)).toEqual(["intro", "finding", "finding", "wrap_up"]);
    expect(script.steps.map((s) => s.finding_id)).toEqual([null, "F01", "F02", null]);
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
    expect(err.join("\n")).toContain("exactly one of --diff or --git");
  });

  it("run --pr points at Milestone 4", async () => {
    await run("run", "--pr", "142", "--repo", "acme/shop");
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("Milestone 4");
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

  it("stage points at the milestone for stages that are not built", async () => {
    await run("stage", "tts", "--run", tempDir());
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("spr stage tts is not implemented yet");
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
