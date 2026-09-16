/**
 * The tool registry the agent loop dispatches through.
 *
 * Tools are read-only by design (CLAUDE.md): no shell, no writes, no network. This file
 * holds the plumbing only; the four diff tools arrive with the Reviewer in step 4.
 */
import { compileSchema } from "../contracts/validate.js";
import type { ToolDefinition } from "../providers/llm/types.js";

/** A tool the model may call. */
export interface ToolHandler {
  definition: ToolDefinition;
  /** Runs the tool. Throwing is fine: the loop reports it to the model as an error result. */
  run(input: Record<string, unknown>): Promise<string> | string;
}

/** What a dispatch produced. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
  durationMs: number;
}

/** Results above this are truncated, so one tool cannot eat the context window. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

type Validator = (data: unknown) => { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Holds the tools for one agent run and validates their arguments. */
export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly validators = new Map<string, Validator>();

  constructor(handlers: readonly ToolHandler[] = []) {
    for (const handler of handlers) this.register(handler);
  }

  /** Adds a tool. The name must be unique within a run. */
  register(handler: ToolHandler): void {
    const { name } = handler.definition;
    if (this.handlers.has(name)) throw new Error(`Tool ${name} is registered twice`);
    this.handlers.set(name, handler);
    this.validators.set(name, compileSchema<unknown>(handler.definition.inputSchema));
  }

  /** The definitions to send to the model. */
  definitions(): ToolDefinition[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }

  /** True when any tool is registered. */
  get size(): number {
    return this.handlers.size;
  }

  /**
   * Validates the arguments and runs the tool. Never throws: an unknown tool, bad arguments
   * or a failing handler all come back as an error result the model can recover from.
   */
  async dispatch(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const started = Date.now();
    const done = (content: string, isError: boolean): ToolOutcome => ({
      content:
        content.length > MAX_TOOL_RESULT_CHARS
          ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n... truncated`
          : content,
      isError,
      durationMs: Date.now() - started,
    });

    const handler = this.handlers.get(name);
    if (!handler) {
      const known = [...this.handlers.keys()].join(", ");
      return done(`No tool named "${name}". Available tools: ${known}`, true);
    }

    const validate = this.validators.get(name);
    const result = validate?.(input);
    if (result && !result.ok) {
      return done(`Invalid arguments for ${name}:\n- ${result.errors.join("\n- ")}`, true);
    }

    try {
      return done(await handler.run(input), false);
    } catch (error) {
      return done(
        `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}
