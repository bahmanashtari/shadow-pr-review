/**
 * The Verify stage: `review.raw.json` plus `ingest.json` become `review.json`, the only
 * review file the Narrator is allowed to read.
 *
 * ARCHITECTURE.md gives this stage two layers, and both are built. The first is deterministic
 * checks that need no model, so without the second the stage still runs offline, instantly and
 * for free. The second is the Verifier agent (keep / downgrade / drop with a note, ADR-037),
 * which judges only what survives the first and is optional at every point: `judge` left out,
 * this file behaves exactly as it did before it existed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkReview, compareFindings } from "../contracts/checks.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { IngestResult } from "../contracts/generated/ingest.js";
import type { DroppedFinding, Finding, ReviewResult } from "../contracts/generated/review.js";
import { assertContract, validateContract } from "../contracts/validate.js";
import { HunkIndex } from "../ingest/hunk-index.js";
import { ContractError, StageError } from "../lib/errors.js";
import { REVIEW_RAW_FILE } from "../agents/reviewer.js";
import { screenFindings, type Dropped } from "./grounding.js";
import {
  downgrade as applyDowngrade,
  toDropped as agentDropped,
  type JudgeOutcome,
  type Verdict,
  type Verdicts,
} from "../agents/verifier.js";

/** File this stage writes. */
export const REVIEW_FILE = "review.json";

/** The schema allows 500 characters of `note`; longer notes are cut, never dropped. */
const MAX_NOTE = 500;

/** Input for {@link runVerify}. */
export interface RunVerifyOptions {
  ingest: IngestResult;
  /** The contents of `review.raw.json`. */
  review: ReviewResult;
  config: SprConfig;
  /**
   * The second layer (ADR-037). Omitted, the stage is exactly what it was: offline, instant and
   * free. Given, its verdicts are applied to whatever survived the deterministic checks.
   */
  judge?: (findings: readonly Finding[]) => Promise<JudgeOutcome>;
}

/** What the stage produced. */
export interface VerifyOutcome {
  review: ReviewResult;
  kept: number;
  /** The findings this run removed, in id order. Entries already in the raw file are not counted. */
  dropped: DroppedFinding[];
  /** How many findings the agent gave a verdict on. Zero whenever it did not run. */
  judged: number;
  /** How many of those it lowered the severity of. */
  downgraded: number;
  /** Why the agent pass stopped early, when it did. */
  stopped?: string;
  /** Findings the agent could not answer for. They keep the first layer's verdict. */
  failed: number;
}

/** Turns a rejected finding into the `dropped` entry the contract asks for. */
function toDropped({ finding, rejection }: Dropped): DroppedFinding {
  return {
    id: finding.id,
    file: finding.file,
    line_start: finding.line_start,
    line_end: finding.line_end,
    summary: finding.summary,
    reason: rejection.reason,
    note: rejection.note.slice(0, MAX_NOTE),
  };
}

/**
 * Verifies a raw review against the diff it describes.
 *
 * Ids are carried over unchanged, so `F03` here is `F03` in `review.raw.json` whether it was
 * kept or dropped: `trace.jsonl` and `spr eval` both need that mapping, and gaps in the kept
 * list are informative rather than untidy.
 */
export async function runVerify(options: RunVerifyOptions): Promise<VerifyOutcome> {
  const { ingest, review, config } = options;
  const index = HunkIndex.fromIngest(ingest);

  const screening = screenFindings({
    index,
    findings: review.findings,
    maxFindings: config.review.maxFindings,
  });

  const dropped = screening.dropped.map(toDropped);
  const survivors = screening.kept.map((finding) => ({
    // Surviving the deterministic checks is exactly the claim `verified` makes here: the
    // lines exist and the evidence is verbatim. A verdict already on the finding - from the
    // agent below, on an earlier run - is left alone, so re-running never erases one.
    ...finding,
    verification: finding.verification ?? { status: "verified" as const },
  }));

  const judged = options.judge === undefined ? undefined : await options.judge(survivors);
  const verdicts: Verdicts = judged?.verdicts ?? new Map<string, Verdict>();

  const kept: Finding[] = [];
  let downgraded = 0;
  for (const finding of survivors) {
    const verdict = verdicts.get(finding.id);
    if (verdict === undefined || verdict.verdict === "keep") {
      kept.push(finding);
    } else if (verdict.verdict === "downgrade") {
      kept.push(applyDowngrade(finding, verdict));
      downgraded += 1;
    } else {
      dropped.push(agentDropped(finding, verdict));
    }
  }

  const verified: ReviewResult = {
    ...review,
    // A downgrade can move a finding out of severity order, and the contract wants it sorted.
    findings: [...kept].sort(compareFindings),
    // Anything the raw file already dropped stays dropped, which keeps the stage idempotent.
    dropped: [...review.dropped, ...dropped],
  };

  assertContract("review", verified);
  const problems = checkReview(verified, { maxFindings: config.review.maxFindings });
  if (problems.length > 0) throw new ContractError(REVIEW_FILE, problems);

  return {
    review: verified,
    kept: verified.findings.length,
    dropped,
    judged: verdicts.size,
    downgraded,
    failed: judged?.failed ?? 0,
    ...(judged?.stopped == null ? {} : { stopped: judged.stopped }),
  };
}

/** Reads and validates an existing `review.raw.json`. */
export function readRawReview(runDir: string): ReviewResult {
  return readReviewFile(path.join(runDir, REVIEW_RAW_FILE));
}

/** Reads and validates the verified `review.json`, the Narrator's only input. */
export function readReview(runDir: string): ReviewResult {
  return readReviewFile(path.join(runDir, REVIEW_FILE));
}

function readReviewFile(file: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("verify", `Cannot read ${file}`, { cause });
  }
  const result = validateContract("review", parsed);
  if (!result.ok) throw new ContractError(file, result.errors);
  return result.value;
}

/** Writes `review.json` into a run folder. */
export function writeVerifiedReview(runDir: string, review: ReviewResult): void {
  writeFileSync(path.join(runDir, REVIEW_FILE), `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

/**
 * One line such as `3 findings kept, 2 dropped (1 duplicate, 1 style_only), 5 judged, 1
 * downgraded`.
 *
 * The judged count is printed whenever the agent ran, including when it ran and changed
 * nothing: a run where the second layer was skipped and a run where it agreed with everything
 * would otherwise look identical, and those are very different things to have happened.
 */
export function summarizeVerify(outcome: VerifyOutcome): string {
  const kept = `${outcome.kept} ${outcome.kept === 1 ? "finding" : "findings"} kept`;

  const parts = [kept];
  if (outcome.dropped.length === 0) parts.push("none dropped");
  else {
    const counts = new Map<string, number>();
    for (const d of outcome.dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
    const detail = [...counts].map(([reason, n]) => `${n} ${reason}`).join(", ");
    parts.push(`${outcome.dropped.length} dropped (${detail})`);
  }
  if (outcome.judged > 0) {
    parts.push(`${outcome.judged} judged`);
    if (outcome.downgraded > 0) parts.push(`${outcome.downgraded} downgraded`);
  }
  if (outcome.failed > 0) parts.push(`${outcome.failed} not judged`);
  if (outcome.stopped !== undefined) parts.push(`agent stopped: ${outcome.stopped}`);
  return parts.join(", ");
}
