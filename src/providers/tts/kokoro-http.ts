/**
 * The default provider (ADR-004): a local Kokoro-FastAPI container, no key, no cost.
 *
 * It is reached over the OpenAI-compatible `POST /v1/audio/speech`, so Piper behind a wrapper
 * or any hosted OpenAI-compatible service can reuse this client unchanged.
 *
 * Two things here are about the container rather than the audio. The first request after a
 * cold start is slow, because the model is still loading, so the client waits on the health
 * endpoint before it synthesizes anything. And a container that is not running is the most
 * likely failure of this whole stage, so it gets the treatment `providers/llm/ollama.ts`
 * gives "is ollama serve running?": a message naming the command that fixes it.
 */
import { StageError } from "../../lib/errors.js";
import type { TtsProvider, TtsRequest } from "./types.js";

/** Options for {@link KokoroHttpProvider}. */
export interface KokoroProviderOptions {
  /** Root of the server, for example `http://localhost:8880` (config `tts.baseUrl`). */
  baseUrl: string;
  /** Injected so tests never open a socket (CLAUDE.md: no network in unit tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. CPU synthesis of one narration step is seconds, not minutes. */
  timeoutMs?: number;
  /** How long to wait for a cold container to load its model before giving up. */
  readyTimeoutMs?: number;
  /** Gap between health polls. */
  readyPollMs?: number;
}

/** Kokoro's own model name on the OpenAI-compatible endpoint. */
const MODEL = "kokoro";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_READY_POLL_MS = 1_000;

/** How much of a server error is worth repeating back to the user. */
const MAX_ERROR_CHARS = 500;

/** Calls a Kokoro-FastAPI server over its OpenAI-compatible speech API. */
export class KokoroHttpProvider implements TtsProvider {
  readonly name = "kokoro-http" as const;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  /** Resolves once the server has answered `/health`; awaited by every call, run once. */
  private ready: Promise<void> | undefined;

  constructor(options: KokoroProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.readyPollMs = options.readyPollMs ?? DEFAULT_READY_POLL_MS;
  }

  /** The request body, exposed so a test can assert on it without a server. */
  buildBody(request: TtsRequest): Record<string, unknown> {
    return {
      model: MODEL,
      input: request.text,
      voice: request.voice,
      response_format: "wav",
      speed: request.speed,
    };
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<Uint8Array> {
    await this.waitUntilReady(signal);

    const response = await this.post(request, signal);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new StageError(
        "tts",
        `Kokoro returned ${response.status} for voice "${request.voice}": ` +
          detail.slice(0, MAX_ERROR_CHARS),
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async post(request: TtsRequest, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.buildBody(request)),
        signal: this.deadline(this.timeoutMs, signal),
      });
    } catch (cause) {
      throw this.unreachable(cause);
    }
  }

  /**
   * Blocks until the container answers, or says plainly that it never did.
   *
   * Only the first call actually polls; the rest await the same promise. A failure is not
   * memoized, so a container that comes up after a stumble can still be used.
   */
  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    this.ready ??= this.poll(signal).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }

  private async poll(signal?: AbortSignal): Promise<void> {
    const until = Date.now() + this.readyTimeoutMs;
    let lastError: unknown;

    for (;;) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/health`, {
          signal: this.deadline(this.readyPollMs * 5, signal),
        });
        if (response.ok) return;
        lastError = new Error(`/health answered ${response.status}`);
      } catch (cause) {
        lastError = cause;
      }
      if (Date.now() >= until) throw this.unreachable(lastError);
      await new Promise((resolve) => setTimeout(resolve, this.readyPollMs));
    }
  }

  /** A timeout, combined with the caller's own cancellation when there is one. */
  private deadline(ms: number, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  /** The failure that actually happens: nothing is listening on the port. */
  private unreachable(cause: unknown): StageError {
    return new StageError(
      "tts",
      `Cannot reach Kokoro at ${this.baseUrl}. Is the container running? ` +
        `Start it with \`docker compose -f docker/compose.yml up -d kokoro\`, or run with ` +
        `SPR_TTS_PROVIDER=fake to walk the pipeline without audio.`,
      { cause },
    );
  }
}
