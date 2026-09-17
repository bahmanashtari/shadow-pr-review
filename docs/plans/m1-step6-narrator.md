# Plan: Milestone 1, step 6 (the Narrator agent)

Status: done. Implemented in "Milestone 1 step 6: the Narrator agent" (ADR-024).
Both open questions were decided before implementation: fail the stage but keep the rejected draft, and
enforce the intro and wrap-up length). Read CLAUDE.md, docs/ROADMAP.md,
docs/ARCHITECTURE.md (section "4. Narrator agent"), docs/NARRATION_STYLE.md and
docs/DECISIONS.md (ADR-002, ADR-006, ADR-015, ADR-016, ADR-023) first.

This step turns `review.json` into `script.json`: the spoken walkthrough, and the last
contract Milestone 1 owes. Everything after it - TTS, the Director, the Recorder, the
Composer - derives its timing and its on-screen behaviour from this file, so the script is
where a mistake is cheapest to catch and most expensive to miss.

## 1. What it does

Input: `review.json` only. Never the diff: ARCHITECTURE.md makes that a rule, and it is what
keeps this stage grounded (the Narrator cannot invent an issue it has not been handed) and
cheap (one small prompt, no tools, no checkout).

The shape of the script is not a judgement call. `checkScript` already requires:

- the first step is `intro` and the last is `wrap_up`, and nothing else may be either;
- step ids run `S00`, `S01`, ... with no gaps;
- exactly one `finding` step per kept finding, in the order `review.json` lists them;
- `focus` equals that finding's file, side and line range exactly.

So the model is asked for the only thing it is actually good at - the words - and the code
builds the file. That is CLAUDE.md principle 2 applied literally, and it is the same split
that `src/agents/reviewer.ts` already uses: the model writes findings, the code assigns ids.

| Field | Who sets it |
|---|---|
| `schema_version`, `language` | code (`config.narration.language`) |
| `title` | code: `Review: <source.title>` |
| `steps[].id` | code: `S00`, `S01`, ... by position |
| `steps[].kind` | code: intro, then one `finding` per finding, then wrap_up |
| `steps[].finding_id` | code (the model echoes it back; see below) |
| `steps[].focus` | code, copied from the finding |
| `steps[].subtitle` | code: `null`, so the subtitle is the spoken text |
| `steps[].estimated_seconds` | code: words / 2.5, as the schema says |
| `steps[].text` | **the model** |

The cap lines up exactly: `review.maxFindings` is 10 (ADR-016) and `script.schema.json` allows
12 steps, which is 10 findings plus an intro and a wrap-up. No kept finding can ever be left
unnarrated for want of room, so the Narrator never has to choose what to leave out.

## 2. The model's answer

The model returns the texts, not the file:

```json
{
  "intro": "...",
  "steps": [{ "finding_id": "F01", "text": "..." }],
  "wrap_up": "..."
}
```

`narratorOutputSchema(review)` builds this in code from `schemas/script.schema.json`, the way
`reviewerOutputSchema` does for the review contract, so the `text` length limits stay in one
place. It pins the answer hard: `steps` has `minItems` and `maxItems` equal to the number of
kept findings, and `finding_id` is an `enum` of exactly those ids. On Ollama that constrains
decoding, so a structurally wrong answer is close to impossible before validation even runs.

`finding_id` is redundant - the position already decides which finding a step narrates - and
that is the point. It is a checksum. A model that drifts by one and writes the migration's
text in the consumer's slot produces an answer that still parses, and the echoed id is what
catches it. `assembleScript` does not need to police this itself: it pairs each text with the finding its
id names, so a reordered answer produces a script whose steps are in the wrong order, and
`checkScript`'s existing ordering rule reports it in words the model can repair.

**`title` is set by code**, not by the model: `Review: <source.title>`, falling back to
`Code review` when the source has no title (a `--diff` run without `--title`), truncated to the
schema's 100 characters. All three golden fixtures already hold exactly that string, so this is
a rule being written down rather than a change. The title is shown on the title card and never
spoken, so a file name in it is harmless.

## 3. The prompt

