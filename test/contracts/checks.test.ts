import { describe, expect, it } from "vitest";
import {
  checkAudioManifest,
  checkIngest,
  checkReview,
  checkScript,
  checkTimeline,
  countWords,
} from "../../src/contracts/checks.js";
import type { IngestResult } from "../../src/contracts/generated/ingest.js";
import type { AudioManifest } from "../../src/contracts/generated/audio-manifest.js";
import type { Timeline } from "../../src/contracts/generated/timeline.js";
import type { NarrationScript } from "../../src/contracts/generated/script.js";
import { loadGolden } from "../helpers.js";

function step(script: NarrationScript, index: number): NarrationScript["steps"][number] {
  const s = script.steps[index];
  if (!s) throw new Error(`fixture has no step ${index}`);
  return s;
}

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  Hi there.  It's fine. ")).toBe(4);
    expect(countWords("   ")).toBe(0);
  });
});

describe("checkReview", () => {
  it("flags reversed ranges, duplicate ids and bad ordering", () => {
    const { review } = loadGolden("sample-02-inventory-consumer");
    const [f1, f2, f3, f4] = review.findings;
    if (!f1 || !f2 || !f3 || !f4) throw new Error("fixture changed");
    f1.line_end = f1.line_start - 1;
    f3.id = f2.id;
    review.findings = [f1, f2, f4, f3]; // low before medium

    const problems = checkReview(review);
    expect(problems).toContain(`finding id ${f2.id} is used more than once`);
    expect(problems.some((p) => p.includes("line_end") && p.includes("before line_start"))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes("ordered by severity"))).toBe(true);
  });

  it("flags two findings of equal severity in the wrong file order", () => {
    const { review } = loadGolden("sample-02-inventory-consumer");
    const [f1, f2] = review.findings;
    if (!f1 || !f2) throw new Error("fixture changed");
    review.findings = [f2, f1, ...review.findings.slice(2)]; // both high; interface/ before infrastructure/

    expect(checkReview(review)).toEqual([
      "/findings/1 (F01): findings must be ordered by severity (critical first), then file and line",
    ]);
  });

  it("enforces the cap only when one is given (ADR-016)", () => {
    const { review } = loadGolden("sample-02-inventory-consumer");
    expect(checkReview(review)).toEqual([]);
    expect(checkReview(review, { maxFindings: 10 })).toEqual([]);
    expect(checkReview(review, { maxFindings: 3 })).toEqual(["4 findings, maximum is 3"]);
  });

  it("requires a higher original severity when a finding is downgraded", () => {
    const { review } = loadGolden("sample-02-inventory-consumer");
    const f4 = review.findings[3];
    if (!f4) throw new Error("fixture changed");
    f4.verification = { status: "downgraded", original_severity: "low" };
    expect(checkReview(review)).toEqual([
      "/findings/3 (F04): original_severity low must be higher than severity low",
    ]);
  });
});

