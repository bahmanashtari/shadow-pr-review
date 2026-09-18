# Plan: Milestone 3, steps 9 and 6 (what the narration says, and how much of it)

Status: approved, with all three recommendations in section 3 taken unchanged - two commits
with the eval run behind step 6 only (Q1), a deliberately literal severity-word check whose
false positive is accepted (Q2), and a 40 to 60 band with a stated exception rather than an
enforced floor (Q3). Read CLAUDE.md, docs/ROADMAP.md, docs/NARRATION_STYLE.md, and ADR-024,
ADR-025, ADR-028, ADR-034 and ADR-037 first.

Two Narrator changes the roadmap has always said belong together. They are together because
they touch the same prompt and the same style file, and apart in one important way: **only one
of them can be measured by `spr eval`**, and section 3 is about what that means.

## 1. What is wrong

**Step 9: the voice contradicts the card.** `sample-03`'s outro card reads "1 issue to fix - 1
low" while its narration says "critical" three times. The mechanism is now exactly located:

- The outro card is `summarizeFindings(review)`, which counts each kept finding's `severity`
  **field**.
- The Narrator's user message opens `The change: ${review.summary}` - the Reviewer's **prose**,
  which on all three golden samples begins "Critical ...".
- The intro and the wrap-up echo that prose. The *finding* steps do not: `describeFinding`
  gives them `${finding.severity}` on its first line, and they use it correctly.

So the fault is one line of input, and it reaches exactly two of the steps. ADR-037 made it
sharper rather than causing it: with `sample-03` correctly downgraded to `low`, the field and
the prose now disagree where before they were wrong together.

**Step 6: the length cap is undershot by 44%.** ADR-028 pinned the cause to one sentence in
`HOW_TO_ANSWER` - "Those are hard limits, not targets." - and ADR-034 re-measured after
ADR-029: finding steps mean **33.7 words against the fixtures' 44.6**, and the whole-video
target of "1 to 5 minutes" is missed by all three samples and by two of the hand-written
fixtures.

ADR-034 also supplied the argument ADR-028 lacked. The style file states three length rules.
The one written as a **cap** ("at most 60 words") is undershot by 44%. The one written as a
**band** ("15 to 40 words each") is hit by all nine intro and wrap-up steps in the three
samples - 26, 31, 24, 17, 20, 17, with nothing outside it. Same model, same prompt, same run.

## 2. The asymmetry that shapes this step

`measureScript` records steps, words, `max_step_words` and `estimated_seconds` against the
fixture's. **So step 6 is visible to `spr eval` and step 9 is invisible to it** - nothing in the
scorer reads a single word of narration, and a script that calls a `low` finding critical scores
exactly like one that does not.

That is the ADR-036 situation again, and it has a better answer here than a new axis.
**Step 9 should be an enforced invariant, not a measured one.** `checkScript` already refuses a
script with a step over the word cap, with markdown in it, or with a file name spoken aloud, and
the Narrate stage feeds those back to the model as repairs (ADR-024). A severity word that
contradicts the review belongs in exactly that list: it is checkable from `review.json` alone,
and an enforced rule cannot silently regress the way a metric can.

That also settles the sequencing. Step 9 needs no eval run of its own beyond "nothing else
moved"; step 6 is a genuine prompt change and needs one.

## 3. Decisions to take

**Q1. One commit and one eval run, or two? Recommendation: two commits, and the eval run behind
step 6 only.**

They are different kinds of change. Step 9 adds a deterministic rule plus the input that makes
it satisfiable - its correctness is the test suite's business, and the eval run only has to show
it moved nothing. Step 6 changes what the model is asked to aim for, which is exactly what
ADR-025 says must be argued with the scorer. Bundling them would put an unmeasurable change and
a measured one in the same measurement, and any movement in the script column would be
unattributable.

Two commits, step 9 first because it is the defect. One `spr eval` after each, which on a warm
cache is a few minutes apiece.

**Q2. How does the check decide a severity word is wrong? Recommendation: a word may be spoken
only if a kept finding carries it.**

