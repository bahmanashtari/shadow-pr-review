import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTts, summarizeTts, writeManifest, MANIFEST_FILE } from "../../src/tts/speak.js";
import { normalizeForSpeech } from "../../src/tts/normalize.js";
import { readWavInfo } from "../../src/tts/duration.js";
import { FakeTtsProvider, fakeDurationMs, silentWav } from "../../src/providers/tts/fake.js";
import type { TtsProvider, TtsRequest } from "../../src/providers/tts/types.js";
import { FileTtsCache, ttsCacheKey, NullTtsCache } from "../../src/harness/cache.js";
import { checkAudioManifest } from "../../src/contracts/checks.js";
import type { NarrationScript } from "../../src/contracts/generated/script.js";
import { assertContract } from "../../src/contracts/validate.js";
import { ContractError, StageError } from "../../src/lib/errors.js";
import { defaultConfig, GOLDEN_SAMPLES, loadGolden } from "../helpers.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "spr-tts-"));
}

/** The shipped defaults with the TTS section adjusted. */
function configWithTts(overrides: Partial<ReturnType<typeof defaultConfig>["tts"]>) {
  const config = defaultConfig();
  return { ...config, tts: { ...config.tts, ...overrides } };
}

/** A provider that answers with whatever the test says, and counts its calls. */
class ScriptedProvider implements TtsProvider {
  readonly name = "fake" as const;
  readonly requests: TtsRequest[] = [];

  constructor(private readonly answer: (request: TtsRequest) => Uint8Array) {}

  synthesize(request: TtsRequest): Promise<Uint8Array> {
    this.requests.push(request);
    return Promise.resolve(this.answer(request));
  }
}

/**
 * A clip of the length that text would really take. The stage's sanity check compares
 * measured audio against the word count, so a test that hands back a fixed length trips it -
 * as the first draft of this file did, which is the check earning itself.
 */
function plausibleWav(request: TtsRequest, sampleRate?: number): Uint8Array {
  return silentWav(fakeDurationMs(request.text, request.speed), sampleRate);
}

const SAMPLE = GOLDEN_SAMPLES[0] ?? "sample-01-order-outbox";

/** A golden script, which is hand-written narration and so the closest thing to a real one. */
function goldenScript(): NarrationScript {
  return loadGolden(SAMPLE).script;
}

