import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { ContractError } from "../lib/errors.js";
import { loadSchema, type ContractName } from "./schemas.js";
import type { ReviewResult } from "./generated/review.js";
import type { NarrationScript } from "./generated/script.js";
import type { AudioManifest } from "./generated/audio-manifest.js";
import type { Timeline } from "./generated/timeline.js";

/** Maps each contract name to its generated TypeScript type. */
export interface ContractTypes {
  review: ReviewResult;
  script: NarrationScript;
  "audio-manifest": AudioManifest;
  timeline: Timeline;
}

/** Result of a validation: either the typed value or readable problems. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });

const compiled = new Map<ContractName, ValidateFunction>();

function validatorFor(name: ContractName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    fn = ajv.compile(loadSchema(name));
    compiled.set(name, fn);
  }
  return fn;
}

/**
 * Formats Ajv errors as short, model-friendly lines, for example
 * `/findings/0/severity: must be equal to one of the allowed values (critical, high, medium, low)`.
 * These lines are also what the harness sends back to the LLM on retry.
 */
export function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => {
    const where = e.instancePath === "" ? "(root)" : e.instancePath;
    let detail = e.message ?? "is invalid";
    if (e.keyword === "enum") {
      const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues;
      if (allowed) detail += ` (${allowed.map(String).join(", ")})`;
    } else if (e.keyword === "additionalProperties") {
      const extra = (e.params as { additionalProperty?: string }).additionalProperty;
      if (extra) detail += `: "${extra}"`;
    }
    return `${where}: ${detail}`;
  });
}

/** Validates `data` against a contract's JSON Schema without throwing. */
export function validateContract<N extends ContractName>(
  name: N,
  data: unknown,
): ValidationResult<ContractTypes[N]> {
  const fn = validatorFor(name);
  if (fn(data)) return { ok: true, value: data as ContractTypes[N] };
  return { ok: false, errors: formatAjvErrors(fn.errors) };
}

/** Validates `data` and returns it typed, or throws a ContractError. */
export function assertContract<N extends ContractName>(name: N, data: unknown): ContractTypes[N] {
  const result = validateContract(name, data);
  if (!result.ok) throw new ContractError(name, result.errors);
  return result.value;
}

/** Compiles any other JSON Schema (for example the config schema) with the shared Ajv instance. */
export function compileSchema<T>(
  schema: Record<string, unknown>,
): (data: unknown) => ValidationResult<T> {
  const fn = ajv.compile(schema);
  return (data) =>
    fn(data) ? { ok: true, value: data as T } : { ok: false, errors: formatAjvErrors(fn.errors) };
}
