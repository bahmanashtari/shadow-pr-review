#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, readSecrets } from "./config.js";
import type { SprConfig } from "./contracts/generated/config.js";
import type { IngestResult } from "./contracts/generated/ingest.js";
import { checkIngest, checkReview } from "./contracts/checks.js";
import {
  CONTRACT_NAMES,
  contractFromFileName,
  isContractName,
  type ContractName,
} from "./contracts/schemas.js";
import { validateContract } from "./contracts/validate.js";
import { buildIngest, readIngest, readRawDiff, summarize, writeIngest } from "./ingest/ingest.js";
import { fromDiffFile, fromGitRange } from "./ingest/sources.js";
import { runReview, summarizeReview, writeReview } from "./agents/reviewer.js";
import { runNarrate, summarizeNarrate, writeScript } from "./agents/narrator.js";
import { runEval } from "./eval/run.js";
import { formatReport } from "./eval/report.js";
import {
  readRawReview,
  readReview,
  runVerify,
  summarizeVerify,
  writeVerifiedReview,
} from "./verify/verify.js";
import { Budget } from "./harness/budget.js";
import { createCache } from "./harness/cache.js";
import { Tracer } from "./harness/tracing.js";
import { createProvider } from "./providers/llm/create.js";
import { ContractError, StageError } from "./lib/errors.js";
import { createRunFolder } from "./lib/run-folder.js";

const PIPELINE_STAGES = [
  "ingest",
  "review",
  "verify",
  "narrate",
  "tts",
  "direct",
  "record",
  "compose",
  "publish",
] as const;

type StageName = (typeof PIPELINE_STAGES)[number];

/** Thrown for commands that are planned but not built yet. */
class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
}

function parseContract(value: string): ContractName {
  if (!isContractName(value)) {
    throw new InvalidArgumentError(`Expected one of: ${CONTRACT_NAMES.join(", ")}`);
  }
  return value;
}

