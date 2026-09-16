import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deepMerge, loadConfig, readSecrets } from "../src/config.js";
import { StageError } from "../src/lib/errors.js";

describe("loadConfig", () => {
  it("loads valid defaults with an empty environment", () => {
    const config = loadConfig({ env: {} });
    expect(config.llm.provider).toBe("ollama");
    expect(config.review.maxFindings).toBe(10);
    expect(config.narration.maxWordsPerStep).toBe(60);
    expect(config.tts.baseUrl).toBe("http://localhost:8880");
  });

  it("applies SPR_* overrides with types", () => {
    const config = loadConfig({
      env: {
        SPR_LLM_MODEL: "some-model",
        SPR_TTS_SPEED: "1.1",
        SPR_KOKORO_URL: "http://kokoro:8880",
      },
    });
    expect(config.llm.model).toBe("some-model");
    expect(config.tts.speed).toBe(1.1);
    expect(config.tts.baseUrl).toBe("http://kokoro:8880");
  });

  it("ignores empty environment values", () => {
    expect(loadConfig({ env: { SPR_LLM_MODEL: "  " } }).llm.model).not.toBe("");
  });

  it("rejects a non-numeric number override", () => {
    expect(() => loadConfig({ env: { SPR_TTS_SPEED: "fast" } })).toThrow(
      /SPR_TTS_SPEED must be a number/,
    );
  });

  it("rejects values outside the schema", () => {
    expect(() => loadConfig({ env: { SPR_LLM_PROVIDER: "openai" } })).toThrow(StageError);
    expect(() => loadConfig({ env: { SPR_TTS_SPEED: "3" } })).toThrow(/tts\/speed/);
  });

  it("merges an extra config file over the defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "spr-config-"));
    const file = path.join(dir, "local.json");
    writeFileSync(
      file,
      JSON.stringify({ video: { gapMs: 250 }, ingest: { ignoreGlobs: ["**/*.gen.ts"] } }),
    );
    const config = loadConfig({ env: {}, configFile: file });
    expect(config.video.gapMs).toBe(250);
    expect(config.video.width).toBe(1280);
    expect(config.ingest.ignoreGlobs).toEqual(["**/*.gen.ts"]);
  });

  it("reports unknown keys in a config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "spr-config-"));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ llm: { modle: "typo" } }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(/additional properties/);
  });

  it("reports a missing config file", () => {
    expect(() => loadConfig({ env: { SPR_CONFIG: "/nope/missing.json" } })).toThrow(/not found/);
  });
});

describe("deepMerge", () => {
  it("merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
      e: 2,
    });
  });
});

describe("readSecrets", () => {
  it("reads keys and treats blanks as missing", () => {
    expect(readSecrets({ ANTHROPIC_API_KEY: "sk-test", GITHUB_TOKEN: " " })).toEqual({
      anthropicApiKey: "sk-test",
    });
    expect(readSecrets({ GH_TOKEN: "ghs_x" })).toEqual({ githubToken: "ghs_x" });
  });
});