describe("runTts", () => {
  it("writes one clip per step, in order, and a manifest that matches the script", async () => {
    const runDir = tempDir();
    const script = goldenScript();
    const outcome = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir,
    });
    writeManifest(runDir, outcome.manifest);

    expect(readdirSync(path.join(runDir, "audio")).sort()).toEqual([
      ...script.steps.map((s) => `${s.id}.wav`).sort(),
      "manifest.json",
    ]);
    expect(outcome.manifest.clips.map((c) => c.step_id)).toEqual(script.steps.map((s) => s.id));
    expect(outcome.manifest.clips.map((c) => c.path)).toEqual(
      script.steps.map((s) => `audio/${s.id}.wav`),
    );
  });

  it("produces a manifest that passes its schema and its cross-file check", async () => {
    const runDir = tempDir();
    const script = goldenScript();
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir,
    });

    expect(() => {
      assertContract("audio-manifest", manifest);
    }).not.toThrow();
    expect(checkAudioManifest(manifest, script)).toEqual([]);
  });

  it("measures every duration from the written file, never from the estimate", async () => {
    const runDir = tempDir();
    // Estimates nothing could produce, so a duration that echoed them would show. The fake
    // engine times speech with the same words-per-second rule the fixtures' estimates use, so
    // on the real estimates the two can agree by construction and prove nothing (ADR-042's
    // fixture rewrite is what exposed that).
    const script = {
      ...goldenScript(),
      steps: goldenScript().steps.map((s) => ({ ...s, estimated_seconds: 999 })),
    };
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir,
    });

    for (const clip of manifest.clips) {
      const onDisk = readWavInfo(readFileSync(path.join(runDir, clip.path)));
      expect(clip.duration_ms).toBe(onDisk.durationMs);
    }
    for (const clip of manifest.clips) expect(clip.duration_ms).not.toBe(999_000);
  });

  it("records what the engine actually returned, not what it was asked for", async () => {
    const runDir = tempDir();
    const { manifest } = await runTts({
      script: goldenScript(),
      provider: new ScriptedProvider((r) => plausibleWav(r, 16_000)),
      config: configWithTts({ voice: "am_michael", speed: 1.25 }),
      runDir,
    });

    expect(manifest.sample_rate).toBe(16_000);
    expect(manifest.voice).toBe("am_michael");
    expect(manifest.speed).toBe(1.25);
    expect(manifest.provider).toBe("fake");
  });

  it("sends normalized text to the engine and keys the cache on it", async () => {
    const runDir = tempDir();
    const script = goldenScript();
    const provider = new ScriptedProvider(plausibleWav);
    const { manifest } = await runTts({ script, provider, config: defaultConfig(), runDir });

    const first = script.steps[0];
    expect(first).toBeDefined();
    const normalized = normalizeForSpeech(first?.text ?? "");
    expect(provider.requests[0]?.text).toBe(normalized);
    expect(manifest.clips[0]?.cache_key).toBe(ttsCacheKey("fake", "af_heart", 1, normalized));
  });

  describe("the cache", () => {
    it("serves a second run for free, byte for byte", async () => {
      const cacheDir = tempDir();
      const script = goldenScript();
      const config = defaultConfig();

      const firstDir = tempDir();
      const firstProvider = new FakeTtsProvider();
      const first = await runTts({
        script,
        provider: firstProvider,
        config,
        cache: new FileTtsCache(cacheDir),
        runDir: firstDir,
      });
      expect(firstProvider.requests).toHaveLength(script.steps.length);
      expect(first.cached).toBe(0);

      const secondDir = tempDir();
      const secondProvider = new FakeTtsProvider();
      const second = await runTts({
        script,
        provider: secondProvider,
        config,
        cache: new FileTtsCache(cacheDir),
        runDir: secondDir,
      });

      expect(secondProvider.requests).toHaveLength(0);
      expect(second.cached).toBe(script.steps.length);
      expect(second.manifest.clips.map((c) => c.duration_ms)).toEqual(
        first.manifest.clips.map((c) => c.duration_ms),
      );
      for (const clip of second.manifest.clips) {
        expect(
          readFileSync(path.join(secondDir, clip.path)).equals(
            readFileSync(path.join(firstDir, clip.path)),
          ),
        ).toBe(true);
      }
    });

    it("re-synthesizes only the step whose words changed", async () => {
      // The reason the cache is keyed on content: re-narrating after one edit costs one clip.
      const cacheDir = tempDir();
      const script = goldenScript();
      const config = defaultConfig();

      await runTts({
        script,
        provider: new FakeTtsProvider(),
        config,
        cache: new FileTtsCache(cacheDir),
        runDir: tempDir(),
      });

      const edited: NarrationScript = {
        ...script,
        steps: script.steps.map((step, i) =>
          i === 1 ? { ...step, text: `${step.text} And one more thought about it.` } : step,
        ),
      };
      const provider = new FakeTtsProvider();
      const outcome = await runTts({
        script: edited,
        provider,
        config,
        cache: new FileTtsCache(cacheDir),
        runDir: tempDir(),
      });

      expect(provider.requests).toHaveLength(1);
      expect(outcome.cached).toBe(script.steps.length - 1);
      expect(outcome.manifest.clips[1]?.cached).toBe(false);
      expect(outcome.manifest.clips[0]?.cached).toBe(true);
    });

    it("misses when the voice or the speed changes", async () => {
      const cacheDir = tempDir();
      const script = goldenScript();

      await runTts({
        script,
        provider: new FakeTtsProvider(),
        config: defaultConfig(),
        cache: new FileTtsCache(cacheDir),
        runDir: tempDir(),
      });

      for (const overrides of [{ voice: "am_michael" }, { speed: 1.5 }]) {
        const provider = new FakeTtsProvider();
        await runTts({
          script,
          provider,
          config: configWithTts(overrides),
          cache: new FileTtsCache(cacheDir),
          runDir: tempDir(),
        });
        expect(provider.requests).toHaveLength(script.steps.length);
      }
    });

    it("never hits when caching is off", async () => {
      const script = goldenScript();
      const provider = new FakeTtsProvider();
      await runTts({
        script,
        provider,
        config: defaultConfig(),
        cache: new NullTtsCache(),
        runDir: tempDir(),
      });
      const outcome = await runTts({
        script,
        provider,
        config: defaultConfig(),
        cache: new NullTtsCache(),
        runDir: tempDir(),
      });
      expect(outcome.cached).toBe(0);
    });
  });

  describe("the sanity check", () => {
    it("refuses a clip that is far too short for its words", async () => {
      // A server answering with an empty body or a truncated clip produces bytes that parse.
      const runDir = tempDir();
      const error = await runTts({
        script: goldenScript(),
        provider: new ScriptedProvider(() => silentWav(5)),
        config: defaultConfig(),
        runDir,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StageError);
      expect((error as StageError).stage).toBe("tts");
      expect((error as StageError).message).toMatch(/Step S00 synthesized to 5 ms/);
      expect((error as StageError).message).toMatch(/error page, an empty body or a truncated/);
    });

    it("refuses a clip that is far too long for its words", async () => {
      await expect(
        runTts({
          script: goldenScript(),
          provider: new ScriptedProvider(() => silentWav(15 * 60 * 1000)),
          config: defaultConfig(),
          runDir: tempDir(),
        }),
      ).rejects.toThrow(/should take about/);
    });

    it("does not fire on a normal clip, at any allowed speed", async () => {
      for (const speed of [0.5, 1, 1.5, 2]) {
        await expect(
          runTts({
            script: goldenScript(),
            provider: new FakeTtsProvider(),
            config: configWithTts({ speed }),
            runDir: tempDir(),
          }),
        ).resolves.toBeDefined();
      }
    });
  });

  it("refuses a run whose clips are not all one format", async () => {
    // The Composer concatenates these with `-c copy`, which needs one format throughout.
    let call = 0;
    const provider = new ScriptedProvider((r) => plausibleWav(r, call++ === 0 ? 24_000 : 16_000));
    await expect(
      runTts({ script: goldenScript(), provider, config: defaultConfig(), runDir: tempDir() }),
    ).rejects.toThrow(/different sample rates \(16000, 24000\)/);
  });

  it("leaves the clips it finished behind when a later one fails", async () => {
    // Failure is resumable by construction: a re-run replays these from the cache for free.
    const runDir = tempDir();
    const cacheDir = tempDir();
    let call = 0;
    const provider = new ScriptedProvider((request) => {
      call += 1;
      if (call === 3) throw new StageError("tts", "the container went away");
      return plausibleWav(request);
    });

    await expect(
      runTts({
        script: goldenScript(),
        provider,
        config: defaultConfig(),
        cache: new FileTtsCache(cacheDir),
        runDir,
      }),
    ).rejects.toThrow(/the container went away/);

    expect(readdirSync(path.join(runDir, "audio")).sort()).toEqual(["S00.wav", "S01.wav"]);

    const resumed = new ScriptedProvider(plausibleWav);
    const outcome = await runTts({
      script: goldenScript(),
      provider: resumed,
      config: defaultConfig(),
      cache: new FileTtsCache(cacheDir),
      runDir,
    });
    // The two clips that were made are replayed; work starts at the one that failed.
    expect(outcome.cached).toBe(2);
  });

  it("reports a manifest that does not match its script as a contract failure", async () => {
    const script = goldenScript();
    const runDir = tempDir();
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir,
    });

    const shuffled = { ...manifest, clips: [...manifest.clips].reverse() };
    expect(checkAudioManifest(shuffled, script)).not.toEqual([]);
  });

  it("is idempotent: the same script and config give the same manifest", async () => {
    const script = goldenScript();
    const config = defaultConfig();
    const a = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config,
      runDir: tempDir(),
    });
    const b = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config,
      runDir: tempDir(),
    });
    // `cached` is the only field that may differ, and neither run had a cache.
    expect(b.manifest).toEqual(a.manifest);
  });
});

