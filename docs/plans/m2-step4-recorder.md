# Plan: Milestone 2, step 4 (the Recorder)

Status: done. Implemented in "Milestone 2 step 4: the Recorder" (ADR-031, ADR-032). (Q1: `record.json` with a schema; Q2: file checks plus page-state assertions
during the recording; Q3: install the headless shell on CI, no cache). Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md (section "2. Stages",
subsection 7), `docs/cheatsheets/playwright-recording.md`, `schemas/timeline.schema.json` and
docs/DECISIONS.md (ADR-005, ADR-027, ADR-030) first.

Step 3 built the page and step 2 built the schedule. This step is the thing that runs them
together: open the page in a real browser, execute the timeline against a monotonic clock, and
record what happens to `video.webm`.

It is the first step that puts a browser binary into CI, so section 5 is measurements rather
than opinions - every number below was taken before this plan was written.

## 1. What it does

Input: `timeline.json`, plus `diff.patch` to build the page from. Output: `video.webm` and the
one number the Composer needs from this stage, `t0`.

The loop is small, and the cheat sheet already has its shape: launch Chromium, create a context
with `recordVideo`, open the page, wait for `window.spr.ready`, then for each action sleep until
its `at_ms` **on a monotonic clock** and call `window.spr.run(action)`. Never chain fixed
sleeps, or the drift accumulates across a five-minute video.

## 2. What `t0` is, and why it exists

Recording starts when the browser context is created. The timeline's clock starts when the page
is drawn and tagged. Between them sits the page load - a megabyte of bundle, diff2html drawing,
rows being tagged - and those frames are in the video but are not part of it.

`t0` is the length of that head, and the Composer trims it before muxing the audio. Without it
every visual lands late against the narration: the voice says "this line here" and the highlight
arrives a beat later.

**Measured: 0.132 s** on the development machine (section 5). Small enough that it is tempting
to ignore, and it should not be ignored: it is a function of how fast the machine parses a 1 MB
page, so a loaded CI runner can make it an order of magnitude larger. Measuring it per run costs
one subtraction.

## 3. Files

```
src/recorder/schedule.ts    # pure: timeline -> when to fire what, and how long to wait
src/recorder/record.ts      # the stage: Playwright, recordVideo, t0, video.webm
```

The same split the other stages have, and here it earns more than symmetry. **Almost everything
worth testing in this step is in `schedule.ts`**: the waits, the ordering, the clamping, what
happens when an action is already late, when the tail ends. Those are arithmetic over a
timeline and need no browser at all. `record.ts` is then a thin driver whose own test needs a
real Chromium and can be a handful of assertions.

## 4. Decisions to take

**Q1. Where does `t0` go? Recommendation: a new `record.json`, with a schema.**

Stages communicate only through files in the run folder, and a number cannot live inside a
`.webm`. ARCHITECTURE's contract chain lists `video.webm` as what this stage hands over, which
was written before anyone noticed the video alone is not enough.

There is precedent both ways in this repository. `cost.json` and `trace.jsonl` are run-folder
files with no schema; every file one stage *reads from another* has one. This is the second
kind - the Composer cannot mux without it - so it gets `schemas/record.schema.json`, generated
types and a `spr validate` entry like every other contract. The alternative, smuggling it into
`timeline.json`, would have the Recorder rewriting the Director's output, which no stage does.

Shape:

```json
{
  "schema_version": "1.0",
  "video_path": "video.webm",
  "t0_ms": 132,
  "video": { "width": 1280, "height": 720 },
  "recorded_duration_ms": 57037
}
```

`video_path` and `video` are separate because they answer different questions - which file, and
what was actually recorded into it, which may differ from what the timeline asked for if a
browser clamps the viewport. `recorded_duration_ms` is the wall clock the Recorder observed,
and exists as a cross-check the Composer can hold against the timeline's `total_duration_ms`
before it trusts either.

**Q2. What does the recording test assert? Decided: the file's format, and the page's state
while it is being recorded. Not its duration.**

Checking a video's real duration needs `ffprobe`, which ADR-027 deliberately kept out of the
project until the Composer arrives at step 5 - and `ffmpeg` is not in `ubuntu-latest`'s
documented software list either, so pulling it forward would mean an `apt` install on CI rather
than a free one.

So the division of labour is: **we test the driving, Playwright tests its own encoding, and step
5 tests the duration.** The browser-backed test asserts that the file exists, begins with the
EBML magic bytes that make it a WebM, and is not trivially small - and, during the real
recording, that the page actually did what each action asked. After the highlight action for a
finding fires, `page.evaluate` counts the lit rows and compares it with the range in the
timeline.

That second half is the valuable one, because it catches the class of bug that is *ours*: a
timeline that fires the wrong action, a selector that stopped matching, an action that arrived
at the wrong moment. Whether the resulting WebM is well-encoded is Playwright's problem and is
covered by the magic-byte check.

It still means **this step cannot prove the video is correct** - only that one was produced and
driven correctly. Duration is checked at step 5, where `ffprobe` exists and where ARCHITECTURE
already requires `abs(video_duration - audio_duration) < 250 ms`, and step 6's end-to-end run
over the golden set is where it becomes visible.