function parseStage(value: string): StageName {
  if (!(PIPELINE_STAGES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Expected one of: ${PIPELINE_STAGES.join(", ")}`);
  }
  return value as StageName;
}

function notYet(what: string, milestone: string): never {
  throw new NotImplementedError(`${what} is not implemented yet (${milestone}).`);
}

/** Schema errors, plus the file-local cross-field checks where they exist. */
function contractProblems(contract: ContractName, data: unknown): string[] {
  if (contract === "ingest") {
    const ingest = validateContract("ingest", data);
    return ingest.ok ? checkIngest(ingest.value) : ingest.errors;
  }
  if (contract === "review") {
    const review = validateContract("review", data);
    return review.ok ? checkReview(review.value) : review.errors;
  }
  const result = validateContract(contract, data);
  return result.ok ? [] : result.errors;
}

/** Validates one JSON file against its contract and prints the result. Returns true when valid. */
function validateFile(file: string, forced?: ContractName): boolean {
  const contract = forced ?? contractFromFileName(file);
  if (!contract) {
    console.error(`${file}: cannot tell the contract from the file name; pass --schema`);
    return false;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`${file}: cannot read JSON (${(error as Error).message})`);
    return false;
  }
  const problems = contractProblems(contract, data);
  if (problems.length === 0) {
    console.log(`ok     ${file} (${contract})`);
    return true;
  }
  console.error(`FAIL   ${file} (${contract})`);
  for (const p of problems) console.error(`       - ${p}`);
  return false;
}

/** Options of `spr run`, as Commander hands them over. */
interface RunOptions {
  diff?: string;
  git?: string;
  pr?: string;
  repo?: string;
  title?: string;
  out?: string;
  force?: boolean;
  until?: StageName;
}

/** Options of `spr eval`, as Commander hands them over (`--no-cache` arrives as `cache: false`). */
interface EvalOptions {
  model: string[];
  out?: string;
  cache?: boolean;
}

/** Prints where the run went and what ingest kept. */
function report(runDir: string, summary: string): void {
  console.log(`run folder: ${runDir}`);
  console.log(summary);
}

/**
 * `spr run`: reads the diff, writes the run folder, then walks the pipeline.
 * Stops with exit code 2 at the first stage that is not built yet.
 */
async function runPipeline(opts: RunOptions): Promise<void> {
  if (opts.pr !== undefined) notYet("spr run --pr", "Milestone 4");
  if ((opts.diff === undefined) === (opts.git === undefined)) {
    throw new InvalidArgumentError("Pass exactly one of --diff or --git");
  }

  const config = loadConfig();
  const titleOption = opts.title === undefined ? {} : { title: opts.title };
  const source =
    opts.diff === undefined
      ? await fromGitRange(opts.git ?? "", { cwd: process.cwd(), ...titleOption })
      : fromDiffFile(opts.diff, titleOption);

  const built = buildIngest({ rawDiff: source.rawDiff, source: source.source, config });
  const runDir = createRunFolder({
    runsDir: config.runs.dir,
    id: source.id,
    ...(opts.out === undefined ? {} : { out: opts.out }),
    ...(opts.force === undefined ? {} : { force: opts.force }),
  });
  writeIngest(runDir, source.rawDiff, built);
  report(runDir, summarize(built.ingest));

  if (opts.until === "ingest") return;
  // One tracer for the whole run, so `cost.json` covers every stage that called a model.
  const tracer = new Tracer(runDir);
  try {
    await review(runDir, built.ingest, config, tracer);

    if (opts.until === "review") return;
    verify(runDir, built.ingest, config);

    if (opts.until === "verify") return;
    await narrate(runDir, config, tracer);
  } finally {
    tracer.writeCost(runDir);
  }

  if (opts.until === "narrate") return;
  throw new NotImplementedError(
    `stopped after narrate: tts is not implemented yet (Milestone 2, step 1). ` +
      `Run folder: ${runDir}`,
  );
}

/**
 * Runs the Review stage into an existing run folder and prints what it found.
 * Shared by `spr run` and `spr stage review`.
 */
async function review(
  runDir: string,
  ingest: IngestResult,
  config: SprConfig,
  tracer: Tracer,
): Promise<void> {
  const outcome = await runReview({
    ingest,
    provider: createProvider(config, readSecrets()),
    config,
    budget: new Budget(config.budgets),
    tracer,
    cache: createCache(config.cache),
    // Tools that need a checkout are only offered when this run has one.
    ...(ingest.source.type === "local_diff" ? {} : { repoRoot: process.cwd() }),
  });
  writeReview(runDir, outcome.review);
  console.log(summarizeReview(outcome));
}

/**
 * Runs the Narrate stage over an existing run folder and prints what it wrote.
 * Like verify, it reads `review.json` back from disk, so `spr run` and `spr stage narrate`
 * follow exactly the same path.
 */
async function narrate(runDir: string, config: SprConfig, tracer: Tracer): Promise<void> {
  const outcome = await runNarrate({
    review: readReview(runDir),
    provider: createProvider(config, readSecrets()),
    config,
    budget: new Budget(config.budgets),
    tracer,
    cache: createCache(config.cache),
    runDir,
  });
  writeScript(runDir, outcome.script);
  console.log(summarizeNarrate(outcome));
}

/**
 * Runs the Verify stage over an existing run folder and prints what survived.
 * It reads `review.raw.json` back from disk rather than taking the Review stage's result in
 * memory, so `spr run` and `spr stage verify` follow exactly the same path.
 */
function verify(runDir: string, ingest: IngestResult, config: SprConfig): void {
  const outcome = runVerify({ ingest, review: readRawReview(runDir), config });
  writeVerifiedReview(runDir, outcome.review);
  console.log(summarizeVerify(outcome));
}

/** `spr stage ingest`: re-filters `diff.raw.patch` with the current configuration. */
function reingest(runDir: string): void {
  const config = loadConfig();
  const previous = readIngest(runDir);
  const rawDiff = readRawDiff(runDir);
  const built = buildIngest({ rawDiff, source: previous.source, config });
  writeIngest(runDir, rawDiff, built);
  report(path.resolve(runDir), summarize(built.ingest));
}

/** Builds the `spr` command tree. Exported for tests. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("spr")
    .description("shadow-pr-review: AI code review as a narrated walkthrough video")
    .version("0.1.0")
    .showHelpAfterError();

  program
    .command("run")
    .description("Run the full pipeline on a diff")
    .option("--diff <file>", "unified diff file")
    .option("--git <range>", "local git range, for example HEAD~1..HEAD")
    .option("--pr <number>", "GitHub pull request number")
    .option("--repo <owner/name>", "GitHub repository")
    .option("--title <text>", "title for the intro (default: the commit subject)")
    .option("--out <dir>", "run folder (default: runs/<timestamp>-<id>)")
    .option("--force", "write into the run folder even when it already has files")
    .option("--until <stage>", `stop after this stage: ${PIPELINE_STAGES.join(", ")}`, parseStage)
    .action(runPipeline);

  program
    .command("stage")
    .description("Re-run a single stage on an existing run folder")
    .argument("<name>", `one of: ${PIPELINE_STAGES.join(", ")}`)
    .requiredOption("--run <dir>", "existing run folder")
    .action(async (name: string, opts: { run: string }) => {
      const stage = parseStage(name);
      if (stage === "ingest") {
        reingest(opts.run);
        return;
      }
      if (stage === "verify") {
        const config = loadConfig();
        const runDir = path.resolve(opts.run);
        report(runDir, "re-running verify");
        verify(runDir, readIngest(runDir), config);
        return;
      }
      if (stage === "narrate") {
        const config = loadConfig();
        const runDir = path.resolve(opts.run);
        const tracer = new Tracer(runDir);
        report(runDir, "re-running narrate");
        try {
          await narrate(runDir, config, tracer);
        } finally {
          tracer.writeCost(runDir);
        }
        return;
      }
      if (stage !== "review") notYet(`spr stage ${stage}`, "Milestone 2");
      const config = loadConfig();
      const runDir = path.resolve(opts.run);
      const tracer = new Tracer(runDir);
      report(runDir, "re-running review");
      try {
        await review(runDir, readIngest(opts.run), config, tracer);
      } finally {
        tracer.writeCost(runDir);
      }
    });

  program
    .command("eval")
    .description("Score the pipeline on the golden set (precision and recall)")
    .argument("[dir]", "golden set folder", "golden")
    .option(
      "--model <name>",
      "model to score; repeat to compare several in one table",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--out <dir>", "where the per-sample run folders go (default: runs/eval)")
    .option("--no-cache", "ignore the on-disk model cache, for a cold measurement")
    .action(async (dir: string, opts: EvalOptions) => {
      const config = loadConfig();
      const outDir = path.resolve(opts.out ?? path.join(config.runs.dir, "eval"));
      const report = await runEval({
        goldenDir: path.resolve(dir),
        outDir,
        config,
        secrets: readSecrets(),
        models: opts.model,
        noCache: opts.cache === false,
        onProgress: (line) => {
          console.log(line);
        },
      });

      mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, "eval.json");
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

      for (const line of formatReport(report)) console.log(line);
      console.log(`wrote ${file}`);
    });

  program
    .command("validate")
    .description("Validate JSON files against their contract schemas")
    .argument("<files...>", "files such as review.json, script.expected.json, audio/manifest.json")
    .option("--schema <name>", `force a contract: ${CONTRACT_NAMES.join(", ")}`, parseContract)
    .action((files: string[], opts: { schema?: ContractName }) => {
      const results = files.map((f) => validateFile(f, opts.schema));
      if (results.includes(false)) process.exitCode = 1;
    });

  program
    .command("config")
    .description("Print the resolved configuration (secrets shown only as set/missing)")
    .option("--file <path>", "extra config file merged over the defaults")
    .action((opts: { file?: string }) => {
      const config = loadConfig(opts.file === undefined ? {} : { configFile: opts.file });
      const secrets = readSecrets();
      console.log(JSON.stringify(config, null, 2));
      console.log(
        `\nANTHROPIC_API_KEY: ${secrets.anthropicApiKey ? "set" : "missing"}` +
          `\nGITHUB_TOKEN:      ${secrets.githubToken ? "set" : "missing"}`,
      );
    });

  return program;
}

/** Entry point: prints one clear line on failure and sets the exit code. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (error) {
    if (error instanceof StageError) {
      console.error(`spr: [${error.stage}] ${error.message}`);
      process.exitCode = 1;
    } else if (error instanceof ContractError) {
      console.error(`spr: ${error.message}`);
      process.exitCode = 1;
    } else if (error instanceof NotImplementedError) {
      console.error(`spr: ${error.message}`);
      process.exitCode = 2;
    } else if (error instanceof InvalidArgumentError) {
      console.error(`spr: ${error.message}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

/** True when this file is the process entry point (also through the npm bin symlink). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await main();
}
