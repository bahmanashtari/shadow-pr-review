/**
 * Reading a clip's real length out of its WAV header (ADR-027).
 *
 * CLAUDE.md principle 1 says the video's timing is derived from measured audio, so every
 * number in `audio/manifest.json` has to come from a file on disk. Kokoro is asked for WAV
 * and answers with 24 kHz mono PCM, whose header carries an exact sample count - so the
 * measurement is exact, costs no subprocess per clip, and this stage needs no external
 * binary. `ffprobe` would give the same answer and arrives anyway with the Composer
 * (Milestone 2 step 5); there is just no reason to pull it forward by four steps.
 *
 * The one thing a real clip taught this file: Kokoro streams, so its header declares no
 * length at all. Counting the bytes present is the normal path, not a defensive one.
 */
import { StageError } from "../lib/errors.js";

/** What a WAV header says about the clip, plus the length derived from it. */
export interface WavInfo {
  /** Frames per second, for example 24000. */
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes of audio actually present. */
  dataBytes: number;
  /** Length of the clip, rounded to the nearest millisecond. */
  durationMs: number;
  /**
   * True when the `data` chunk's declared size was unusable and the bytes actually present
   * were counted instead.
   *
   * This is not the rare case. Kokoro streams its response through ffmpeg's muxer, which
   * emits the header before it knows how much audio follows and leaves both the RIFF size
   * and the data size at 0xFFFFFFFF - so counting the bytes is the path every real clip
   * takes, and the declared size is the fallback rather than the other way round.
   */
  sizeFromBytes: boolean;
}

/** `RIFF` + size + `WAVE`, before the first chunk header. */
const RIFF_HEADER_BYTES = 12;

/** The fields of a PCM `fmt ` chunk this needs. */
const MIN_FMT_BYTES = 16;

/** The `fmt ` chunk, as read off the file. */
interface WavFormat {
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

/** Reads `length` bytes as ASCII, which is how RIFF spells its chunk ids. */
function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

function reject(detail: string): never {
  throw new StageError("tts", `Not a readable WAV clip: ${detail}`);
}

/**
 * Measures a WAV clip.
 *
 * @param bytes the whole file, as the provider or the cache handed it over.
 * @throws StageError when the bytes are not WAV, or carry no format or audio data. That is
 * the case worth catching: a TTS server answering with an error page or an empty body
 * produces bytes that a laxer reader would happily call a zero-length clip.
 */
export function readWavInfo(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength < RIFF_HEADER_BYTES) reject(`only ${bytes.byteLength} bytes`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = ascii(view, 0, 4);
  const wave = ascii(view, 8, 4);
  if (riff !== "RIFF" || wave !== "WAVE") {
    reject(`expected a RIFF/WAVE header, found "${riff}"/"${wave}"`);
  }

  let format: WavFormat | undefined;
  let data: { offset: number; declared: number } | undefined;

  // Walk the chunk list. A well-formed file puts `fmt ` before `data`, and `data` last,
  // but anything may sit between them (`LIST`, `fact`, a writer's own metadata).
  let offset = RIFF_HEADER_BYTES;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt " && size >= MIN_FMT_BYTES) {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // Stop here rather than trusting `size` to step over the audio: this is exactly the
      // field a streaming writer leaves unset, and following it would walk off the file.
      data = { offset: body, declared: size };
      break;
    }
    // Chunks are padded to an even length, and the pad byte is not counted in `size`.
    offset = body + size + (size % 2);
  }

  if (format === undefined) reject("no fmt chunk");
  if (data === undefined) reject("no data chunk");
  if (format.sampleRate === 0) reject("the fmt chunk gives a sample rate of 0");

  // `blockAlign` is one frame's bytes across every channel. Deriving it is the fallback for
  // a writer that left it at zero.
  const blockAlign =
    format.blockAlign > 0 ? format.blockAlign : (format.channels * format.bitsPerSample) / 8;
  if (blockAlign <= 0) reject("the fmt chunk gives no usable frame size");

  const present = bytes.byteLength - data.offset;
  const usable = data.declared > 0 && data.declared <= present;
  const dataBytes = usable ? data.declared : present;

  const frames = Math.floor(dataBytes / blockAlign);
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    dataBytes,
    durationMs: Math.round((frames / format.sampleRate) * 1000),
    sizeFromBytes: !usable,
  };
}
