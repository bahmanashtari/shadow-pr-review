/**
 * Ties the Ingest stage to the golden fixtures: every line range the Reviewer, Verifier
 * and Narrator are expected to produce must exist in the diff, and every quoted piece of
 * evidence must really appear there.
 */
import { describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import { HunkIndex } from "../../src/ingest/hunk-index.js";
import { checkIngest } from "../../src/contracts/checks.js";
import { validateContract } from "../../src/contracts/validate.js";
import type { Source } from "../../src/contracts/generated/ingest.js";
import {
  GOLDEN_SAMPLES,
  defaultConfig,
  loadGolden,
  readGoldenDiff,
  readGoldenJson,
} from "../helpers.js";

const SOURCE: Source = {
  type: "local_diff",
  repo: null,
  pr_number: null,
  ref: null,
  base_sha: null,
  head_sha: null,
  title: null,
};

/** A place in the diff that a later stage points at. */
interface Located {
  where: string;
  file: string;
  line_start: number;
  line_end: number;
}

interface LabelItem {
  key?: string;
  file?: string;
  line_start?: number;
  line_end?: number;
}

function labelRanges(sample: string): Located[] {
  const labels = readGoldenJson(sample, "labels.json") as {
    must_find?: LabelItem[];
    acceptable?: LabelItem[];
  };
  return [...(labels.must_find ?? []), ...(labels.acceptable ?? [])].flatMap((item) =>
    item.file !== undefined && item.line_start !== undefined && item.line_end !== undefined
      ? [
          {
            where: `labels.json ${item.key ?? "?"}`,
            file: item.file,
            line_start: item.line_start,
            line_end: item.line_end,
          },
        ]
      : [],
  );
}

describe.each(GOLDEN_SAMPLES)("%s", (sample) => {
  const rawDiff = readGoldenDiff(sample);
  const { ingest, keptPatch } = buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() });
  const index = HunkIndex.fromIngest(ingest);
  const { review, script } = loadGolden(sample);

  it("produces a valid, consistent ingest.json", () => {
    const result = validateContract("ingest", ingest);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(checkIngest(ingest)).toEqual([]);
  });

  it("keeps every file of the sample", () => {
    expect(ingest.skipped).toEqual([]);
    expect(keptPatch).toBe(rawDiff);
    expect(ingest.diff.truncated).toBe(false);
  });

  it("contains every line range the later stages point at", () => {
    const ranges: Located[] = [
      ...labelRanges(sample),
      ...review.findings.map((f) => ({
        where: `finding ${f.id}`,
        file: f.file,
        line_start: f.line_start,
        line_end: f.line_end,
      })),
      ...review.dropped.flatMap((d) =>
        d.line_start != null && d.line_end != null
          ? [
              {
                where: `dropped ${d.id}`,
                file: d.file,
                line_start: d.line_start,
                line_end: d.line_end,
              },
            ]
          : [],
      ),
      ...script.steps.flatMap((s) =>
        s.focus
          ? [
              {
                where: `step ${s.id} focus`,
                file: s.focus.file,
                line_start: s.focus.line_start,
                line_end: s.focus.line_end,
              },
            ]
          : [],
      ),
    ];

    expect(ranges.length).toBeGreaterThan(0);
    const missing = ranges.filter((r) => !index.hasRange(r.file, "new", r.line_start, r.line_end));
    expect(missing.map((r) => `${r.where}: ${r.file}:${r.line_start}-${r.line_end}`)).toEqual([]);
  });

  it("contains every piece of quoted evidence", () => {
    const quotes = review.findings.flatMap((f) =>
      (f.evidence ?? []).map((snippet) => ({ id: f.id, file: f.file, snippet })),
    );
    expect(quotes.length).toBeGreaterThan(0);
    const missing = quotes.filter((q) => !index.containsSnippet(q.file, q.snippet));
    expect(missing.map((q) => `${q.id}: ${q.snippet}`)).toEqual([]);
  });
});

describe("sample-01-order-outbox", () => {
  it("puts the transaction call on line 19 of the handler", () => {
    const ingest = buildIngest({
      rawDiff: readGoldenDiff("sample-01-order-outbox"),
      source: SOURCE,
      config: defaultConfig(),
    }).ingest;
    const index = HunkIndex.fromIngest(ingest);
    const file = "services/order-service/src/application/commands/place-order.handler.ts";
    expect(index.lineText(file, "new", 19)?.trim()).toBe(
      "await this.dataSource.transaction(async (manager) => {",
    );
  });
});
