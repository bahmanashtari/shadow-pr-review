/**
 * A speech engine with no engine behind it: silence of the right length.
 *
 * It returns **real WAV bytes**, not a stub, and that is the point. `SPR_TTS_PROVIDER=fake`
 * has to walk the whole pipeline offline with plausible timings, because the Director
 * (Milestone 2 step 2) and the Recorder (step 4) both consume `audio/manifest.json` and both
 * need to be buildable and testable before anyone installs Docker. The fake LLM provider
 * exists for the same reason and had to learn the Narrator's answer shape to do it.
 *
 * Length follows the word count at the rate `script.schema.json` estimates with, so a fake
 * run produces a timeline of roughly the right shape - and passes the stage's own sanity
 * check, which compares measured audio against exactly that rate.
 */
import type { TtsProvider, TtsRequest } from "./types.js";

/** What Kokoro returns, so a fake run and a real one differ only in the audio itself. */
export const FAKE_SAMPLE_RATE = 24_000;

/** 16-bit mono PCM. */
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/** Spoken words per second, the rate `script.schema.json` estimates with. */
const WORDS_PER_SECOND = 2.5;

/** Even one word must produce an audible clip: `duration_ms` has a minimum of 1. */
const MIN_DURATION_MS = 200;

/** Sizes of the RIFF header this writes: `RIFF`+size+`WAVE`, then `fmt `, then `data`. */
const HEADER_BYTES = 44;

/**
 * Builds a silent PCM WAV of a given length. Exported because the tests that measure
 * durations need real files to measure, and inventing a second WAV writer for them would
 * test the wrong bytes.
 */
export function silentWav(durationMs: number, sampleRate = FAKE_SAMPLE_RATE): Uint8Array {
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const frames = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataBytes = frames * blockAlign;

  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  // The samples themselves stay zero: silence.
  return bytes;
}

/** Counts spoken words the same way `checkScript` does. */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** How long the fake says a piece of text takes: word count over the estimating rate. */
export function fakeDurationMs(text: string, speed: number): number {
  const seconds = countWords(text) / WORDS_PER_SECOND / (speed <= 0 ? 1 : speed);
  return Math.max(MIN_DURATION_MS, Math.round(seconds * 1000));
}

/** Silence of a plausible length, with no network and no container. */
export class FakeTtsProvider implements TtsProvider {
  readonly name = "fake" as const;
  /** Every request this provider received, in order, so tests can assert on them. */
  readonly requests: TtsRequest[] = [];

  synthesize(request: TtsRequest): Promise<Uint8Array> {
    this.requests.push(request);
    return Promise.resolve(silentWav(fakeDurationMs(request.text, request.speed)));
  }
}
