/**
 * `spr eval`: run the real pipeline over the golden set and score what comes out.
 *
 * This is the only place that runs several models against the same labels in one go, which is
 * the point of it: ADR-015 and ADR-018 both left the default model provisional "until step 7",
 * and a comparison whose rows came from separate invocations could silently mix two prompts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runNarrate, writeScript } from "../agents/narrator.js";
import { runReview, writeReview } from "../agents/reviewer.js";
import type { Secrets } from "../config.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { EvalReport, ModelRun, SampleResult } from "../contracts/generated/eval.js";
import type { GoldenLabels } from "../contracts/generated/labels.js";
import type { NarrationScript } from "../contracts/generated/script.js";
import type { LlmCache } from "../harness/cache.js";
import { assertContract } from "../contracts/validate.js";
import { Budget } from "../harness/budget.js";
import { createCache, FileLlmCache, writeOnly } from "../harness/cache.js";
import { Tracer } from "../harness/tracing.js";
import { buildIngest, writeIngest } from "../ingest/ingest.js";
import { fromDiffFile } from "../ingest/sources.js";
import { StageError } from "../lib/errors.js";
import { createProvider, modelFor } from "../providers/llm/create.js";
import { runVerify, writeVerifiedReview } from "../verify/verify.js";
import { judgeFindings } from "../agents/verifier.js";
import {
  budgetWarnings,
  buildReport,
  measureScript,
  scoreReview,
  total,
  totalsByOrigin,
} from "./score.js";

/** Input for {@link runEval}. */
export interface RunEvalOptions {
  goldenDir: string;
  outDir: string;
  config: SprConfig;
  secrets?: Secrets;
  /** Models to score. Defaults to the configured one. */
  models?: readonly string[];
  /** Ignore the on-disk cache, for a measurement that goes into an ADR (ADR-017). */
  noCache?: boolean;
  /**
   * Sampler seeds. Each model is scored once per seed at {@link temperature}, and the report
   * gains the median and range of every axis (ADR-059). Empty or absent: one greedy run, as ever.
   */
  seeds?: readonly number[];
  /** What a seeded run samples at. Defaults to {@link MEASUREMENT_TEMPERATURE}. */
  temperature?: number;
  /** Called after each sample. A full comparison takes tens of minutes and is silent without it. */
  onProgress?: (line: string) => void;
}

/**
 * The temperature `spr eval --seed` samples at unless told otherwise (ADR-059). Low enough that
 * the model still answers like itself, high enough that a seed changes something: the same
 * question at 0.2 gave three different answers for three seeds and the same answer twice for one.
 */
export const MEASUREMENT_TEMPERATURE = 0.2;

/** Sample folder names, in order. A folder without labels is not a sample. */
export function goldenSamples(goldenDir: string): string[] {
  return readdirSync(goldenDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("sample-"))
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(goldenDir, name, "labels.json")))
    .sort();
}

/** Reads and validates one sample's labels. */
export function readLabels(goldenDir: string, sample: string): GoldenLabels {
  const file = path.join(goldenDir, sample, "labels.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("eval", `Cannot read ${file}`, { cause });
  }
  const labels = assertContract("labels", parsed);
  if (labels.sample !== sample) {
    throw new StageError("eval", `${file}: sample is "${labels.sample}", expected "${sample}"`);
  }
  return labels;
}

/** Reads an optional JSON fixture from a sample, when it exists. */
function readFixture(goldenDir: string, sample: string, file: string): unknown {
  const full = path.join(goldenDir, sample, file);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : undefined;
}

/**
 * The same configuration with a different model, so one run can score several. `--model` names
 * one model for the whole pipeline, so any per-stage override (ADR-057) is dropped: a row of the
 * table has to mean one model, or it cannot be compared with the next row.
 */
function withModel(config: SprConfig, model: string): SprConfig {
  const llm = { ...config.llm, model };
  delete llm.models;
  return { ...config, llm };
}

/**
 * The same configuration sampled with a seed. Only the measurement does this: the pipeline's own
 * temperature stays where the configuration puts it, 0 by default (ADR-059).
 */
function withSeed(config: SprConfig, seed: number, temperature: number): SprConfig {
  return { ...config, llm: { ...config.llm, seed, temperature } };
}

/**
 * The cache for a run. `--no-cache` still writes, so the cold measurement that goes into an
 * ADR can be re-scored for free when a metric or a label changes.
 */
function cacheFor(config: SprConfig, noCache: boolean): LlmCache {
  if (!noCache || !config.cache.enabled) return createCache(config.cache);
  return writeOnly(new FileLlmCache(config.cache.dir));
}

