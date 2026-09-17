import { describe, expect, it } from "vitest";
import { createTtsProvider } from "../../src/providers/tts/create.js";
import { FakeTtsProvider, fakeDurationMs, silentWav } from "../../src/providers/tts/fake.js";
import { KokoroHttpProvider } from "../../src/providers/tts/kokoro-http.js";
import type { TtsRequest } from "../../src/providers/tts/types.js";
import { readWavInfo } from "../../src/tts/duration.js";
import { StageError } from "../../src/lib/errors.js";
import { defaultConfig } from "../helpers.js";

const REQUEST: TtsRequest = { text: "Hi. This is a review.", voice: "af_heart", speed: 1 };

/**
 * The provider only ever fetches string URLs, so a stub may take one. `fetch`'s own first
 * parameter is wider than that, hence the cast in {@link asFetch}.
 */
type FetchStub = (url: string) => Promise<Response>;

function asFetch(stub: FetchStub): typeof fetch {
  return stub as unknown as typeof fetch;
}

/** A healthy server whose `/v1/audio/speech` answers with `speech`. */
function kokoroFetch(speech: () => Response): typeof fetch {
  return asFetch((url) =>
    Promise.resolve(url.endsWith("/health") ? ({ ok: true, status: 200 } as Response) : speech()),
  );
}

/** A response carrying WAV bytes. */
function wavResponse(wav: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)),
  } as unknown as Response;
}

