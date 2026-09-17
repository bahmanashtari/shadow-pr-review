# Plan: Milestone 2, step 5 (the Composer)

Status: done. Implemented in "Milestone 2 step 5: the Composer" (ADR-033). (All four questions as recommended; ffmpeg comes from Homebrew locally and
apt on CI, after the alternatives below were measured). Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md (section "2. Stages",
subsection 8), `docs/cheatsheets/ffmpeg.md`, `schemas/timeline.schema.json`,
`schemas/record.schema.json` and docs/DECISIONS.md (ADR-027, ADR-031, ADR-032) first.

This is where the two halves meet. Step 1 produced measured audio, step 4 produced a silent
video, and this step puts them together into `final.mp4` - the thing the whole pipeline exists
to make.

It is also the first step needing a dependency that is on **neither** this machine nor the CI
runner. ADR-027 deferred `ffmpeg` to exactly here, and the bill comes due.

## 1. What it does

Input: `video.webm`, `record.json`, `audio/manifest.json`, `timeline.json` and `script.json`.
Output: `final.mp4`, and `subtitles.srt` when subtitles are on.

Four things, in order:

1. **Build one audio track** - the clips in timeline order, with generated silence for the gaps
   between them.
2. **Trim `t0`** off the front of the video, so the loading frames the Recorder captured before
   the timeline started are gone (ADR-032).
3. **Merge and encode** - H.264 video, AAC audio, `+faststart` so the file streams.
4. **Check** that the result's video and audio durations agree within 250 ms, and fail if not.

Subtitles come from `step_windows` for timing and `script.json` for words, either as a sidecar
file or burned in, per `video.subtitles`.

## 2. Files

```
src/composer/srt.ts       # pure: step windows + script -> SRT cues
src/composer/audio.ts     # the gapped audio track
src/composer/compose.ts   # the stage: trim, merge, encode, check
```