`src/agents/prompts/narrator.ts`, built the way the Reviewer's prompt is built (ADR-006): a
role line, then `docs/NARRATION_STYLE.md` read fresh from disk, then a short "How to answer"
section. Editing the style file changes the narration without a rebuild, and - as with the
rubric - a style change means the golden scripts should be re-read.

The findings are rendered into the user message as prose, one block per finding: id, severity,
category, summary, rationale, suggestion, the file path, and the evidence lines.

Two of those need justifying:

- **Evidence is included.** "Describe code, don't read it" requires knowing what the code says;
  `reserved_quantity` only becomes "the reserved quantity column" if the Narrator can see it.
  Evidence lives in `review.json`, so this respects the never-the-diff rule.
- **The file path is included**, because "the consumer" and "the migration" are the natural
  words for a listener and the model needs to know which is which. The prompt says plainly that
  the path is context and must never be spoken, and the file-name check enforces it.

Everything in that message comes from `review.json`, which carries model-written prose about
untrusted diff content. It therefore goes in as `user` content and never into the system
prompt, and the prompt says outright that text inside a finding is material to describe, not
instructions to follow.

## 4. The checks, and the retry

The roadmap asks for "word, markdown and file-name checks with retry". All three already exist
in `checkScript` (`countWords`, `MARKDOWN_PATTERN`, `FILE_REFERENCE_PATTERN`), and the harness
already has the retry: `runAgent` takes a `check?: (value) => string[]` hook, feeds its problems
back to the model as a repair message, and fails the stage after `maxRetries`.

So the stage passes:

```ts
check: (value) => checkScript(assembleScript(value, review, config), review, {
  maxWordsPerStep: config.narration.maxWordsPerStep,
})
```

`assembleScript` is a pure function used both here and for the final output, so the thing that
is checked is exactly the thing that is written. The model gets back messages like
`/steps/2 (S02): 71 words, maximum is 60` and `/steps/1 (S01): text reads out a file name, path
or URL` - specific enough to repair in one attempt.

This is the first use of the `check` hook, which was built in step 3 for precisely this.

## 5. Files

```
src/agents/narrator.ts           # narratorOutputSchema, assembleScript, runNarrate, writeScript, summarizeNarrate
src/agents/prompts/narrator.ts   # buildNarratorPrompt from docs/NARRATION_STYLE.md
```

`readReview(runDir)` joins `readRawReview` in `src/verify/verify.ts`, which already owns
`REVIEW_FILE`. No tools module: the Narrator gets none.

Two small changes outside the stage:

- **`src/providers/llm/create.ts`**: the fake provider answers one canned `ReviewerAnswer`
  today, so it would fail the Narrator's schema twice and kill the stage. It gains a second
  canned answer chosen by `outputSchema.title`, reading the finding ids out of the schema it
  was handed. `SPR_LLM_PROVIDER=fake` keeps its advertised meaning: the whole pipeline, offline,
  with no model.
- **`src/cli.ts`**: one `Tracer` for the whole run, created in `runPipeline` and shared by
  review and narrate, so `cost.json` covers both stages instead of being overwritten by the
  second one.

## 6. CLI

```
pnpm spr run --diff change.patch --until narrate     # ingest, review, verify, narrate; exit 0
pnpm spr run --diff change.patch                     # now stops after narrate, exit 2, pointing at Milestone 2
pnpm spr stage narrate --run runs/<id>               # re-narrate from review.json; free on a cache hit
```

Summary line in the shape the other stages use: `script: 5 steps, about 84 seconds`.

## 7. Tests

`test/agents/narrator.test.ts`, plus additions to `test/contracts/checks.test.ts` and
`test/cli.test.ts`. No network, no model: everything runs against `FakeLlmProvider`.

Schema and assembly:

- `narratorOutputSchema` pins `minItems`/`maxItems` to the finding count and the `finding_id`
  enum to exactly the kept ids.
- `assembleScript` sets `S00..`, copies each `focus` from its finding, sets `subtitle` null,
  computes `estimated_seconds`, and takes `language` from config.