**Q3. How does CI get a browser? Decided: install the headless shell, no cache** (section 5).

## 5. The CI measurements

Taken before writing this plan, on the real registry and a real install.

| Option | Cost |
|---|---|
| Install `chromium-headless-shell` on CI | 94 MiB download, ~20 s |
| Install the full `chromium` too | 567 MB on disk, same download step |
| Official `mcr.microsoft.com/playwright:v1.63.0-noble` | **912 MB** compressed pull, 7 layers |
| Skip browser tests on CI | 0 |

CI currently runs in **35 to 45 seconds**, so the shape of this decision is whether that stays
in the same order of magnitude.

Three findings, each of which changed the answer:

- **`--with-deps` is not needed.** `ubuntu-latest` already ships Google Chrome 152, Chromium
  152, Firefox 155 and Selenium, so the system libraries Playwright would `apt install` are
  present. That was most of the original overestimate of "1 to 3 minutes".
- **Caching would probably make it worse.** A full install is 567 MB on disk; saving and
  restoring that through `actions/cache` is plausibly slower than a 94 MiB download from
  Playwright's CDN. Not every repeated cost is worth caching.
- **Only the headless shell is needed.** With the full 369 MB Chromium moved aside, recording
  still worked from `chromium_headless_shell` (195 MB) plus Playwright's bundled ffmpeg
  (2.5 MB). `playwright install chromium-headless-shell` is the whole requirement.

So: one workflow step, no `--with-deps`, no cache, headless shell only.

**Measured afterwards: the whole job runs in 44 seconds**, against 35 to 45 before. The install
step takes 4 seconds on the runner (not the 20 measured locally - a datacentre fetches 94 MiB
faster than a home connection), and the test step grew from about 2 seconds to 10. Twelve
seconds in total. See ADR-031.

## 6. Two things the measurements settled for free

**Playwright brings its own ffmpeg** (2.5 MB, revision 1011) and uses it to encode the WebM. So
recording needs no system ffmpeg, exactly as ADR-027 assumed when it kept `ffmpeg` a step 5
dependency. The Composer still needs the real thing.

**The `blackdetect` trick is not needed.** The cheat sheet suggests painting a solid colour
frame for ~200 ms at t0 and finding it with ffmpeg, for tighter sync than a measured number
gives. At a measured t0 of 132 ms, that machinery would add a visible flash to the opening of
every video to correct an error nobody can perceive. Record the number; revisit only if step 5's
duration check starts failing.

## 7. Failure

A recording that dies part-way through should still leave the frames it got. Playwright
finalises a video when the **context** closes, so the context must be closed on the failure path
as well as the happy one - otherwise a crash at step 7 of 9 leaves nothing at all, when it could
have left most of a video and a clear message.

That matters more here than in most stages, because the failure modes are environmental rather
than logical: no browser installed, a page that never reaches `ready`, a machine so loaded that
the clock slips. Each should say which one it was. The message for a missing browser names the
command that fixes it, the way the Kokoro client names `docker compose up` (ADR-027).

## 8. Tests

`test/recorder/schedule.test.ts` - no browser, and this is where the substance is:

- waits are computed against a monotonic clock, so a slow action does not push everything after
  it later; a step that overruns is absorbed rather than accumulated.
- an action whose `at_ms` has already passed fires immediately rather than waiting negatively.
- actions run in timeline order, including several sharing one `at_ms`.
- the tail: the recorder waits until `total_duration_ms` after the last action.
- a timeline with no actions at all still produces a sane schedule.

`test/recorder/record.test.ts` - needs Chromium, and stays small:

- a golden sample's timeline records a file that exists, starts with the EBML magic bytes, and
  is over a plausible size floor.
- the page really was driven: after a highlight action fires, the count of lit rows in the live
  page matches the range the timeline asked for. This is the assertion that catches our bugs
  rather than Playwright's.
- `t0_ms` is a non-negative number and is written to `record.json`, which passes its schema.
- the test skips itself, loudly, when no browser is installed, so a contributor without one
  still gets a green suite and a clear reason.

## 9. Documentation

- `docs/ROADMAP.md`: step 4 done, step 5 next.
- `CLAUDE.md`: `playwright` moves from planned to installed with its version; the `record`
  commands; `record.json` in the run-folder listing; the browser install in the prerequisites.
- `docs/ARCHITECTURE.md` section 7: what `t0` is and where it is written, since the contract
  chain currently stops at `video.webm`.
- `.github/workflows/ci.yml`: the browser install step.
- `docs/cheatsheets/playwright-recording.md`: the measured numbers, that `--with-deps` is
  unnecessary on `ubuntu-latest`, and that the headless shell is sufficient.
- `docs/DECISIONS.md`: an ADR for the CI decision and its measurements, because "we chose not to
  cache a 567 MB dependency" is exactly the kind of thing someone will otherwise re-litigate.

## 10. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Record `sample-01` end to end and **watch it** - the video is the product, and step 3 proved
   that looking at things finds what assertions cannot.
3. Push, and read the real CI duration off the run rather than assuming it.
4. Report. Do not start step 5.
