/**
 * Content-addressed cache of model responses (ADR-017). It lives outside the run folders,
 * so re-running a stage and scoring the golden set are free in both time and money.
 *
 * Because the key covers the whole request, a changed prompt, schema or model misses rather
 * than returning something stale, and deleting the directory is always safe.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../lib/hash.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../providers/llm/types.js";

/** What a cache must do. */
export interface LlmCache {
  get(key: string): LlmResponse | undefined;
  set(key: string, response: LlmResponse): void;
}

/**
 * Hashes everything that could change the answer. Field order is fixed here rather than
 * taken from the object, so an unrelated key reordering cannot invalidate the cache.
 */
export function llmCacheKey(provider: LlmProvider, request: LlmRequest): string {
  return sha256(
    JSON.stringify([
      provider.name,
      provider.model,
      request.system,
      request.messages,
      request.tools,
      request.outputSchema ?? null,
      request.temperature,
      request.maxOutputTokens,
    ]),
  );
}

/** A cache that never hits, used when `cache.enabled` is false. */
export class NullCache implements LlmCache {
  get(): undefined {
    return undefined;
  }
  set(): void {
    // Intentionally does nothing.
  }
}

/** Stores one JSON file per key under `<dir>/llm/`. */
export class FileLlmCache implements LlmCache {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = path.resolve(baseDir, "llm");
  }

  private fileFor(key: string): string {
    // Two-character shard keeps directories from growing to tens of thousands of entries.
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): LlmResponse | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.fileFor(key), "utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const entry = parsed as { response?: LlmResponse };
      return entry.response;
    } catch {
      // A missing, unreadable or corrupt entry is a miss, never a failed run.
      return undefined;
    }
  }

  set(key: string, response: LlmResponse): void {
    const file = this.fileFor(key);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ key, response }, null, 2)}\n`, "utf8");
    } catch {
      // A cache that cannot be written must not break the run.
    }
  }
}

/** Builds the cache named in the configuration. */
export function createCache(config: { enabled: boolean; dir: string }): LlmCache {
  return config.enabled ? new FileLlmCache(config.dir) : new NullCache();
}

/**
 * A cache that records answers but never serves them.
 *
 * What `spr eval --no-cache` wants: a cold measurement should not be handed a stale answer,
 * but there is no reason to forget the fresh one. Without this, re-scoring a comparison after
 * adding a metric or fixing a label costs another full run of every model.
 */
export function writeOnly(cache: LlmCache): LlmCache {
  return {
    get: () => undefined,
    set: (key, value) => {
      cache.set(key, value);
    },
  };
}

/**
 * The same bargain for audio (ADR-017, ADR-027). A clip is expensive in wall clock rather
 * than money, and a script that changed one step should re-synthesize one step.
 */
export interface TtsCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, wav: Uint8Array): void;
}

/**
 * Hashes what the manifest says it hashes: provider, voice, speed and the *normalized* text.
 * The model that wrote the words is deliberately not in the key - two models that produce the
 * same sentence should share the clip.
 */
export function ttsCacheKey(
  provider: string,
  voice: string,
  speed: number,
  normalizedText: string,
): string {
  return sha256(JSON.stringify([provider, voice, speed, normalizedText]));
}

/** A cache that never hits, used when `cache.enabled` is false. */
export class NullTtsCache implements TtsCache {
  get(): undefined {
    return undefined;
  }
  set(): void {
    // Intentionally does nothing.
  }
}

/** Stores one WAV file per key under `<dir>/tts/`. */
export class FileTtsCache implements TtsCache {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = path.resolve(baseDir, "tts");
  }

  private fileFor(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.wav`);
  }

  get(key: string): Uint8Array | undefined {
    try {
      return readFileSync(this.fileFor(key));
    } catch {
      // A missing or unreadable entry is a miss, never a failed run.
      return undefined;
    }
  }

  set(key: string, wav: Uint8Array): void {
    const file = this.fileFor(key);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, wav);
    } catch {
      // A cache that cannot be written must not break the run.
    }
  }
}

/** Builds the audio cache named in the configuration. */
export function createTtsCache(config: { enabled: boolean; dir: string }): TtsCache {
  return config.enabled ? new FileTtsCache(config.dir) : new NullTtsCache();
}