describe("KokoroHttpProvider", () => {
  it("builds the documented OpenAI-compatible request body", () => {
    const provider = new KokoroHttpProvider({ baseUrl: "http://localhost:8880" });
    expect(provider.buildBody({ text: "Hello.", voice: "am_michael", speed: 1.25 })).toEqual({
      model: "kokoro",
      input: "Hello.",
      voice: "am_michael",
      response_format: "wav",
      speed: 1.25,
    });
  });

  it("waits for the health endpoint before the first synthesis", async () => {
    // The first request after a cold start is slow because the model is still loading.
    const calls: string[] = [];
    const fetchImpl = asFetch((url) => {
      calls.push(url);
      return Promise.resolve(
        url.endsWith("/health")
          ? ({ ok: true, status: 200 } as Response)
          : wavResponse(silentWav(500)),
      );
    });

    const provider = new KokoroHttpProvider({ baseUrl: "http://localhost:8880", fetchImpl });
    await provider.synthesize(REQUEST);
    await provider.synthesize(REQUEST);

    expect(calls[0]).toBe("http://localhost:8880/health");
    // Health is polled once, not before every clip.
    expect(calls.filter((c) => c.endsWith("/health"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("/v1/audio/speech"))).toHaveLength(2);
  });

  it("returns the bytes the server sent, untouched", async () => {
    const wav = silentWav(1234);
    const provider = new KokoroHttpProvider({
      baseUrl: "http://localhost:8880",
      fetchImpl: kokoroFetch(() => wavResponse(wav)),
    });
    const got = await provider.synthesize(REQUEST);
    expect(readWavInfo(got).durationMs).toBe(1234);
  });

  it("reports the status and the server's own text on a refusal", async () => {
    const provider = new KokoroHttpProvider({
      baseUrl: "http://localhost:8880",
      fetchImpl: kokoroFetch(
        () =>
          ({
            ok: false,
            status: 400,
            text: () => Promise.resolve("Voice 'nope' not found"),
          }) as unknown as Response,
      ),
    });
    await expect(provider.synthesize({ ...REQUEST, voice: "nope" })).rejects.toThrow(
      /Kokoro returned 400 for voice "nope": Voice 'nope' not found/,
    );
  });

  it("says the container is not running, and how to start it", async () => {
    // The most likely failure of the whole stage, so it names the command that fixes it.
    const fetchImpl = asFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const provider = new KokoroHttpProvider({
      baseUrl: "http://localhost:8880",
      fetchImpl,
      readyTimeoutMs: 0,
      readyPollMs: 1,
    });

    const error = await provider.synthesize(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageError);
    expect((error as StageError).stage).toBe("tts");
    expect((error as StageError).message).toMatch(/Cannot reach Kokoro at http:\/\/localhost:8880/);
    expect((error as StageError).message).toMatch(/docker compose -f docker\/compose\.yml up -d/);
    expect((error as StageError).message).toMatch(/SPR_TTS_PROVIDER=fake/);
  });

  it("does not memoize a readiness failure, so a container that comes up late still works", async () => {
    let up = false;
    const fetchImpl = asFetch((url) => {
      if (url.endsWith("/health")) {
        return up
          ? Promise.resolve({ ok: true, status: 200 } as Response)
          : Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve(wavResponse(silentWav(400)));
    });

    const provider = new KokoroHttpProvider({
      baseUrl: "http://x",
      fetchImpl,
      readyTimeoutMs: 0,
      readyPollMs: 1,
    });
    await expect(provider.synthesize(REQUEST)).rejects.toThrow(StageError);

    up = true;
    await expect(provider.synthesize(REQUEST)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("trims a trailing slash off the base URL", async () => {
    const calls: string[] = [];
    const fetchImpl = asFetch((url) => {
      calls.push(url);
      return Promise.resolve(
        url.endsWith("/health")
          ? ({ ok: true, status: 200 } as Response)
          : wavResponse(silentWav(100)),
      );
    });

    await new KokoroHttpProvider({ baseUrl: "http://localhost:8880/", fetchImpl }).synthesize(
      REQUEST,
    );
    expect(calls).toEqual([
      "http://localhost:8880/health",
      "http://localhost:8880/v1/audio/speech",
    ]);
  });
});

describe("FakeTtsProvider", () => {
  it("returns real WAV bytes, not a stub", async () => {
    // The Director and the Recorder both consume measured durations, so a fake run has to
    // produce audio a measurement can be taken from.
    const wav = await new FakeTtsProvider().synthesize(REQUEST);
    const info = readWavInfo(wav);
    expect(info.sampleRate).toBe(24_000);
    expect(info.channels).toBe(1);
    expect(info.durationMs).toBeGreaterThan(0);
  });

  it("gives a length that follows the word count", async () => {
    const provider = new FakeTtsProvider();
    const short = await provider.synthesize({ ...REQUEST, text: "Three short words." });
    const long = await provider.synthesize({
      ...REQUEST,
      text: Array.from({ length: 40 }, () => "word").join(" "),
    });
    expect(readWavInfo(long).durationMs).toBeGreaterThan(readWavInfo(short).durationMs);
    expect(readWavInfo(long).durationMs).toBe(
      fakeDurationMs(Array.from({ length: 40 }, () => "word").join(" "), 1),
    );
  });

  it("is faster at a higher speed, the way a real voice is", () => {
    const text = Array.from({ length: 30 }, () => "word").join(" ");
    expect(fakeDurationMs(text, 2)).toBeLessThan(fakeDurationMs(text, 1));
  });

  it("is deterministic, so a fake run is byte-identical twice", async () => {
    const a = await new FakeTtsProvider().synthesize(REQUEST);
    const b = await new FakeTtsProvider().synthesize(REQUEST);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("createTtsProvider", () => {
  it("builds the configured default", () => {
    expect(createTtsProvider(defaultConfig()).name).toBe("kokoro-http");
  });

  it("builds the fake when the config selects it", () => {
    const config = defaultConfig();
    const fake = createTtsProvider({ ...config, tts: { ...config.tts, provider: "fake" } });
    expect(fake.name).toBe("fake");
  });

  it("says plainly that piper is not built yet", () => {
    const config = defaultConfig();
    expect(() =>
      createTtsProvider({ ...config, tts: { ...config.tts, provider: "piper" } }),
    ).toThrow(/"piper" TTS provider is not implemented yet/);
  });
});
