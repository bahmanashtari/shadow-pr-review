#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, readSecrets } from "./config.js";
import type { SprConfig } from "./contracts/generated/config.js";
import type { IngestResult } from "./contracts/generated/ingest.js";
import type { Finding } from "./contracts/generated/review.js";
import { checkIngest, checkReview } from "./contracts/checks.js";
import {
  CONTRACT_NAMES,
  contractFromFileName,
  isContractName,
  type ContractName,
} from "./contracts/schemas.js";
import { validateContract } from "./contracts/validate.js";
import { buildIngest, readIngest, readRawDiff, summarize, writeIngest } from "./ingest/ingest.js";
import {
  checkoutAt,
  fromDiffFile,
  fromGitRange,
  fromPullRequest,
  originRepo,
  type DiffSource,
} from "./ingest/sources.js";
import { runReview, summarizeReview, writeReview } from "./agents/reviewer.js";
import { judgeFindings } from "./agents/verifier.js";
import { readScript, runNarrate, summarizeNarrate, writeScript } from "./agents/narrator.js";
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
import { createCache, createTtsCache } from "./harness/cache.js";
import { Tracer } from "./harness/tracing.js";
import { createProvider } from "./providers/llm/create.js";
import { createTtsProvider } from "./providers/tts/create.js";
import { readManifest, runTts, summarizeTts, writeManifest } from "./tts/speak.js";
import { readTimeline, runDirect, summarizeDirect, writeTimeline } from "./director/direct.js";
import { runRecord, summarizeRecord, writeRecord } from "./recorder/record.js";
import { runCompose, summarizeCompose } from "./composer/compose.js";
import { readRecord } from "./recorder/record.js";
import { ContractError, StageError } from "./lib/errors.js";
import { createGitHubClient } from "./lib/github.js";
import { createRunFolder } from "./lib/run-folder.js";
import { isVideoUrl, runPublish, summarizePublish } from "./publish/publish.js";

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

function parseContract(value: string): ContractName {
  if (!isContractName(value)) {
    throw new InvalidArgumentError(`Expected one of: ${CONTRACT_NAMES.join(", ")}`);
  }
  return value;
}

/** `--video-url`: an https URL that can sit in a markdown link as it is. */
function parseVideoUrl(value: string): string {
  if (!isVideoUrl(value)) {
    throw new InvalidArgumentError(`Expected an https URL for the video, got "${value}"`);
  }
  return value;
}

/** `--pr 142`: a positive whole number, nothing else. */
function parsePrNumber(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value)) {
    throw new InvalidArgumentError(`Expected a pull request number such as 142, got "${value}"`);
  }
  return Number(value);
}