describe("checkScript", () => {
  it("refuses a script that narrates nothing", () => {
    // A clean review produces no script and no video at all (ADR-042), so an empty one here
    // means something upstream built it anyway.
    const { review, script } = loadGolden("sample-01-order-outbox");
    script.steps = [];
    expect(checkScript(script, review)).toContain("a script must narrate at least one finding");
  });

  it("requires focus to match the finding location", () => {
    const { review, script } = loadGolden("sample-01-order-outbox");
    step(script, 0).focus.line_end = 99;
    expect(checkScript(script, review)).toEqual([
      "/steps/0 (S00): focus must equal the location of finding F01",
    ]);
  });

  it("rejects unknown and missing findings", () => {
    const { review, script } = loadGolden("sample-03-email-value-object");
    step(script, 0).finding_id = "F02"; // F02 was dropped by the verifier
    const problems = checkScript(script, review);
    expect(problems).toContain(
      "/steps/0 (S00): finding_id F02 is not a kept finding in review.json",
    );
    expect(problems).toContain("finding F01 has no narration step");
  });

  describe("severity words", () => {
    /** The sample's one finding, re-rated, as the Verifier would leave it. */
    function ratedLow(): ReturnType<typeof loadGolden> {
      const golden = loadGolden("sample-03-email-value-object");
      const first = golden.review.findings[0];
      if (first === undefined) throw new Error("sample-03 should have exactly one finding");
      golden.review.findings[0] = { ...first, severity: "low" };
      return golden;
    }

    /* The defect this rule exists for: the outro card counts the `severity` field while the
     * narration used to echo the Reviewer's prose summary, so `sample-03` ended up with a card
     * reading "1 low" over a voice saying "critical" three times (ADR-034, ADR-037). */
    it("refuses a severity word no kept finding carries", () => {
      const { review, script } = ratedLow();
      step(script, 0).text =
        "This change has a critical security issue where emails leak into error messages, " +
        "and it needs fixing before anyone merges it.";

      const problems = checkScript(script, review);
      expect(problems.join("\n")).toContain('/steps/0 (S00): says "critical"');
      expect(problems.join("\n")).toContain("but finding F01 is low");
    });

    it("accepts a severity word the review does carry", () => {
      const { review, script } = ratedLow();
      step(script, 0).text =
        "This change has one low severity problem worth fixing, where an email address " +
        "reaches an error message that may be logged somewhere.";

      expect(checkScript(script, review)).toEqual([]);
    });

    it("allows only the step's own finding's severity", () => {
      // Severity is disclosed at the finding it belongs to (ADR-042), so the step may say its
      // own - and only its own. A second finding's word in this step would be a claim about
      // something the viewer is not looking at.
      const { review, script } = loadGolden("sample-02-inventory-consumer");
      const first = review.findings[0];
      if (first === undefined) throw new Error("sample-02 should have findings");
      step(script, 0).text = `A ${first.severity} one, and a low one elsewhere in the change.`;

      const problems = checkScript(script, review);
      expect(problems.join("\n")).toContain('says "low"');
      expect(problems.join("\n")).not.toContain(`says "${first.severity}"`);
    });

    it("matches whole words only", () => {
      // "critically" and "highlight" are not severity claims.
      const { review, script } = ratedLow();
      step(script, 0).text =
        "This change leaks an email address into an error message, which matters more than " +
        "it looks, so please highlight it to whoever owns this service before merging.";

      expect(checkScript(script, review)).toEqual([]);
    });
  });

  it("rejects long steps, markdown and file names in spoken text", () => {
    const { review, script } = loadGolden("sample-02-inventory-consumer");
    step(script, 0).text = Array.from({ length: 61 }, () => "word").join(" ");
    step(script, 1).text = "The `create` method in email.ts leaks the address.";
    step(script, 2).text = "See https://example.com for details.";
    const problems = checkScript(script, review);
    expect(problems).toContain("/steps/0 (S00): 61 words, maximum is 60");
    expect(problems).toContain("/steps/1 (S01): text contains markdown or code characters");
    expect(problems).toContain("/steps/1 (S01): text reads out a file name, path or URL");
    expect(problems).toContain("/steps/2 (S02): text reads out a file name, path or URL");
  });

  it("refuses a dotted identifier, and says what to write instead", () => {
    // Roadmap step 13: sample-01's narration said "order.placed", read as "order dot placed".
    const { review, script } = loadGolden("sample-02-inventory-consumer");
    step(script, 0).text = "When order.placed arrives twice, stock is decremented twice.";
    const problems = checkScript(script, review);
    expect(problems).toContain(
      '/steps/0 (S00): reads out "order.placed", which is spoken as "order dot placed". ' +
        'Describe it in words instead - an event name like this is "the order placed event".',
    );
  });

  it("leaves decimals alone, and reports a file name or URL once, as what it is", () => {
    const { review, script } = loadGolden("sample-02-inventory-consumer");
    step(script, 0).text = "It waits 1.5 seconds before the retry.";
    step(script, 1).text = "The create method in email.ts leaks the address.";
    step(script, 2).text = "See https://example.com for details.";
    const problems = checkScript(script, review);
    expect(problems.filter((p) => p.startsWith("/steps/0"))).toEqual([]);
    expect(problems.filter((p) => p.startsWith("/steps/1"))).toEqual([
      "/steps/1 (S01): text reads out a file name, path or URL",
    ]);
    expect(problems.filter((p) => p.startsWith("/steps/2"))).toEqual([
      "/steps/2 (S02): text reads out a file name, path or URL",
    ]);
  });

  it("honors a custom word limit", () => {
    const { review, script } = loadGolden("sample-03-email-value-object");
    expect(checkScript(script, review, { maxWordsPerStep: 20 })).toContain(
      "/steps/0 (S00): 47 words, maximum is 20",
    );
  });

  it("sets no floor on a step's length", () => {
    // The 40-word target is prompt guidance, never a check: two hand-written fixtures sit
    // below it, and a check would buy padding on a small finding (ADR-039).
    const { review, script } = loadGolden("sample-03-email-value-object");
    step(script, 0).text = "A low one. The error message leaks the address.";
    expect(checkScript(script, review)).toEqual([]);
  });

  it("requires steps to follow review order", () => {
    const { review, script } = loadGolden("sample-02-inventory-consumer");
    const a = step(script, 1);
    const b = step(script, 2);
    script.steps[1] = { ...b, id: "S01" };
    script.steps[2] = { ...a, id: "S02" };
    expect(checkScript(script, review)).toContain(
      "finding steps must follow the order of findings in review.json",
    );
  });
});

