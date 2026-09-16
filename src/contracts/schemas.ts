import { readFileSync } from "node:fs";
import { fromRoot } from "../lib/paths.js";

/** Contract names, matching `schemas/<name>.schema.json`. */
export const CONTRACT_NAMES = ["ingest", "review", "script", "audio-manifest", "timeline"] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

/** Returns true when `value` is a known contract name. */
export function isContractName(value: string): value is ContractName {
  return (CONTRACT_NAMES as readonly string[]).includes(value);
}

/** Absolute path of a contract's JSON Schema file. */
export function schemaPath(name: ContractName): string {
  return fromRoot("schemas", `${name}.schema.json`);
}

const cache = new Map<ContractName, Record<string, unknown>>();

/**
 * Loads a contract's JSON Schema from disk.
 * The same object is passed to Ajv and, later, to the LLM as the output/tool schema.
 */
export function loadSchema(name: ContractName): Record<string, unknown> {
  const cached = cache.get(name);
  if (cached) return cached;
  const parsed: unknown = JSON.parse(readFileSync(schemaPath(name), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Schema ${name} is not a JSON object`);
  }
  const schema = parsed as Record<string, unknown>;
  cache.set(name, schema);
  return schema;
}

/**
 * Infers the contract from a file name such as `ingest.json`, `review.json`,
 * `review.expected.json`, `script.json` or `audio/manifest.json`.
 * Returns undefined when it cannot tell.
 */
export function contractFromFileName(filePath: string): ContractName | undefined {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  if (/^ingest(\.expected)?\.json$/.test(base)) return "ingest";
  if (/^review(\.raw|\.expected)?\.json$/.test(base)) return "review";
  if (/^script(\.expected)?\.json$/.test(base)) return "script";
  if (/^timeline(\.expected)?\.json$/.test(base)) return "timeline";
  if (base === "manifest.json" || base === "audio-manifest.json") return "audio-manifest";
  return undefined;
}
