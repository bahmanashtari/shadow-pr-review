import { execa } from "execa";

/** Options for {@link run}. */
export interface RunOptions {
  /** Working directory of the child process. */
  cwd?: string;
  /** Kill the process after this many milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Extra environment variables, merged over the current environment. */
  env?: Readonly<Record<string, string>>;
}

/** How much of stderr is quoted in an error message. */
const STDERR_TAIL_LINES = 20;

function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Reads `stderr` off a failed child process without trusting the error's declared shape. */
function stderrOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const { stderr } = error as { stderr?: unknown };
  return typeof stderr === "string" ? stderr.trim() : "";
}

/**
 * Runs an external program (git, ffmpeg, ffprobe) without a shell and returns its stdout.
 * The single place where this tool spawns processes, so timeouts and error text stay uniform.
 * @throws Error naming the command and quoting the last 20 lines of stderr.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const { cwd, timeoutMs = 30_000, env } = options;
  try {
    const result = await execa(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      timeout: timeoutMs,
      shell: false,
      stripFinalNewline: false,
      windowsHide: true,
    });
    return result.stdout;
  } catch (cause) {
    const shown = [command, ...args].join(" ");
    const stderr = stderrOf(cause);
    const detail =
      stderr === ""
        ? cause instanceof Error
          ? cause.message
          : String(cause)
        : tail(stderr, STDERR_TAIL_LINES);
    throw new Error(`Command failed: ${shown}\n${detail}`, { cause });
  }
}