/** Runs ingest, review, verify and narrate on one sample and scores the result. */
async function evaluateSample(
  goldenDir: string,
  sample: string,
  runDir: string,
  config: SprConfig,
  secrets: Secrets,
  cache: LlmCache,
): Promise<SampleResult> {
  mkdirSync(runDir, { recursive: true });
  const labels = readLabels(goldenDir, sample);
  const expectedReview = readFixture(goldenDir, sample, "review.expected.json") as
    { source?: { title?: string | null } } | undefined;
  const expectedScript = readFixture(goldenDir, sample, "script.expected.json") as
    NarrationScript | undefined;

  const title = expectedReview?.source?.title;
  const source = fromDiffFile(path.join(goldenDir, sample, "diff.patch"), {
    ...(title === undefined || title === null ? {} : { title }),
  });

  const tracer = new Tracer(runDir);
  // One provider per stage, so a per-stage model (ADR-057) is measured the way it runs.
  const reviewer = createProvider(config, secrets, "review");
  const verifier = createProvider(config, secrets, "verify");
  const narrator = createProvider(config, secrets, "narrate");
  const started = Date.now();

  const built = buildIngest({ rawDiff: source.rawDiff, source: source.source, config });
  writeIngest(runDir, source.rawDiff, built);

  const review = await runReview({
    ingest: built.ingest,
    provider: reviewer,
    config,
    budget: new Budget(config.budgets),
    tracer,
    cache,
  });
  writeReview(runDir, review.review);

  // The agent layer runs here too: `spr eval` exists to measure the pipeline a viewer gets,
  // and the calibration axis (ADR-036) is only meaningful against a review the Verifier saw.
  const verified = await runVerify({
    ingest: built.ingest,
    review: review.review,
    config,
    judge: (findings) =>
      judgeFindings({
        findings,
        ingest: built.ingest,
        provider: verifier,
        config,
        budget: new Budget(config.budgets),
        tracer,
        cache,
      }),
  });
  writeVerifiedReview(runDir, verified.review);

  // A failed Narrate stage is a result, not a reason to abandon the sample's review score. A
  // review that kept nothing is not narrated at all: `spr run` stops after Verify on it, because
  // there is nothing to explain (ADR-042), and `measureScript` reports it as such.
  let script: NarrationScript | undefined;
  let failure: string | undefined;
  if (verified.review.findings.length > 0) {
    try {
      const narrated = await runNarrate({
        review: verified.review,
        provider: narrator,
        config,
        budget: new Budget(config.budgets),
        tracer,
        cache,
        runDir,
      });
      script = narrated.script;
      writeScript(runDir, narrated.script);
    } catch (error) {
      if (!(error instanceof StageError)) throw error;
      failure = error.message.split("\n")[0] ?? error.message;
    }
  }

  const calls = tracer.entries.filter((e) => e.kind === "llm_call");
  tracer.writeCost(runDir);
  const warnings = budgetWarnings(tracer.cost().stages, config.budgets);

  return {
    sample,
    origin: labels.origin,
    run_dir: runDir,
    cached: calls.length > 0 && calls.every((c) => c.cached),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    stopped: review.stopped,
    review: scoreReview(verified.review, labels),
    script: measureScript(verified.review, script, expectedScript, failure),
    ...(warnings.length === 0 ? {} : { budget_warnings: warnings }),
  };
}

/** How a sample's narration went, in the progress line's words. */
function narration(result: SampleResult): string {
  if (result.script.narrated === null) return "nothing to narrate";
  return result.script.narrated ? "narrated" : "not narrated";
}

/**
 * What to call this row: the model, or every stage's model when they differ (ADR-057), so a
 * table can never show two different pipelines under one name.
 */
export function modelLabel(config: SprConfig): string {
  const stages = ["review", "verify", "narrate"] as const;
  const used = stages.map((stage) => modelFor(config, stage));
  const [first] = used;
  if (first !== undefined && used.every((model) => model === first)) return first;
  return stages.map((stage, i) => `${stage} ${used[i] ?? ""}`).join(", ");
}

/** Scores every sample for every model and returns the report. */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const { goldenDir, outDir, config } = options;
  const secrets = options.secrets ?? {};
  const noCache = options.noCache ?? false;
  // With no --model the configuration runs as it stands, per-stage overrides included; each
  // --model names one model for the whole pipeline, so the rows can be compared (ADR-057).
  const named = options.models ?? [];
  const models: { model: string; config: SprConfig }[] = named.length
    ? named.map((model) => ({ model, config: withModel(config, model) }))
    : [{ model: modelLabel(config), config }];
  // Each model once per seed, seeds innermost, so one model's spread is measured back to back.
  const seeds = options.seeds ?? [];
  const temperature = options.temperature ?? MEASUREMENT_TEMPERATURE;
  const runsToDo: { model: string; config: SprConfig; seed?: number }[] = seeds.length
    ? models.flatMap(({ model, config: modelConfig }) =>
        seeds.map((seed) => ({ model, seed, config: withSeed(modelConfig, seed, temperature) })),
      )
    : models;

  const samples = goldenSamples(goldenDir);
  if (samples.length === 0) throw new StageError("eval", `No samples found in ${goldenDir}`);

  const runs: ModelRun[] = [];
  for (const { model, config: modelConfig, seed } of runsToDo) {
    const cache = cacheFor(modelConfig, noCache);
    const results: SampleResult[] = [];
    let failed: string | undefined;
    const label = seed === undefined ? model : `${model} seed ${String(seed)}`;
    const modelDir = path.join(
      outDir,
      model.replace(/[^\w.-]/g, "_"),
      ...(seed === undefined ? [] : [`seed-${String(seed)}`]),
    );

    for (const sample of samples) {
      const runDir = path.join(modelDir, sample);
      try {
        const result = await evaluateSample(goldenDir, sample, runDir, modelConfig, secrets, cache);
        results.push(result);
        options.onProgress?.(
          `${label} ${sample}: ${result.review.kept} kept, ` +
            `${result.review.found.length}/${result.review.found.length + result.review.missed.length} must_find, ` +
            `${result.review.false_positives.length} fp, ` +
            `${narration(result)}, ${result.seconds ?? 0}s`,
        );
      } catch (error) {
        // One model that cannot run must not discard what the others measured.
        failed = `${sample}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        options.onProgress?.(`${label} ${sample}: FAILED - ${failed}`);
        break;
      }
    }

    runs.push({
      provider: modelConfig.llm.provider,
      model,
      samples: results,
      totals: total(results),
      by_origin: totalsByOrigin(results),
      ...(failed === undefined ? {} : { failed }),
      ...(seed === undefined ? {} : { seed, temperature: modelConfig.llm.temperature }),
    });
  }

  return buildReport(goldenDir, runs);
}
