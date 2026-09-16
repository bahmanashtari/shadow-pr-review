/** Pipeline stages, used to tag errors and trace entries. */
export type StageName =
  | "config"
  | "ingest"
  | "review"
  | "verify"
  | "narrate"
  | "tts"
  | "direct"
  | "record"
  | "compose"
  | "publish"
  | "eval";

/** An error raised by a pipeline stage. The CLI prints `stage` and `message` on one line. */
export class StageError extends Error {
  override readonly name = "StageError";

  constructor(
    readonly stage: StageName,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A value failed schema validation or a cross-field check. */
export class ContractError extends Error {
  override readonly name = "ContractError";

  constructor(
    readonly contract: string,
    readonly problems: readonly string[],
  ) {
    super(`${contract} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}
