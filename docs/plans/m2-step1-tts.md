# Plan: Milestone 2, step 1 (TTS and `audio/manifest.json`)

Status: approved (both open questions decided as recommended: duration is read from the WAV
header, and the pronunciation map lives in code). Read CLAUDE.md, docs/ROADMAP.md,
docs/ARCHITECTURE.md (section "2. Stages", subsection 5), docs/NARRATION_STYLE.md,
`docs/cheatsheets/kokoro-docker.md` and docs/DECISIONS.md (ADR-017, ADR-024, ADR-026) first.

This step turns `script.json` into spoken audio and, more importantly, into **measured
durations**. It is the hinge of CLAUDE.md principle 1: script first, render second, with video
timing derived from real audio rather than estimated from text. Everything after it - the
Director, the Recorder, the Composer - consumes `audio/manifest.json`, and every number in it
must come from a file on disk.

## 1. What it does

Input: `script.json`. Output: `audio/S00.wav ... audio/SNN.wav` and `audio/manifest.json`.

For each step, in order: normalize the spoken text, compute a cache key over
(provider, voice, speed, normalized text), and either copy the cached clip or synthesize it.
Write the clip, measure its real duration, and record it. `checkAudioManifest` already exists
and requires the clips to match the script's steps one-for-one and in order, so the stage
asserts it before writing.

`estimated_seconds` in `script.json` is never consulted. It is the word-count guess the schema
calls informational; this stage exists to replace it with a measurement.

## 2. Files

```
src/providers/tts/types.ts        # TtsProvider: synthesize(text, voice, speed) -> WAV bytes
src/providers/tts/kokoro-http.ts  # the default: Kokoro-FastAPI, OpenAI-compatible endpoint
src/providers/tts/fake.ts         # real WAV bytes, no network
src/providers/tts/create.ts       # picks the provider from config, mirroring providers/llm/create.ts
src/tts/normalize.ts              # pure: spoken text -> what the engine should receive
src/tts/duration.ts               # pure: WAV bytes -> milliseconds
src/tts/speak.ts                  # the stage: script.json -> audio/ + manifest.json
docker/compose.yml                # Kokoro-FastAPI, pinned
```

`src/tts/` for the stage and `src/providers/tts/` for the providers, the same split ADR-023 made
for `src/verify/` and step 7 made for `src/eval/`: the stage is the pipeline's, the provider is
an interchangeable backend.

## 3. The provider

`TtsProvider` mirrors `LlmProvider`: a `name`, and one method that takes text and returns bytes.
Kokoro is reached over its OpenAI-compatible `POST /v1/audio/speech` with
`{ model: "kokoro", input, voice, speed, response_format: "wav" }`, which the cheat sheet
records and which `config/default.json` is already set up for (`tts.baseUrl`,
`tts.voice: "af_heart"`, `tts.speed: 1.0`, and `SPR_KOKORO_URL` / `SPR_TTS_VOICE` /
`SPR_TTS_SPEED` in `src/config.ts`). No contract or config change is needed.

**The fake provider returns real WAV bytes**, not a stub: a silent clip whose length follows the
word count. That is what lets `SPR_TTS_PROVIDER=fake` walk the whole pipeline offline with
plausible timings, which the Director (step 2) and the Recorder (step 4) both need before anyone
installs Docker. The same reasoning as the fake LLM provider, which had to learn the Narrator's
answer shape for exactly this reason.

**Readiness.** The first request after container start is slow (model warm-up), so the client
waits for the health endpoint before the first synthesis and reports a clear message when the
container is not up - the shape `src/providers/llm/ollama.ts` already uses for "is ollama serve
running?".

**Version.** `ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0` (released 2026-09-10, the current
release at the time of writing). The cheat sheet warns that image names, tags, ports and
endpoints move; the tag is pinned rather than `latest` for that reason, and the first real pull
must confirm the image tag matches the release tag.

## 4. Normalization

Pure, and tested on its own, because it decides what is spoken and it feeds the cache key.
`docs/NARRATION_STYLE.md` already names the cases: `NestJS -> Nest J S`, `PostgreSQL ->
Postgres`, `DTO -> D T O`, `CQRS -> C Q R S`, strip backticks, expand `/`.

Two properties matter beyond the mapping itself:

- **It runs before the cache key.** The manifest defines `cache_key` as a hash of the normalized
  text, so two scripts that differ only in something normalization erases share a clip.
- **It is the last thing that touches the text.** `checkScript` has already guaranteed no
  markdown, no file names and no URLs reach here (ADR-024), so normalization handles
  pronunciation, not sanitisation, and does not need to defend against the cases the Narrator
  cannot produce.

## 5. Measuring duration

Every duration comes from the written file. The manifest's own description says "measured from
the written files (ffprobe or the WAV header), never estimated" - which of the two is section 7.

