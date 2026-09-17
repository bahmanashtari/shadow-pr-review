import { describe, expect, it } from "vitest";
import { readWavInfo } from "../../src/tts/duration.js";
import { silentWav } from "../../src/providers/tts/fake.js";
import { StageError } from "../../src/lib/errors.js";

/** Rewrites the `data` chunk's declared size, which is at a fixed offset in `silentWav`. */
function withDataSize(wav: Uint8Array, size: number): Uint8Array {
  const copy = new Uint8Array(wav);
  new DataView(copy.buffer).setUint32(40, size, true);
  return copy;
}

/** Splices an extra chunk in between `fmt ` and `data`, the way ffmpeg writes `LIST`/`INFO`. */
function withExtraChunk(wav: Uint8Array, id: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + body.byteLength);
  const view = new DataView(chunk.buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, id.charCodeAt(i));
  view.setUint32(4, body.byteLength, true);
  chunk.set(body, 8);

  // `silentWav` puts `fmt ` at 12..35 and `data` from 36; the extra chunk goes between.
  return new Uint8Array([...wav.subarray(0, 36), ...chunk, ...wav.subarray(36)]);
}

describe("readWavInfo", () => {
  it.each([250, 1000, 5325, 60_000])("round-trips a %i ms clip exactly", (ms) => {
    const info = readWavInfo(silentWav(ms));
    expect(info.durationMs).toBe(ms);
    expect(info.sampleRate).toBe(24_000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.sizeFromBytes).toBe(false);
  });

  it("reads a non-default sample rate off the header rather than assuming one", () => {
    const info = readWavInfo(silentWav(1000, 16_000));
    expect(info.sampleRate).toBe(16_000);
    expect(info.durationMs).toBe(1000);
  });

  it.each([
    ["unset by a streaming writer", 0xff_ff_ff_ff],
    ["left at zero", 0],
    ["longer than the file", 999_999],
  ])("falls back to the bytes present when the data size is %s", (_why, declared) => {
    // This is how Kokoro actually answers: it streams through ffmpeg's muxer, which writes
    // the header before it knows the length and leaves this field at 0xFFFFFFFF.
    const info = readWavInfo(withDataSize(silentWav(2000), declared));
    expect(info.durationMs).toBe(2000);
    expect(info.sizeFromBytes).toBe(true);
  });

  it("steps over chunks between fmt and data, as a real Kokoro clip carries", () => {
    const list = new Uint8Array(26).fill(0x20);
    const info = readWavInfo(withExtraChunk(silentWav(1500), "LIST", list));
    expect(info.durationMs).toBe(1500);
  });

  it.each([
    ["an HTML error page", new TextEncoder().encode("<html><body>502 Bad Gateway</body></html>")],
    ["an empty body", new Uint8Array(0)],
    ["a truncated header", silentWav(1000).subarray(0, 8)],
  ])("rejects %s with a clear message", (_what, bytes) => {
    expect(() => readWavInfo(bytes)).toThrow(StageError);
    expect(() => readWavInfo(bytes)).toThrow(/Not a readable WAV clip/);
  });

  it("rejects a WAV with a header but no audio data", () => {
    // 44 header bytes with the `data` chunk removed: RIFF/WAVE and fmt survive.
    const header = silentWav(100).subarray(0, 36);
    expect(() => readWavInfo(header)).toThrow(/no data chunk/);
  });
});
