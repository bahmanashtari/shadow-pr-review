# Cheat sheet: Kokoro TTS in Docker

> Snapshot written September 2026. Image names, tags, ports, endpoints and voice names
> change. Verify against the Kokoro-FastAPI README (github.com/remsky/Kokoro-FastAPI)
> and pin a specific tag instead of `latest`.

## Run locally (CPU)

```yaml
# docker/compose.yml
services:
  kokoro:
    image: ghcr.io/remsky/kokoro-fastapi-cpu:latest   # pin a version tag
    ports:
      - "8880:8880"
    restart: unless-stopped
```

```bash
docker compose -f docker/compose.yml up -d kokoro
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

List voices (check the README if this path differs): `GET /v1/audio/voices`.

## Voices

American English voices use the `a` prefix: `af_*` female, `am_*` male
(for example `af_heart`, `af_bella`, `am_michael`). British English uses `b`
(`bf_*`, `bm_*`). Pick one by listening; store it in config.

## Tips

- Output is 24 kHz mono. Keep every clip in the same format so ffmpeg can concat with `-c copy`.
- Wait for readiness before the first request (health endpoint per README, commonly `/health`).
  The first request after startup is slower (model warm-up).
- Normalize text before sending (see NARRATION_STYLE.md): acronyms, slashes, backticks.
- Cache by sha256(provider, voice, speed, normalized text).
- Measure duration from the file, not from text length:
  `ffprobe -v error -show_entries format=duration -of csv=p=0 S00.wav`

## Alternatives

- `kokoro-js` (Kokoro in Node via ONNX/transformers.js) if you ever want it in-process;
  the HTTP container is the default because it matches local Docker and CI.
- Piper (very fast, lighter quality) as a fallback, called through its CLI with `execa`
  or through an HTTP wrapper container.
- Any OpenAI-compatible TTS can reuse the same client (cost flag for paid ones).
