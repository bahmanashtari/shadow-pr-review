#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, readSecrets } from "./config.js";
import { checkReview } from "./contracts/checks.js";
import {
  CONTRACT_NAMES,
  contractFromFileName,
  isContractName,
  type ContractName,
} from "./contracts/schemas.js";
import { validateContract } from "./contracts/validate.js";
import { ContractError, StageError } from "./lib/errors.js";

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

function notYet(what: string, milestone: string): never {
  throw new NotImplementedError(`${what} is not implemented yet (${milestone}).`);
}

/** Schema errors, plus the file-local cross-field checks where they exist. */
function contractProblems(contract: ContractName, data: unknown): string[] {
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
    .option("--out <dir>", "run folder (default: runs/<timestamp>-<sha>)")
    .action(() => notYet("spr run", "Milestone 1, steps 2 to 6"));

  program
    .command("stage")
    .description("Re-run a single stage on an existing run folder")
    .argument("<name>", `one of: ${PIPELINE_STAGES.join(", ")}`)
    .requiredOption("--run <dir>", "existing run folder")
    .action((name: string) => {
      if (!(PIPELINE_STAGES as readonly string[]).includes(name)) {
        throw new InvalidArgumentError(`Unknown stage "${name}"`);
      }
      notYet(`spr stage ${name}`, "Milestone 1, steps 2 to 6");
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