const manifest: AudioManifest = {
  schema_version: "1.0",
  provider: "fake",
  voice: "af_heart",
  sample_rate: 24000,
  clips: [
    { step_id: "S00", path: "audio/S00.wav", duration_ms: 2000, cache_key: "a" },
    { step_id: "S01", path: "audio/S01.wav", duration_ms: 3000, cache_key: "b" },
  ],
};

const timeline: Timeline = {
  schema_version: "1.0",
  render_mode: "diff2html",
  video: { width: 1280, height: 720 },
  gap_ms: 400,
  total_duration_ms: 5400,
  step_windows: [
    { step_id: "S00", start_ms: 0, end_ms: 2000 },
    { step_id: "S01", start_ms: 2400, end_ms: 5400 },
  ],
  actions: [
    { at_ms: 0, step_id: "S00", type: "open_file", file: "a.ts" },
    { at_ms: 2000, step_id: "S00", type: "clear_highlight" },
    { at_ms: 2100, step_id: "S01", type: "open_file", file: "a.ts" },
    {
      at_ms: 2100,
      step_id: "S01",
      type: "scroll_to",
      file: "a.ts",
      side: "new",
      line_start: 3,
      line_end: 5,
    },
    {
      at_ms: 2400,
      step_id: "S01",
      type: "highlight",
      file: "a.ts",
      side: "new",
      line_start: 3,
      line_end: 5,
    },
    { at_ms: 5400, step_id: "S01", type: "clear_highlight" },
  ],
};

describe("checkAudioManifest", () => {
  it("requires one clip per step, in order", () => {
    const { script } = loadGolden("sample-02-inventory-consumer");
    expect(checkAudioManifest(manifest, script)).toEqual([
      "clips (S00, S01) must match script steps (S00, S01, S02, S03) in order",
    ]);
  });
});

describe("checkTimeline", () => {
  it("accepts a consistent timeline", () => {
    expect(checkTimeline(timeline, manifest)).toEqual([]);
  });

  it("flags gaps, unsorted actions, missing ranges and duration mismatches", () => {
    const t = structuredClone(timeline);
    const w1 = t.step_windows[1];
    const a4 = t.actions[4];
    if (!w1 || !a4) throw new Error("fixture changed");
    w1.start_ms = 2500;
    a4.at_ms = 1000;
    delete a4.line_end;
    const problems = checkTimeline(t, manifest);
    expect(problems).toContain("/step_windows/1: start_ms must equal previous end_ms + gap_ms");
    expect(problems).toContain("/step_windows/1: window length must equal clip duration 3000 ms");
    expect(problems).toContain("/actions/4: actions must be sorted by at_ms");
    expect(problems).toContain("/actions/4: highlight needs file, line_start and line_end");
  });
});

