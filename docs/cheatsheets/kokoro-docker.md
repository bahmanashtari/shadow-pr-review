# Cheat sheet: Kokoro TTS in Docker

> Snapshot written September 2026, corrected against a real `v0.9.0` pull the same month.
> Image names, tags, ports, endpoints and voice names change. Verify against the
> Kokoro-FastAPI README (github.com/remsky/Kokoro-FastAPI) and pin a specific tag instead of
> `latest`. What the tool actually runs is `docker/compose.yml`; this file is the notes behind it.

## Run locally (CPU)

```yaml
# docker/compose.yml (abridged - the file itself also carries a healthcheck)
services:
  kokoro:
    image: ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0   # confirmed current, September 2026
    ports:
      - "8880:8880"
    restart: unless-stopped
```

```bash
docker compose -f docker/compose.yml up -d kokoro
```

Tags are listable without pulling, which is the cheapest way to check the pin is still real:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:remsky/kokoro-fastapi-cpu:pull&service=ghcr.io" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -s -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/remsky/kokoro-fastapi-cpu/tags/list
```

A GPU image also exists (`kokoro-fastapi-gpu`) and needs the NVIDIA container toolkit.
CPU is fast enough for review narration (short clips).

## Synthesize (OpenAI-compatible endpoint)

```bash
curl -s http://localhost:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hi. This is a review of your change.","voice":"af_heart","response_format":"wav","speed":1.0}' \
  -o S00.wav
```

```ts
// src/providers/tts/kokoro-http.ts
export interface TtsRequest { text: string; voice: string; speed?: number }

/** Returns WAV bytes for `text` from a Kokoro-FastAPI server. */
export async function synthesize(
  { text, voice, speed = 1.0 }: TtsRequest,
  baseUrl = process.env.SPR_KOKORO_URL ?? "http://localhost:8880",
): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "kokoro", input: text, voice, response_format: "wav", speed }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Kokoro TTS failed: ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
```

List voices: `GET /v1/audio/voices`. In `v0.9.0` it answers `{"voices": [...]}` where each
entry is an **object**, not a string - `{"id": "af_heart", "name": "af_heart",
"target_quality": "A", "overall_grade": "A"}` - so anything reading it must take `.id`. 72
voices ship, and the configured default `af_heart` is one of the few the server itself grades A.

Readiness: `GET /health` answers `{"status":"healthy"}`.

## Voices

American English voices use the `a` prefix: `af_*` female, `am_*` male
(for example `af_heart`, `af_bella`, `am_michael`). British English uses `b`
(`bf_*`, `bm_*`). Pick one by listening; store it in config.

## Tips

- Output is 24 kHz mono. Keep every clip in the same format so ffmpeg can concat with `-c copy`.
- Wait for readiness before the first request: `GET /health`, confirmed in `v0.9.0`. The first
  request after startup is slower (model warm-up); the client in `src/providers/tts/kokoro-http.ts`
  polls health once and then reuses the result.
- Normalize text before sending (see NARRATION_STYLE.md): acronyms, slashes, backticks.
- Cache by sha256(provider, voice, speed, normalized text).
- Measure duration from the file, not from text length - but **not with ffprobe**. ADR-027
  reads the WAV header instead, so the TTS stage needs no external binary at all. The reason it
  is not a one-liner: Kokoro streams its response through ffmpeg's muxer, which writes the
  header before it knows the length, so both the RIFF size and the `data` chunk size come back
  as `0xFFFFFFFF` and the real length is the bytes actually present. There is also a
  `LIST`/`INFO` chunk between `fmt ` and `data` to step over. `src/tts/duration.ts` does all of
  this; `ffprobe -v error -show_entries format=duration -of csv=p=0 S00.wav` is still the way to
  check its answer by hand, once ffmpeg is installed at Milestone 2 step 5.
- Measured speech runs at about 2.35 words per second at `speed: 1.0`, against the 2.5 that
  `script.schema.json` estimates with (ADR-028).

## Alternatives

- `kokoro-js` (Kokoro in Node via ONNX/transformers.js) if you ever want it in-process;
  the HTTP container is the default because it matches local Docker and CI.
- Piper (very fast, lighter quality) as a fallback, called through its CLI with `execa`
  or through an HTTP wrapper container.
- Any OpenAI-compatible TTS can reuse the same client (cost flag for paid ones).
