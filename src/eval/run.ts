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
import { createProvider } from "../providers/llm/create.js";
import { runVerify, writeVerifiedReview } from "../verify/verify.js";
import { judgeFindings } from "../agents/verifier.js";
import { buildReport, measureScript, scoreReview, total, totalsByOrigin } from "./score.js";

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
  /** Called after each sample. A full comparison takes tens of minutes and is silent without it. */
  onProgress?: (line: string) => void;
}

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

/** The same configuration with a different model, so one run can score several. */
function withModel(config: SprConfig, model: string): SprConfig {
  return { ...config, llm: { ...config.llm, model } };
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
  const provider = createProvider(config, secrets);
  const started = Date.now();

  const built = buildIngest({ rawDiff: source.rawDiff, source: source.source, config });
  writeIngest(runDir, source.rawDiff, built);

  const review = await runReview({
    ingest: built.ingest,
    provider,
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
        provider,
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
        provider,
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

  return {
    sample,
    origin: labels.origin,
    run_dir: runDir,
    cached: calls.length > 0 && calls.every((c) => c.cached),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    stopped: review.stopped,
    review: scoreReview(verified.review, labels),
    script: measureScript(verified.review, script, expectedScript, failure),
  };
}

/** How a sample's narration went, in the progress line's words. */
function narration(result: SampleResult): string {
  if (result.script.narrated === null) return "nothing to narrate";
  return result.script.narrated ? "narrated" : "not narrated";
}

/** Scores every sample for every model and returns the report. */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const { goldenDir, outDir, config } = options;
  const secrets = options.secrets ?? {};
  const noCache = options.noCache ?? false;
  const models = options.models?.length ? options.models : [config.llm.model];

  const samples = goldenSamples(goldenDir);
  if (samples.length === 0) throw new StageError("eval", `No samples found in ${goldenDir}`);

  const runs: ModelRun[] = [];
  for (const model of models) {
    const modelConfig = withModel(config, model);
    const cache = cacheFor(modelConfig, noCache);
    const results: SampleResult[] = [];
    let failed: string | undefined;

    for (const sample of samples) {
      const runDir = path.join(outDir, model.replace(/[^\w.-]/g, "_"), sample);
      try {
        const result = await evaluateSample(goldenDir, sample, runDir, modelConfig, secrets, cache);
        results.push(result);
        options.onProgress?.(
          `${model} ${sample}: ${result.review.kept} kept, ` +
            `${result.review.found.length}/${result.review.found.length + result.review.missed.length} must_find, ` +
            `${result.review.false_positives.length} fp, ` +
            `${narration(result)}, ${result.seconds ?? 0}s`,
        );
      } catch (error) {
        // One model that cannot run must not discard what the others measured.
        failed = `${sample}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        options.onProgress?.(`${model} ${sample}: FAILED - ${failed}`);
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
    });
  }

  return buildReport(goldenDir, runs);
}