/** A small, valid ingest.json: one modified file kept, one lockfile skipped. */
function ingestFixture(): IngestResult {
  const zeros = "0".repeat(64);
  return {
    schema_version: "1.0",
    source: {
      type: "local_diff",
      repo: null,
      pr_number: null,
      ref: null,
      base_sha: null,
      head_sha: null,
      title: null,
    },
    diff: {
      raw_path: "diff.raw.patch",
      raw_sha256: zeros,
      raw_bytes: 10,
      path: "diff.patch",
      sha256: zeros,
      bytes: 10,
      truncated: false,
    },
    files: [
      {
        path: "src/app.ts",
        old_path: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        risk_score: 1,
        hunks: [
          {
            old_start: 1,
            old_lines: 3,
            new_start: 1,
            new_lines: 3,
            section: "",
            lines: [
              { kind: "context", old: 1, new: 1, text: "const a = 1;" },
              { kind: "del", old: 2, new: null, text: "const b = 2;" },
              { kind: "add", old: null, new: 2, text: "const b = 3;" },
              { kind: "context", old: 3, new: 3, text: "const c = 4;" },
            ],
          },
        ],
      },
    ],
    skipped: [{ file: "pnpm-lock.yaml", status: "added", reason: "lockfile" }],
    stats: { files_total: 2, files_kept: 1, files_skipped: 1, additions: 1, deletions: 1 },
  };
}

function firstFile(ingest: IngestResult): IngestResult["files"][number] {
  const file = ingest.files[0];
  if (!file) throw new Error("fixture has no kept files");
  return file;
}

function firstHunk(ingest: IngestResult): IngestResult["files"][number]["hunks"][number] {
  const hunk = firstFile(ingest).hunks[0];
  if (!hunk) throw new Error("fixture has no hunks");
  return hunk;
}

describe("checkIngest", () => {
  it("accepts a consistent result", () => {
    expect(checkIngest(ingestFixture())).toEqual([]);
  });

  it("rejects a path that is both kept and skipped", () => {
    const ingest = ingestFixture();
    ingest.skipped = [{ file: "src/app.ts", status: "modified", reason: "too_large" }];
    expect(checkIngest(ingest)).toContain("file src/app.ts appears more than once");
  });

  it("rejects stats that do not match the arrays", () => {
    const ingest = ingestFixture();
    ingest.stats = { ...ingest.stats, files_total: 5, additions: 7 };
    const problems = checkIngest(ingest);
    expect(problems).toContain("stats.files_total 5 does not match 2");
    expect(problems).toContain("stats.additions 7 does not match 1");
  });

  it("rejects per-file counts that do not match the lines", () => {
    const ingest = ingestFixture();
    firstFile(ingest).additions = 4;
    expect(checkIngest(ingest)).toContain(
      "/files/0 (src/app.ts): additions 4 does not match 1 added lines",
    );
  });

  it("rejects a hunk header that disagrees with its lines", () => {
    const ingest = ingestFixture();
    firstHunk(ingest).new_lines = 9;
    expect(checkIngest(ingest)).toContain(
      "/files/0 (src/app.ts)/hunks/0: header says 9 new lines, found 3",
    );
  });

  it("rejects line numbers that do not run consecutively", () => {
    const ingest = ingestFixture();
    const line = firstHunk(ingest).lines[3];
    if (!line) throw new Error("fixture changed");
    line.new = 9;
    expect(checkIngest(ingest).join("\n")).toContain("breaks the run from 1");
  });

  it("rejects a side number on the wrong kind of line", () => {
    const ingest = ingestFixture();
    const added = firstHunk(ingest).lines[2];
    if (!added) throw new Error("fixture changed");
    added.old = 2;
    expect(checkIngest(ingest)).toContain(
      "/files/0 (src/app.ts)/hunks/0/lines/2: add line must have old null",
    );
  });

  it("rejects an end-of-file marker that is not on the last line of its side", () => {
    const ingest = ingestFixture();
    const context = firstHunk(ingest).lines[0];
    if (!context) throw new Error("fixture changed");
    context.no_newline_at_eof = true;
    const problems = checkIngest(ingest);
    expect(problems).toContain(
      "/files/0 (src/app.ts): no_newline_at_eof is not on the last old line",
    );
    expect(problems).toContain(
      "/files/0 (src/app.ts): no_newline_at_eof is not on the last new line",
    );
  });

  it("rejects two end-of-file markers on one side", () => {
    const ingest = ingestFixture();
    for (const line of firstHunk(ingest).lines) line.no_newline_at_eof = true;
    expect(checkIngest(ingest).join("\n")).toContain("appears 3 times on the old side");
  });
});
