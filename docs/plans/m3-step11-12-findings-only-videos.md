# Plan: Milestone 3, steps 11 and 12 (findings-only videos)

Status: approved. Read CLAUDE.md, docs/ROADMAP.md, docs/NARRATION_STYLE.md, ARCHITECTURE section
2 and 4, and ADR-024, ADR-028, ADR-034 and ADR-039 first.

## 1. The decision

Bahman's, taken after watching the three finished videos, and it changes what the format is:

> A video exists to help the person reviewing a pull request understand an issue that was found,
> and to give them clear reasoning and industry-standard suggestions for fixing it.

From which, directly:

- **No intro step and no outro step.** Both are time-wasting. The severity of a finding is
  disclosed *at that finding*, when the narration starts talking about it, because severity is a
  property of the issue and is useful next to the code it describes.
- **No outro card.** The reason recorded in `src/director/outro.ts` - that a viewer can pause on
  it and screenshot it into the pull request - was put to him and rejected. It is not to be
  re-proposed.
- **No video at all when nothing was found.** The point is catching issues; a clean review has
  nothing to watch. This also resolves the objection that removing the frame steps leaves a
  clean change with nothing to say.
- **The reclaimed time goes into each issue**: the downstream problems it can cause, and the
  fixes available.

An experienced developer may not watch a video at all when the issue is trivial. The tool still
makes it, and it earns its place by being informative about the issue rather than by being
complete.

## 2. Why this is two steps, in this order

The Narrator reads `review.json` and nothing else (ADR-024), and may say nothing a finding does
not support (CLAUDE.md principle 5). Freeing fifteen seconds per issue and asking for downstream
consequences would make it **invent them**, confidently, about somebody's production system.
So the substance has to exist before there is time to spend on it.

The room is already in the contract and nobody is using it:

| | budget | Reviewer uses | fixtures use |
|---|---|---|---|
| `finding.rationale` | 1200 chars | 115-295 | 154-334 |
| `finding.suggestion` | 1200 chars | 84-257 | - |

About a fifth of what is allowed, which is the same shape of bug ADR-039 just fixed one stage
later: a generous cap stated without a target gets undershot. And ADR-028 already named the
missing beat precisely - *"the model states the mechanism and skips the outcome"*, where the
outcome is the consequence a reviewer actually needs.

## 3. Step 11: the Reviewer says what happens, and what to do about it

Prompt and rubric only. No contract change, no schema change, nothing downstream moves.

- `src/agents/prompts/reviewer.ts`: `HOW_TO_ANSWER` gains target bands for `rationale` and
  `suggestion` in the shape ADR-039 established - a range, not a ceiling, with the exception
  stated so a genuinely small finding is not padded. And it gains the two beats explicitly:
  **what breaks downstream because of this**, and **what the fix is, in industry-standard
  terms**, not just "use a repository interface" but which pattern and what it costs.
- `docs/REVIEW_RUBRIC.md`: the same wording, since the rubric is read into the prompt verbatim
  (ADR-006) and is where a reviewer of this project would look for it.

**Measured, not scored.** `spr eval` has no axis for how informative a finding is, and inventing
one would be guessing at a quality judgement - the numbers to report are the field lengths
before and after, plus precision, recall and calibration holding at 1.000. A minimum length is
deliberately **not** checked, for the same reason the 40-word narration floor is not: it would
buy padding.

## 4. Step 12: the script is findings, and nothing else

The contract change, and everything that follows from it.

**`schemas/script.schema.json`.** `Step.kind` goes away entirely rather than becoming a
one-valued enum: every step is a finding step, so `finding_id` and `focus` stop being nullable
and become required. `steps` gets `minItems: 1`. `NarrationScript.title` goes too - it existed
for the title card, and the Milestone 2 step 6 question about what a `--diff` run should call
itself (ADR-034's last paragraph) is answered by deletion.

**`schemas/timeline.schema.json`.** `show_title`, `hide_title` and `show_outro` are removed from
the action types. Nothing emits them once there are no frame steps, and dead contract surface a
future session might "polish" is worse than a clean removal - Milestone 5's line currently
promises "intro and outro cards", and that promise is withdrawn in the same commit.

**Code.** `src/agents/narrator.ts` (`assembleScript`, `scriptTitle`, `describeReview`),
`src/agents/prompts/narrator.ts`, `src/contracts/checks.ts` (the intro-first and wrap-up-last
rules, the frame word band, and the severity-word rule from ADR-038 - which was scoped to frame
steps and now has none), `src/director/timeline.ts`, `src/director/outro.ts` (deleted),
`src/recorder/page/{index.html,spr.css,spr.js}` (the card markup, styles and API), `src/cli.ts`.

**And the no-findings rule.** After Verify, a review with no kept findings stops the run: the
pipeline does not narrate, speak, record or compose, and says so in one line. This is a correct
outcome and not an error, so it exits 0 - which also means a clean change costs nothing beyond
the review itself. Publish (Milestone 4 step 2) will post the review without a video.

**One thing that only shows up on screen.** With no intro, the first finding's window starts at
0, and `leadInOf` clamps to `Math.max(0, previousEnd, start - 300)` - so the scroll and the
highlight fire at the same instant as the first word, with no time to settle. The fix is for the
Recorder to position the page before `t0` rather than at it, during the warm-up it already has.
Worth watching for specifically, because it is exactly the class of thing every step from
Milestone 2 found only by looking.

## 5. Tests

- Step 11: the prompt carries the bands and the two beats; the rubric is still read verbatim.
- Step 12: `checkScript` on a findings-only script; a single-finding script is valid; a script
  with a step carrying no `finding_id` is refused by the schema rather than by a check.
- The golden fixtures are rewritten - `script.expected.json` loses its intro and wrap-up on all
  three samples - and the fixture validation test is what proves the contract change landed.
- `runVerify` with no surviving findings, and the CLI stopping cleanly on it.
- The Director emits no card actions, and the first step's lead-in is not negative.

## 6. Docs

- `docs/NARRATION_STYLE.md`: the intro/wrap-up rules go; the clean-change line goes with them;
  the length section is about findings only.
- `docs/ARCHITECTURE.md`: sections 2, 4 and 6, and the pipeline's behaviour on a clean review.
- `docs/ROADMAP.md`: steps 11 and 12; and Milestone 5 loses "intro and outro cards".
- `docs/DECISIONS.md`: one ADR for the enrichment, one for the format change. The second
  supersedes the parts of ADR-034 and the m2-step3 card reasoning that this overturns.
- `CLAUDE.md`: the run-folder contents and the `spr run` description.

## 7. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build` after each step.
2. `spr eval` after step 11 - field lengths up, the three rates unmoved.
3. `spr eval` after step 12, then one sample end to end, and **watch it**: the first finding must
   not open mid-scroll, and the video must start on code.
4. Commit each step separately, push, check CI.