The rule reads `review.json`, which the Narrator was given: collect the severities of the kept
findings, and refuse an intro or wrap-up containing one of the four rubric words - critical,
high, medium, low - that no kept finding has. `sample-03` after ADR-037 has only `low`, so
"critical" is refused and the model rewords on the repair.

Deliberately narrow in three ways. It checks only the four rubric words, because those are the
ones the card counts. It checks only the intro and wrap-up, because the finding steps already
read the field and constraining them would forbid a step legitimately saying "this one is the
high-severity one". And it asks only that the word be *present in the review*, not that the
counts match, because "we found two serious problems" is good narration and counting aloud is
not what the card is for.

**The known false positive** is the ordinary-English sense: "it is critical that this is fixed
before release" would be refused on a review with no critical finding. That is a real cost. It
is bounded - the repair loop rewords it, and only two steps per script are checked - and the
alternative, matching the word only in a severity-shaped context, is a parser guessing at
meaning. If it proves annoying in practice the answer is to drop the word "critical" from the
check rather than to make the check clever.

**Q3. What band for a finding step? Recommendation: 40 to 60 words, with an explicit exception
for a genuinely small point.**

A plain floor of 40 would make two hand-written fixtures non-compliant - `sample-02`'s
`empty-down` at 24 words and `sample-03`'s finding at 35 - and a target the standard fails is a
target, not a diagnosis. That is the mistake ADR-028 caught in "1 to 5 minutes", and repeating
it one line further down would be worse for having been warned.

The fixtures' finding steps are 60, 53, 44 / 50, 49, 42, 24 / 35: a mean of 44.6, with the two
short ones both on genuinely minor findings. So the rule should say what the style file already
says in prose - what is there, what goes wrong because of it, what to do - and give the band as
the length that usually takes: **"Most findings need 40 to 60 words to say all three. A
genuinely small point can be said in fewer; nothing else should be."**

`maxWordsPerStep` stays a hard cap in `checkScript`. The floor is prompt guidance and **not** a
check, because a check would force padding on the small point the exception exists for.

**Q4. What replaces "Whole video: 1 to 5 minutes"? Recommendation: state it as the format's
range, not a target.**

ADR-028 already did the arithmetic: video length is dominated by how many findings there are,
and `review.maxFindings` (10) plus an intro and wrap-up at the 60-word cap is about 4:50. So the
honest line is that the format runs from about 25 seconds for a single-finding change to about
five minutes for a full review, and that a short video for a small change is correct rather than
a failure. No floor.

## 4. Files

- `src/contracts/checks.ts`: the severity-word rule in `checkScript`.
- `src/agents/narrator.ts`: `describeReview` hands the Narrator the card's own line -
  `summarizeFindings(review)` - alongside the change summary, so the voice and the card read
  the same computed string rather than two different sources.
- `src/agents/prompts/narrator.ts`: `HOW_TO_ANSWER` loses "Those are hard limits, not targets."
  and gains the band (Q3); a line saying severity words come from the findings, not the summary.
- `docs/NARRATION_STYLE.md`: the length section (Q4). It is read into the prompt verbatim, so
  this is part of the same prompt change.
- `test/contracts/checks.test.ts`, `test/agents/narrator.test.ts`.

## 5. Tests

- The severity rule: a word no finding carries is refused; a word one carries is accepted; the
  finding steps are not checked; a clean review with no findings refuses all four.
- `describeReview` includes the card's line, and a review whose summary and severities disagree
  produces input that says so.
- The golden fixtures still pass `checkScript` unchanged - the regression that matters, since
  they are the standard both changes aim at.

## 6. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. `spr eval` after step 9: precision, recall and calibration unmoved, scripts still narrated.
3. `spr eval` after step 6: the script column against `want`, which is what this is for.
4. Re-run `sample-03` end to end and watch it - the card and the voice should now agree, which
   is the thing ADR-034 could see and no number can.
5. Commit, push, check CI.