function parseStage(value: string): StageName {
  if (!(PIPELINE_STAGES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Expected one of: ${PIPELINE_STAGES.join(", ")}`);
  }
  return value as StageName;
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
  pr?: number;
  repo?: string;
  title?: string;
  out?: string;
  force?: boolean;
  until?: StageName;
}

/** Options of `spr stage`, as Commander hands them over. */
interface StageOptions {
  run: string;
  videoUrl?: string;
  dryRun?: boolean;
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
 * `spr run`: reads the diff, writes the run folder, then walks the pipeline to `comment.md`.
 * It never posts: that is `spr stage publish`, deliberately a command of its own (ADR-052).
 */
async function runPipeline(opts: RunOptions): Promise<void> {
  const given = [opts.diff, opts.git, opts.pr].filter((o) => o !== undefined).length;
  if (given !== 1) throw new InvalidArgumentError("Pass exactly one of --diff, --git or --pr");
  if (opts.repo !== undefined && opts.pr === undefined) {
    throw new InvalidArgumentError("--repo goes with --pr");
  }

  const config = loadConfig();
  const source = await readSource(opts);

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
    const verified = await verify(runDir, built.ingest, config, tracer);

    // A clean review is the end of the run, not a stage that failed (ADR-042). A video exists
    // to explain issues that were found, so with none there is nothing to narrate, speak,
    // record or compose - and none of that is paid for. Exit code 0: this is a correct
    // outcome, and Publish will post the review without a video.
    if (verified === 0) {
      console.log("no findings survived verification: nothing to narrate, so no video was made");
      // The comment still says so: a pull request whose findings were fixed must stop showing them.
      if (opts.until === undefined || opts.until === "publish") await publish(runDir, false);
      return;
    }

    if (opts.until === "verify") return;
    await narrate(runDir, config, tracer);
  } finally {
    tracer.writeCost(runDir);
  }

  if (opts.until === "narrate") return;
  await speak(runDir, config);

  if (opts.until === "tts") return;
  direct(runDir, config);

  if (opts.until === "direct") return;
  await recordVideo(runDir);

  if (opts.until === "record") return;
  await compose(runDir, config);

  if (opts.until === "compose") return;
  await publish(runDir, false);
}

/**
 * Runs the Publish stage over an existing run folder: renders `comment.md`, and posts it on the
 * pull request only when `post` is set. The token is read here, and only a client with one is
 * handed over, so a missing token is reported by the stage in its own words.
 */
async function publish(
  runDir: string,
  post: boolean,
  options: { videoUrl?: string } = {},
): Promise<void> {
  const token = readSecrets().githubToken;
  const outcome = await runPublish({
    runDir,
    post,
    ...(options.videoUrl === undefined ? {} : { videoUrl: options.videoUrl }),
    ...(token === undefined ? {} : { github: createGitHubClient({ token }) }),
  });
  console.log(summarizePublish(outcome));
}

/** Reads the change `spr run` was pointed at: a diff file, a local git range or a pull request. */
async function readSource(opts: RunOptions): Promise<DiffSource> {
  const titleOption = opts.title === undefined ? {} : { title: opts.title };
  if (opts.diff !== undefined) return fromDiffFile(opts.diff, titleOption);
  if (opts.git !== undefined) {
    return fromGitRange(opts.git, { cwd: process.cwd(), ...titleOption });
  }

  const repo = opts.repo ?? (await originRepo(process.cwd()));
  if (repo === null) {
    throw new InvalidArgumentError(
      "Pass --repo owner/name: the working directory has no GitHub origin remote",
    );
  }
  const { pr } = opts;
  if (pr === undefined) throw new InvalidArgumentError("Pass exactly one of --diff, --git or --pr");
  const token = readSecrets().githubToken;
  const github = createGitHubClient(token === undefined ? {} : { token });
  return fromPullRequest(pr, repo, { github, ...titleOption });
}

/**
 * Runs the Compose stage over an existing run folder and prints what it made.
 * Reads every input back from disk, so `spr run` and `spr stage compose` take the same path.
 */
async function compose(runDir: string, config: SprConfig): Promise<void> {
  const outcome = await runCompose({
    timeline: readTimeline(runDir),
    manifest: readManifest(runDir),
    script: readScript(runDir),
    record: readRecord(runDir),
    config,
    runDir,
  });
  console.log(summarizeCompose(outcome));
}

/**
 * Runs the Record stage over an existing run folder and prints what it captured.
 * Reads `timeline.json`, `script.json`, `review.json` and `diff.patch` back from disk, so
 * `spr run` and `spr stage record` follow exactly the same path. The frame size is the
 * timeline's, so there is nothing here for the configuration to say.
 */
async function recordVideo(runDir: string): Promise<void> {
  const outcome = await runRecord({
    timeline: readTimeline(runDir),
    diffText: readFileSync(path.join(runDir, "diff.patch"), "utf8"),
    runDir,
  });
  writeRecord(runDir, outcome.result);
  console.log(summarizeRecord(outcome));
}

/**
 * Runs the Direct stage over an existing run folder and prints the schedule it built.
 * It reads `script.json` and `audio/manifest.json` back from disk, so `spr run` and
 * `spr stage direct` follow exactly the same path.
 */
function direct(runDir: string, config: SprConfig): void {
  const outcome = runDirect({
    script: readScript(runDir),
    manifest: readManifest(runDir),
    config,
  });
  writeTimeline(runDir, outcome.timeline);
  console.log(summarizeDirect(outcome));
}

/**
 * Runs the TTS stage over an existing run folder and prints what it measured.
 * Like verify and narrate, it reads `script.json` back from disk, so `spr run` and
 * `spr stage tts` follow exactly the same path - including for a script a person finished
 * by hand after a rejected draft.
 */
async function speak(runDir: string, config: SprConfig): Promise<void> {
  const outcome = await runTts({
    script: readScript(runDir),
    provider: createTtsProvider(config),
    config,
    cache: createTtsCache(config.cache),
    runDir,
  });
  writeManifest(runDir, outcome.manifest);
  console.log(summarizeTts(outcome));
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
  // Tools that read the repository are offered only on a checkout at the reviewed head
  // (ADR-051); anywhere else they would describe different code.
  const headSha = ingest.source.head_sha ?? null;
  const repoRoot = await checkoutAt(headSha, process.cwd());
  if (repoRoot === undefined && headSha !== null) {
    console.log(
      `no checkout at ${headSha.slice(0, 7)} here: reviewing from the diff alone, ` +
        "without read_file and grep_repo",
    );
  }
  const outcome = await runReview({
    ingest,
    provider: createProvider(config, readSecrets()),
    config,
    budget: new Budget(config.budgets),
    tracer,
    cache: createCache(config.cache),
    ...(repoRoot === undefined ? {} : { repoRoot }),
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
 *
 * The agent layer is passed in only when there is a tracer to account for it (ADR-037). A bare
 * `spr stage verify` therefore runs the deterministic checks alone, offline and instantly,
 * which is what makes re-screening a run folder free.
 */
async function verify(
  runDir: string,
  ingest: IngestResult,
  config: SprConfig,
  tracer?: Tracer,
): Promise<number> {
  const judge =
    tracer === undefined
      ? {}
      : {
          judge: (findings: readonly Finding[]) =>
            judgeFindings({
              findings,
              ingest,
              provider: createProvider(config, readSecrets()),
              config,
              budget: new Budget(config.budgets),
              tracer,
              cache: createCache(config.cache),
            }),
        };
  const outcome = await runVerify({ ingest, review: readRawReview(runDir), config, ...judge });
  writeVerifiedReview(runDir, outcome.review);
  console.log(summarizeVerify(outcome));
  return outcome.kept;
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
    .option("--pr <number>", "GitHub pull request number", parsePrNumber)
    .option("--repo <owner/name>", "GitHub repository for --pr (default: the origin remote)")
    .option("--title <text>", "title of the change (default: the commit subject or PR title)")
    .option("--out <dir>", "run folder (default: runs/<timestamp>-<id>)")
    .option("--force", "write into the run folder even when it already has files")
    .option("--until <stage>", `stop after this stage: ${PIPELINE_STAGES.join(", ")}`, parseStage)
    .action(runPipeline);

  program
    .command("stage")
    .description("Re-run a single stage on an existing run folder")
    .argument("<name>", `one of: ${PIPELINE_STAGES.join(", ")}`)
    .requiredOption("--run <dir>", "existing run folder")
    .option("--video-url <url>", "publish: where the video was uploaded", parseVideoUrl)
    .option("--dry-run", "publish: write comment.md without posting it")
    .action(async (name: string, opts: StageOptions) => {
      const stage = parseStage(name);
      if (stage !== "publish" && (opts.videoUrl !== undefined || opts.dryRun !== undefined)) {
        throw new InvalidArgumentError("--video-url and --dry-run go with publish");
      }
      if (stage === "ingest") {
        reingest(opts.run);
        return;
      }
      if (stage === "verify") {
        const config = loadConfig();
        const runDir = path.resolve(opts.run);
        report(runDir, "re-running verify");
        await verify(runDir, readIngest(runDir), config);
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
      if (stage === "tts") {
        const config = loadConfig();
        const runDir = path.resolve(opts.run);
        report(runDir, "re-running tts");
        await speak(runDir, config);
        return;
      }
      if (stage === "direct") {
        const config = loadConfig();
        const runDir = path.resolve(opts.run);
        report(runDir, "re-running direct");
        direct(runDir, config);
        return;
      }
      if (stage === "record") {
        // The frame size comes from the timeline, so this stage needs no configuration.
        const runDir = path.resolve(opts.run);
        report(runDir, "re-running record");
        await recordVideo(runDir);
        return;
      }
      if (stage === "compose") {
        const config = loadConfig();
        const runDir = path.resolve(opts.run);
        report(runDir, "re-running compose");
        await compose(runDir, config);
        return;
      }
      if (stage === "publish") {
        const runDir = path.resolve(opts.run);
        report(runDir, opts.dryRun === true ? "rendering the comment" : "publishing");
        await publish(runDir, opts.dryRun !== true, {
          ...(opts.videoUrl === undefined ? {} : { videoUrl: opts.videoUrl }),
        });
        return;
      }
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