A **sanity check** either way: a clip whose duration is wildly out of step with its word count
(say, under a fifth or over five times `words / 2.5`) fails the stage naming the step. This is
not defensive padding. A TTS server that returns an error page, an empty body or a truncated
clip produces bytes that parse and a video that is silently broken, and this stage is the last
place a person sees numbers before they become a rendered video.

## 6. The stage, the cache and failure

`TtsCache` mirrors `LlmCache` (ADR-017): `get`/`set` over bytes, stored under
`cache.dir/tts/<key>.wav`, shared across runs. Re-narrating a script that changed one step
re-synthesizes one clip. `writeOnly` from step 7 applies here too if a cold measurement is ever
wanted.

**Failure is resumable by construction.** Clips are written as they are produced, so a stage that
dies on step 7 of 9 leaves six clips on disk and, because the cache is keyed on content, re-running
`spr stage tts` replays them for free and starts work at the one that failed. No handover file is
needed - unlike the Narrator, where the failure was a judgement the model could not make, here it
is a server that was not there.

## 7. Decisions taken

**Duration is read from the WAV header.** Kokoro is asked for WAV and returns 24 kHz mono, so
the header carries an exact sample count: the measurement is exact, costs no subprocess per
clip, and this stage needs no external binary at all. That keeps `ffmpeg` a Milestone 2 step 5
dependency rather than a step 1 one, so CI can run the whole TTS stage without installing
anything - which matters, because neither `ffmpeg` nor `ffprobe` is installed on the machine
this is being built on. About twenty lines, with a fallback to the data-chunk size when a
streaming writer leaves the header's length unset, and a clear error for bytes that are not
WAV at all. `docs/ARCHITECTURE.md` says `ffprobe` today and must be corrected; the manifest
schema already allowed either.

The cost is honest: a non-WAV provider would still need `ffprobe`, and the project will have
two ways of measuring audio once the Composer lands. The Composer needs `ffmpeg` regardless, so
that path is coming anyway; this only avoids pulling it forward by four steps.

**The pronunciation map lives in code**, in `src/tts/normalize.ts`. It is small, unit-tested and
versioned with the code that applies it, and `docs/NARRATION_STYLE.md` already fixes the cases
it must handle. Milestone 4 will almost certainly want it configurable, when the tool meets
service names and internal acronyms no built-in map could predict - the place it would go is
`tts.pronunciations` in the config schema, through the `--file` / `SPR_CONFIG` mechanism that
already exists. Knowing where it goes is not a reason to build it now.

## 8. Tests

`test/tts/normalize.test.ts`, `test/tts/duration.test.ts`, `test/tts/speak.test.ts`,
`test/providers/tts.test.ts`. No network: the Kokoro client is tested with an injected `fetch`,
exactly as `OllamaProvider` is.

- normalization: each documented mapping fires; text with none is unchanged; the result is
  stable, because the cache key depends on it.
- duration: a known WAV round-trips to its exact length; a header with an unset data size falls
  back to the file size; bytes that are not WAV are rejected with a clear message.
- the sanity check fires on an empty clip and does not fire on a normal one.
- the stage: clips are written in step order, the manifest passes `checkAudioManifest` and its
  schema, a second run is a cache hit for every clip and byte-identical, and changing one step's
  text re-synthesizes only that clip.
- the Kokoro client: builds the documented request body; a non-2xx reports the status and the
  server's text; an unreachable server says so the way the Ollama provider does.
- CLI: `spr run --until tts` with `SPR_TTS_PROVIDER=fake` writes `audio/` and the manifest;
  `spr stage tts --run runs/<id>` re-runs from `script.json`.

## 9. Documentation

- `docs/ROADMAP.md`: step 1 done, step 2 next.
- `CLAUDE.md`: the `tts` commands, `src/tts/` in the layout, and Docker in the prerequisites.
- `docs/ARCHITECTURE.md` section 5: whichever way Q1 goes.
- `docs/cheatsheets/kokoro-docker.md`: correct anything the first real pull contradicts.
- `docs/DECISIONS.md`: ADR-027 for the duration source, the fake provider returning real audio,
  and the sanity check.

## 10. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. With Docker running: `docker compose -f docker/compose.yml up -d kokoro`, then
   `spr run --diff golden/sample-01-order-outbox/diff.patch --until tts`, and **listen to it**.
3. **The narration-length question the roadmap defers to this step.** Compare the measured
   totals with the 1-to-5-minute target in `docs/NARRATION_STYLE.md`. Every model produced
   scripts around 60% of the hand-written fixtures' estimate (ADR-026), but that estimate is a
   word-count proxy; this is the first real number. Decide then whether the Narrator prompt
   needs a length target rather than only a cap, and record it.
4. Commit, push, check CI.
5. Report. Do not start step 2.
