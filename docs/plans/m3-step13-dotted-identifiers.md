# Plan: Milestone 3, step 13 (dotted identifiers read aloud)

Status: proposed, written in the session that expanded the golden set (ADR-044). Nothing here is
built. Read ADR-024, ADR-027 and ADR-038 first, and the two lines of `docs/NARRATION_STYLE.md`
that already cover this: "Describe code, don't read it" and "Split identifiers into words".

## 1. What happens

A step on `sample-01-order-outbox` says "order.placed", which Kokoro reads as "order dot
placed". `FILE_REFERENCE_PATTERN` in `src/contracts/checks.ts` refuses file names, paths and
URLs, but not an event name or a `module.member` identifier, so nothing stops it.

**How often: one token, ever.** Across the 55 scripts and 148 narrated steps under `runs/`, the
only dotted identifier narrated is `order.placed`, in six run folders, always on sample-01. None of
the seven hand-written `script.expected.json` fixtures contains one in its spoken text - the
sample-01 fixture already says "the order placed event", which is the target. So this is a real
defect with a known single cause, not a pattern across the set, and the fix should be sized to
that.

## 2. Options

**A. Refuse a dotted identifier in `checkScript`. Recommended.** Add a pattern for a token of
letters, a dot, and letters - `\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b` - beside `FILE_REFERENCE_PATTERN`,
with a message that says what to write instead ("say the order placed event"). It is the shape
ADR-038 gave severity words: an enforced invariant, repaired by the Narrator's existing retry,
rather than a metric. It fixes the subtitle as well as the voice, because the reworded text is
what both are built from. Decimals are untouched, since both sides must start with a letter.
The known false positive is "e.g." and "i.e.", which the style guide would rather see spoken as
"for example" anyway; state that in the check's comment, as ADR-038 did for "it is critical
that".

**B. Rewrite it at speech time in the pronunciation map.** `src/tts/normalize.ts` could turn
`order.placed` into "order placed" before Kokoro sees it. Deterministic and free - but the
subtitle would still read "order.placed" while the voice says "order placed", which is the class
of disagreement ADR-038 was written to end. It also puts a rule about writing into a module
ADR-027 scoped to pronunciation.

**C. Say it in the Narrator's prompt.** `NARRATION_STYLE.md` already says it. A rule the model
has been given and broken is not fixed by giving it again; A is what makes it hold.

## 3. Scope if A is approved

- `src/contracts/checks.ts`: the pattern and the problem message, inside `checkScript`.
- `test/contracts/`: `order.placed` is refused with a message naming the fix; `1.5 seconds` is
  not; a file name is still reported as a file name rather than twice; every golden
  `script.expected.json` still passes (the golden-set test already asserts this).
- `docs/NARRATION_STYLE.md`: one example under "Split identifiers into words" - an event name is
  said as words, "the order placed event".
- No contract change and no schema change. ADR-046 only if the e.g. ruling needs recording;
  otherwise the comment in the check is the record, as it was for ADR-038's false positive.

## 4. What to check

- `pnpm verify`.
- The Narrator's retry is the part a unit test cannot reach. One cold `spr stage narrate` on a
  sample-01 run folder, with the model up, should produce a script without "order.placed" in one
  or two attempts; if it takes all its retries, the problem message is not saying clearly enough
  what to write instead.
- `spr eval` narration columns are unchanged on the other six samples, because none of them
  narrates a dotted identifier today.