describe("every golden script", () => {
  it.each(GOLDEN_SAMPLES)("%s speaks into a valid manifest", async (sample) => {
    const script = loadGolden(sample).script;
    const runDir = tempDir();
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir,
    });
    expect(() => {
      assertContract("audio-manifest", manifest);
    }).not.toThrow();
    expect(checkAudioManifest(manifest, script)).toEqual([]);
  });
});

describe("summarizeTts", () => {
  it("reads as a video length, with the cache noted only when it helped", async () => {
    const script = goldenScript();
    const cacheDir = tempDir();
    const first = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      cache: new FileTtsCache(cacheDir),
      runDir: tempDir(),
    });
    expect(summarizeTts(first)).toMatch(/^audio: \d+ clips, \d+:\d{2} of speech$/);

    const second = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      cache: new FileTtsCache(cacheDir),
      runDir: tempDir(),
    });
    expect(summarizeTts(second)).toMatch(/\(\d+ cached\)$/);
  });
});

describe("writeManifest", () => {
  it("writes audio/manifest.json where the contract says it lives", async () => {
    const runDir = tempDir();
    const { manifest } = await runTts({
      script: goldenScript(),
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir,
    });
    writeManifest(runDir, manifest);

    const onDisk: unknown = JSON.parse(readFileSync(path.join(runDir, MANIFEST_FILE), "utf8"));
    expect(onDisk).toEqual(manifest);
    expect(() => {
      assertContract("audio-manifest", onDisk);
    }).not.toThrow();
  });
});

describe("readScript", () => {
  it("rejects a script.json that does not match its contract", async () => {
    const { readScript } = await import("../../src/agents/narrator.js");
    const runDir = tempDir();
    writeFileSync(path.join(runDir, "script.json"), JSON.stringify({ steps: [] }), "utf8");
    expect(() => readScript(runDir)).toThrow(ContractError);
  });

  it("says which file it could not read when there is no script yet", async () => {
    const { readScript } = await import("../../src/agents/narrator.js");
    expect(() => readScript(tempDir())).toThrow(/Cannot read .*script\.json/);
  });
});