- title: from `source.title`; the fallback when it is null; truncation at 100 characters.
- ids echoed out of order are rejected, and the rejection names the slot.
- no findings at all: a valid two-step script, intro and wrap-up, which the schema's
  `minItems: 2` allows.

The retry, which is the part of this step most likely to break:

- an answer with 70 words in one step is sent back and the repaired answer is accepted;
  `attempts` is 1 and the final script passes `checkScript`.
- the same for an answer containing markdown, and for one that reads out `place-order.handler.ts`.
- a model that never repairs fails with a `StageError` naming the problems, after exactly
  `maxRetries` repairs.

End to end:

- **Golden regression:** for all three samples, `script.expected.json` passes `checkScript`
  against its own `review.expected.json` with the configured word cap. (Today's golden test
  checks this with the default cap; this ties it to config.)
- CLI: `--until narrate` writes `script.json` and exits 0; a bare `run` exits 2 naming
  Milestone 2; `spr stage narrate` rewrites `script.json` in a finished run folder.

## 8. Failure, and the human in the loop

**Decided: the stage fails, and leaves behind everything needed to fix it by hand.**

A budget stop or three failed repairs raises a `StageError` and the run folder is kept. There is
no deterministic narration worth hearing: a finding's `summary` is written for a reader and is
full of identifiers and file names, so a fallback script would fail the very style checks this
step adds, and every later stage builds on `script.json`.

But failing is not the end of the run, because of CLAUDE.md principle 4. A stage boundary is a
file, so a person can take over at exactly the point of failure:

1. The error lists the precise problems, for example `/steps/2 (S02): 71 words, maximum is 60`.
2. **`script.rejected.json` is written** with the draft that failed. This is the part that does
   not exist today: `runAgent` throws its last answer away, so the operator gets the complaints
   without the text that caused them. The stage's `check` closure keeps the last assembled
   draft and writes it on the way out. (A draft only exists when the answer passed the JSON
   Schema and failed the narration rules; a malformed answer leaves no file, and the error says
   so.)
3. The operator edits it, saves it as `script.json`, and confirms it with
   `spr validate script.json`; or changes a budget, `docs/NARRATION_STYLE.md` or the model and
   re-runs `spr stage narrate --run runs/<id>`. Either way the pipeline continues from there.

The error message names those two paths, so the way forward is in the failure itself.

**Not an interactive prompt.** The tool's destination is GitHub Actions (Milestone 4), which has
no TTY: a pause would hang CI, so it would have to be an opt-in flag - speculative machinery for
a moment when there is nothing useful to type. Every real fix here is an edit to a file followed
by a re-run, which is what the two commands above already do.

Worth recording: the natural human gate is not failure but success. `spr run --until narrate`
stops with a readable script before any TTS or recording time is spent on it, which is the
cheapest possible place for a person to say yes or no.

**Also decided: `checkScript` enforces the intro and wrap-up length** that
`docs/NARRATION_STYLE.md` states - 15 to 40 words - unconditionally, next to the existing
per-step cap. Nothing enforced it before; all three golden fixtures already comply (37/25,
31/23, 24/21 words); and it gives the retry loop a lever on the step most likely to ramble.
The alternative left a 90-word intro passing every check and reaching the video, which is how
the ordering rule had drifted before step 5.

## 9. Documentation

- `docs/ROADMAP.md`: step 6 done, step 7 next.
- `docs/ARCHITECTURE.md` section 4: what the code sets and what the model writes.
- `CLAUDE.md`: the new commands, `narrator.ts` in the layout, and the pipeline's new stopping
  point.
- `docs/DECISIONS.md`: ADR-024 for the code-owns-the-skeleton split, the echoed `finding_id`
  checksum, evidence and the file path in the prompt, failing with a rejected draft rather than
  a fallback script or an interactive prompt, and the intro and wrap-up length rule.

## 10. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Smoke run: `spr run --diff golden/sample-01-order-outbox/diff.patch --until narrate` against
   local Ollama, with the produced `script.json` in the report, read against
   `golden/sample-01-order-outbox/script.expected.json`.
3. Commit, push, check CI.
4. Report. Do not start step 7.