`srt.ts` is pure and is the part CLAUDE.md names ("Pure functions for the Director and SRT
generation; unit test them without I/O"). Cue splitting - two lines, about 42 characters each,
time distributed by character count - is fiddly arithmetic over text and deserves tests that do
not shell out to anything.

## 3. What ffmpeg is needed for, and what cannot substitute

**Playwright's bundled ffmpeg cannot do this job.** It is tempting, since step 4 already put one
on disk. It has exactly two encoders - PNG and libvpx VP8 - because it exists to turn a
screencast into a WebM and nothing else. No H.264, no AAC, no libass. Measured, not assumed.

The CI runner has MediaInfo but no ffmpeg either. So both machines need a real one:

```bash
brew install ffmpeg              # this machine: 9.0.1 plus 14 dependencies
sudo apt-get install -y ffmpeg   # the CI runner
```

**Two alternatives were measured and rejected**, because "do not install it on my machine" is a
reasonable thing to want and deserved a real answer rather than a reflex.

*A pinned Docker image* (`jrottenberg/ffmpeg:7.1-alpine`, 41 MB compressed) works, and more
neatly than expected: everything this stage touches lives in one run folder, so mounting it as
the working directory and passing relative paths needs no translation layer at all. It was
rejected for what it does to the shape of the project rather than for difficulty. Docker is
optional today - `SPR_TTS_PROVIDER=fake` runs the whole pipeline without a daemon - and this
would make it mandatory for composing. It also adds a third containerisation pattern: ARCHITECTURE
has "tool on the host, Kokoro in a container", and Milestone 4 step 3 containerises the whole
tool; per-binary shell-outs from the host are neither.

*The npm static binaries* looked best of all until inspected. `ffmpeg-static` has everything
needed - 6.0 with libx264, aac and the subtitles filter - but its tarball is 48 KB with an
`install: node install.js` script, so the 43 MB binary is fetched on postinstall, on every
install including CI's. And its companion `ffprobe-static` ships **ffprobe 4.4** against that
ffmpeg 6.0. Encoding with one version and verifying with another two majors older is the exact
mismatch the duration check exists to catch, not to be built on.

Homebrew wins on the thing this stage actually cares about: the encoder and the prober are the
same build. It is also reversible - `brew uninstall ffmpeg && brew autoremove` - which is worth
saying, because the first version of this plan implied it was permanent.

## 4. Decisions to take

**Q1. How does CI get ffmpeg? Recommendation: `apt-get install -y ffmpeg`, and measure it.**

The alternatives are a third-party setup action (faster, but a supply-chain dependency to pin
and trust for a binary this central) or the Docker image Milestone 4 step 3 will build anyway
(right eventually, wrong now - it would mean building that image before the pipeline it is
meant to contain is finished).

`apt-get` is the boring option and the runner has apt warmed. **The honest part of this
recommendation is that I do not know what it costs**, and step 4 is the reason to say so
out loud rather than estimate: there I predicted "one to three minutes" for the browser and it
was four seconds. The same guess here would be worth as little. The plan is to install it, read
the real number off the first CI run, and record it in the ADR the way ADR-031 records its own.

If it turns out to be minutes rather than seconds, the fallback is the same one step 4 had:
skip the ffmpeg-backed tests on CI and let Milestone 2 step 6's end-to-end run carry them.

**Q2. How is the gapped audio track built? Recommendation: the concat demuxer with a generated
silence file.**

Two ways. The cheat sheet's: generate one silence WAV per distinct gap length, write a
`list.txt`, and `ffmpeg -f concat -c copy` it into `audio/full.wav`. Or a single
`filter_complex` graph with `anullsrc` inputs and no temporary files.

The filter graph is one command and leaves less behind. The concat demuxer wins anyway because
of what it leaves behind: `audio/full.wav` is a real file a person can play when the timing
looks wrong, and `list.txt` says in plain text exactly what was concatenated in what order.
This stage's failure mode is "the audio does not line up with the video", and that is much
easier to diagnose against an artifact than against a filter expression. `-c copy` also means
the intermediate is lossless, and every clip already shares one format because the TTS stage
refuses a run whose clips do not (ADR-027).

**Q3. Loudness normalization now? Recommendation: no.**

The cheat sheet offers `loudnorm=I=-16:TP=-1.5:LRA=11`. It is one filter and a second encode
pass, and there is no evidence yet that Kokoro's output needs it - the clips sounded fine when
they were listened to at step 1. Adding it now means committing to a target loudness nobody has
measured against. Leave it out, note it in the cheat sheet, and revisit if a real video sounds
wrong.

**Q4. Does this stage get a contract file? Recommendation: no.**

Step 4 added `record.json` because the Composer genuinely could not work without a number that
did not fit in a `.webm` (ADR-032). Nothing downstream has that problem here: Publish
(Milestone 4) needs the path to `final.mp4`, which it can construct, and anything else it wants
it can read off the file. A `compose.json` would be a contract with no reader, which is how
schemas start being written for their own sake.

## 5. The check that matters

`abs(video_duration - audio_duration) < 250 ms`, read off the finished file with `ffprobe`,
failing the stage otherwise.

This is the first check in the pipeline that can actually catch the accumulated error of every
stage before it: a mismeasured clip in step 1, an arithmetic slip in step 2, a scheduler that
drifted in step 4 all end up here as a mismatch. Step 4 could not perform it - `ffprobe` was not
available and the recorder can only report the wall clock it observed. Its own numbers were
reassuring (56638 ms recorded against a 56637 ms timeline) but they are self-reported; this is
the independent one.

The failure message should say which side is longer and by how much, because those two facts
point at different stages.

## 6. Tests

`test/composer/srt.test.ts` - pure, no ffmpeg:

- timestamps are `HH:MM:SS,mmm`, with a comma rather than a point, and cues are numbered from 1.
- a step short enough for one cue produces one; a long one splits into cues of at most two lines
  and about 42 characters per line.
- split cues divide their step's window proportionally to character count, and the last cue ends
  exactly at the step window's end rather than a rounded-off approximation.
- a cue's text never breaks mid-word.
- `subtitle` on a step is used in preference to `text` when present, since the schema has it for
  exactly that.
- every golden script plus a fake-provider manifest produces a well-formed SRT.

`test/composer/compose.test.ts` - needs ffmpeg, and skips itself loudly when it is missing, the
way the recorder's test skips without a browser:

- a short run composes an `final.mp4` that exists and is not trivially small.
- `ffprobe` reports both a video and an audio stream, and H.264 plus AAC.
- the duration check passes on a good run, and its failure message names the longer side.
- `--subtitles sidecar` writes `subtitles.srt` and leaves the video alone; `burn` produces no
  sidecar; `off` produces neither.

## 7. Failure

`ffmpeg` missing is the likely one, and it gets the treatment the Kokoro client and the browser
launcher already have: a message naming the exact command that fixes it, per platform, rather
than a spawn error.

Everything else this stage does is a subprocess, so `src/lib/exec.ts` already carries the
important part - a timeout, and the last twenty lines of stderr quoted into the error. ffmpeg's
diagnostics are genuinely good when you can see them, and invisible when you cannot.

## 8. Documentation

- `docs/ROADMAP.md`: step 5 done, step 6 next.
- `CLAUDE.md`: `ffmpeg` in the prerequisites with its install commands, the `compose` commands,
  `final.mp4` and `subtitles.srt` in the run-folder listing.
- `docs/ARCHITECTURE.md` section 8: whichever way Q2 goes, and the duration check's message.
- `.github/workflows/ci.yml`: the ffmpeg install.
- `docs/cheatsheets/ffmpeg.md`: correct it against the installed version, record that
  Playwright's bundled ffmpeg has only PNG and VP8 encoders so nobody tries it again, and note
  loudness normalization as deliberately deferred.
- `docs/DECISIONS.md`: an ADR for the CI cost with its measured number, and for anything the
  first real compose turns up - this is the step where the pipeline's accumulated timing error
  becomes visible for the first time, so it may well turn something up.

## 9. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Compose `sample-01` end to end and **watch it with the sound on**. This is the first time the
   narration and the picture exist together, and it is the whole point of the project. Steps 1
   and 3 both proved that looking and listening find what assertions cannot.
3. Push, and read the real CI duration off the run rather than assuming it.
4. Report. Do not start step 6.
