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
