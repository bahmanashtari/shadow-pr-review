import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { StageError } from "./errors.js";

/** Options for {@link createRunFolder}. */
export interface CreateRunFolderOptions {
  /** Base folder for generated run folders (config `runs.dir`). */
  runsDir: string;
  /** Short run identifier: head sha for `--git`, diff hash for `--diff`. */
  id: string;
  /** Explicit folder chosen with `--out`, used instead of a generated name. */
  out?: string;
  /** Allow writing into a folder that already has files in it. */
  force?: boolean;
  /** Clock, injectable so tests get a fixed folder name. */
  now?: Date;
}

/** `YYYYMMDDTHHMMSSZ`, the UTC timestamp prefix of a generated run folder. */
export function runTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Creates (and returns the absolute path of) the folder a run writes into:
 * `<runsDir>/<YYYYMMDDTHHMMSSZ>-<id>`, or `out` when given.
 * @throws StageError when the folder already holds files and `force` is not set.
 */
export function createRunFolder(options: CreateRunFolderOptions): string {
  const { runsDir, id, out, force = false, now = new Date() } = options;
  const dir = path.resolve(out ?? path.join(runsDir, `${runTimestamp(now)}-${id}`));

  let existing: string[];
  try {
    existing = readdirSync(dir);
  } catch {
    existing = []; // the folder does not exist yet
  }
  if (existing.length > 0 && !force) {
    throw new StageError("ingest", `Run folder is not empty: ${dir} (use --force to overwrite)`);
  }

  mkdirSync(dir, { recursive: true });
  return dir;
}
