import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { StageError } from "./errors.js";

/**
 * Everything the pipeline writes into a run folder, by name: the files each stage produces, the
 * rejected draft Narrate leaves when it fails, the `audio/` folder with Compose's scratch in it,
 * and the trace and cost of the run. A test holds this list to the stages' own constants.
 */
export const RUN_OUTPUTS: readonly string[] = [
  "diff.raw.patch",
  "diff.patch",
  "ingest.json",
  "review.raw.json",
  "review.json",
  "script.json",
  "script.rejected.json",
  "audio",
  "timeline.json",
  "page.html",
  "video.webm",
  "record.json",
  "subtitles.srt",
  "final.mp4",
  "comment.md",
  "trace.jsonl",
  "cost.json",
];

/** Options for {@link createRunFolder}. */
export interface CreateRunFolderOptions {
  /** Base folder for generated run folders (config `runs.dir`). */
  runsDir: string;
  /** Short run identifier: head sha for `--git`, diff hash for `--diff`. */
  id: string;
  /** Explicit folder chosen with `--out`, used instead of a generated name. */
  out?: string;
  /**
   * Allow a folder that already has files in it. The pipeline's own outputs from an earlier run
   * are removed first ({@link RUN_OUTPUTS}); anything else in the folder is left alone.
   */
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
 *
 * With `force`, an earlier run's outputs are cleared first (ADR-052). Writing over them was not
 * enough: a run that stopped earlier than the last one - a review that kept nothing, or
 * `--until` - left the last one's video beside its own review, and a reader could not tell.
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

  for (const name of existing.filter((entry) => RUN_OUTPUTS.includes(entry))) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
