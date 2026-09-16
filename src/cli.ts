#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, readSecrets } from "./config.js";
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
  throw new NotImplementedError(
    `stopped after ingest: review is not implemented yet (Milestone 1, step 4). ` +
      `Run folder: ${runDir}`,
  );
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
    .action((name: string, opts: { run: string }) => {
      const stage = parseStage(name);
      if (stage !== "ingest") notYet(`spr stage ${stage}`, "Milestone 1, steps 3 to 6");
      reingest(opts.run);
    });

  program
    .command("eval")
    .description("Score the pipeline on the golden set (precision and recall)")
    .argument("[dir]", "golden set folder", "golden")
    .action(() => notYet("spr eval", "Milestone 1, step 7"));

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
