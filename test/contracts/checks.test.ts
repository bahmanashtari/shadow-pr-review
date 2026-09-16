import { describe, expect, it } from "vitest";
import {
  checkAudioManifest,
  checkReview,
  checkScript,
  checkTimeline,
  countWords,
} from "../../src/contracts/checks.js";
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
  it("requires intro first and wrap-up last", () => {
    const { review, script } = loadGolden("sample-01-order-outbox");
    script.steps.reverse();
    const problems = checkScript(script, review);
    expect(problems).toContain("first step must be kind 'intro'");
    expect(problems).toContain("last step must be kind 'wrap_up'");
  });

  it("requires focus to match the finding location", () => {
    const { review, script } = loadGolden("sample-01-order-outbox");
    const s = step(script, 1);
    if (s.focus) s.focus.line_end = 99;
    expect(checkScript(script, review)).toEqual([
      "/steps/1 (S01): focus must equal the location of finding F01",
    ]);
  });

  it("rejects unknown and missing findings", () => {
    const { review, script } = loadGolden("sample-03-email-value-object");
    step(script, 1).finding_id = "F02"; // F02 was dropped by the verifier
    const problems = checkScript(script, review);
    expect(problems).toContain(
      "/steps/1 (S01): finding_id F02 is not a kept finding in review.json",
    );
    expect(problems).toContain("finding F01 has no narration step");
  });

  it("rejects long steps, markdown and file names in spoken text", () => {
    const { review, script } = loadGolden("sample-03-email-value-object");
    step(script, 0).text = Array.from({ length: 61 }, () => "word").join(" ");
    step(script, 1).text = "The `create` method in email.ts leaks the address.";
    step(script, 2).text = "See https://example.com for details.";
    const problems = checkScript(script, review);
    expect(problems).toContain("/steps/0 (S00): 61 words, maximum is 60");
    expect(problems).toContain("/steps/1 (S01): text contains markdown or code characters");
    expect(problems).toContain("/steps/1 (S01): text reads out a file name, path or URL");
    expect(problems).toContain("/steps/2 (S02): text reads out a file name, path or URL");
  });

  it("honors a custom word limit", () => {
    const { review, script } = loadGolden("sample-03-email-value-object");
    expect(checkScript(script, review, { maxWordsPerStep: 20 })).toContain(
      "/steps/1 (S01): 35 words, maximum is 20",
    );
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
    { at_ms: 0, step_id: "S00", type: "show_title", text: "Review" },
    { at_ms: 2000, step_id: "S00", type: "hide_title" },
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
    const { script } = loadGolden("sample-03-email-value-object");
    expect(checkAudioManifest(manifest, script)).toEqual([
      "clips (S00, S01) must match script steps (S00, S01, S02) in order",
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
