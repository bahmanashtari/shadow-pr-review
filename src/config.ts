import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileSchema } from "./contracts/validate.js";
import type { SprConfig } from "./contracts/generated/config.js";
import { StageError } from "./lib/errors.js";
import { fromRoot } from "./lib/paths.js";

export type { SprConfig };

type Env = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;

/**
 * Environment variables that override config values.
 * Keep this table in sync with `.env.example` and CLAUDE.md.
 */
export const ENV_OVERRIDES: readonly {
  env: string;
  path: string;
  type: "string" | "number" | "boolean";
}[] = [
  { env: "SPR_LLM_PROVIDER", path: "llm.provider", type: "string" },
  { env: "SPR_LLM_MODEL", path: "llm.model", type: "string" },
  { env: "SPR_LLM_MODEL_REVIEW", path: "llm.models.review", type: "string" },
  { env: "SPR_LLM_MODEL_VERIFY", path: "llm.models.verify", type: "string" },
  { env: "SPR_LLM_MODEL_NARRATE", path: "llm.models.narrate", type: "string" },
  { env: "SPR_LLM_BASE_URL", path: "llm.baseUrl", type: "string" },
  { env: "SPR_LLM_EFFORT", path: "llm.effort", type: "string" },
  { env: "SPR_LLM_THINK", path: "llm.think", type: "boolean" },
  { env: "SPR_TTS_PROVIDER", path: "tts.provider", type: "string" },
  { env: "SPR_KOKORO_URL", path: "tts.baseUrl", type: "string" },
  { env: "SPR_TTS_VOICE", path: "tts.voice", type: "string" },
  { env: "SPR_TTS_SPEED", path: "tts.speed", type: "number" },
  { env: "SPR_SUBTITLES", path: "video.subtitles", type: "string" },
  { env: "SPR_RUNS_DIR", path: "runs.dir", type: "string" },
  { env: "SPR_CACHE_DIR", path: "cache.dir", type: "string" },
  { env: "SPR_CACHE_ENABLED", path: "cache.enabled", type: "boolean" },
];

/** Environment spellings accepted for a boolean override. */
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** Secrets are read from the environment only and never stored in config or traces. */
export interface Secrets {
  anthropicApiKey?: string;
  githubToken?: string;
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: Env;
  /** Extra JSON file merged over the defaults. Also settable with `SPR_CONFIG`. */
  configFile?: string;
}

const validateConfig = compileSchema<SprConfig>(
  JSON.parse(readFileSync(fromRoot("config", "config.schema.json"), "utf8")) as JsonObject,
);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges plain objects; arrays and scalars from `override` replace those in `base`. */
export function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

function readJsonObject(file: string): JsonObject {
  if (!existsSync(file)) throw new StageError("config", `Config file not found: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("config", `Config file is not valid JSON: ${file}`, { cause });
  }
  if (!isObject(parsed))
    throw new StageError("config", `Config file must contain an object: ${file}`);
  return parsed;
}

function setPath(target: JsonObject, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  const last = keys.pop();
  if (last === undefined) return;
  let node = target;
  for (const key of keys) {
    const next = node[key];
    if (!isObject(next)) node[key] = {};
    node = node[key] as JsonObject;
  }
  node[last] = value;
}

function applyEnv(config: JsonObject, env: Env): JsonObject {
  const result = structuredClone(config);
  for (const o of ENV_OVERRIDES) {
    const raw = env[o.env];
    if (raw === undefined || raw.trim() === "") continue;
    const text = raw.trim();
    let value: string | number | boolean = text;
    if (o.type === "number") {
      value = Number(text);
      if (!Number.isFinite(value)) {
        throw new StageError("config", `${o.env} must be a number, got "${raw}"`);
      }
    } else if (o.type === "boolean") {
      const lower = text.toLowerCase();
      if (TRUE_VALUES.has(lower)) value = true;
      else if (FALSE_VALUES.has(lower)) value = false;
      else throw new StageError("config", `${o.env} must be true or false, got "${raw}"`);
    }
    setPath(result, o.path, value);
  }
  return result;
}

/**
 * Loads `config/default.json`, merges an optional config file, applies `SPR_*`
 * environment overrides, and validates the result against `config/config.schema.json`.
 * @throws StageError with every validation problem listed.
 */
export function loadConfig(options: LoadConfigOptions = {}): SprConfig {
  const env = options.env ?? process.env;
  let merged = readJsonObject(fromRoot("config", "default.json"));

  const extra = options.configFile ?? env.SPR_CONFIG;
  if (extra) merged = deepMerge(merged, readJsonObject(path.resolve(extra)));

  const result = validateConfig(applyEnv(merged, env));
  if (!result.ok) {
    throw new StageError("config", `Invalid configuration:\n  - ${result.errors.join("\n  - ")}`);
  }
  return result.value;
}

/** Reads secrets from the environment. Empty strings count as missing. */
export function readSecrets(env: Env = process.env): Secrets {
  const pick = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const secrets: Secrets = {};
  const anthropicApiKey = pick("ANTHROPIC_API_KEY");
  const githubToken = pick("GITHUB_TOKEN") ?? pick("GH_TOKEN");
  if (anthropicApiKey) secrets.anthropicApiKey = anthropicApiKey;
  if (githubToken) secrets.githubToken = githubToken;
  return secrets;
}
