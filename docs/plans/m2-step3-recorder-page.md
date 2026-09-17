# Plan: Milestone 2, step 3 (the Recorder page)

Status: done. Implemented in "Milestone 2 step 3: the Recorder page" (ADR-030). Q1 to Q5 went
as recommended; Q6 resolved to the review's finding summary rather than a branding line. Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md (section "2. Stages",
subsection 7), `docs/cheatsheets/playwright-recording.md`, `schemas/timeline.schema.json` and
docs/DECISIONS.md (ADR-005) first.

This is the first step whose output is judged by eye. The three before it produced files that
are right or wrong - a duration matches a header, a window matches a clip - and could be settled
with an assertion. A dark-theme diff page with a title card is a design question, and the plan
has to say how it gets decided, not just what gets built. Section 6 is that.

It is also the first step that brings a browser into the repository, though deliberately not
Playwright: driving the page is step 4. Step 3 delivers **a page you can open and look at**.

## 1. What it does

Turns a unified diff into a self-contained HTML file that knows how to be directed: it renders
the diff with diff2html (ADR-005), tags every row so a line can be addressed by file and number,
and exposes `window.spr` so the Recorder can execute a timeline against it.

Nothing in this step reads a timeline or writes a video. The page's contract with the rest of
the pipeline is one function - `window.spr.run(action)` - taking exactly the action objects
`timeline.schema.json` already defines. That keeps the schema the single interface between Node
and the browser, which is what makes step 4 small.

## 2. Files

```
src/recorder/page.ts            # buildPage(diffText, options) -> a complete HTML document
src/recorder/page/index.html    # the template: layout, cards, mount point
src/recorder/page/spr.css       # theme, title and outro cards, the highlight treatment
src/recorder/page/spr.js        # row tagging and the window.spr API
src/recorder/page/global.d.ts   # the Window interface, so no file needs `any`
src/recorder/tag-rows.ts        # pure-ish: tag a rendered diff's rows, given a DOM root
scripts/preview-page.ts         # dev aid: build a run folder's page and print its path
```

Plus a small touch to step 2's stage for Q6: `summarizeFindings(review)` and an `outroText`
option threaded from `runDirect` into `buildTimeline`.

`page/` holds what ships to the browser and `page.ts` assembles it, the same shape CLAUDE.md's
layout line already describes ("Playwright + diff2html page (page/ holds HTML, CSS, JS)").

`tag-rows.ts` is separate from `spr.js` for one reason: it is the part most likely to break
silently, and pulling it out makes it testable in Node against diff2html's real output. See
section 7.

## 3. The page's contract

`window.spr`, called only through `run(action)`:

| Action | What the page does |
|---|---|
| `show_title` | Fade in the title card, showing `action.text` |
| `hide_title` | Fade it out, revealing the diff |
| `open_file` | Bring that file's section into view (`stickyFileHeaders` keeps its name on screen) |
| `scroll_to` | Smooth-scroll the target rows to the middle of the viewport |
| `highlight` | Add `.spr-hl` to every row in the range |
| `clear_highlight` | Remove it from everywhere |
| `show_outro` | Fade in the outro card |

Plus `window.spr.ready === true` once the diff is drawn and tagged, which is what step 4 waits
on before starting its clock. Getting this right here means step 4 never has to guess whether
the page has finished rendering.

Every method is a no-op rather than a throw when its target is missing. A page that dies
half-way through a recording produces a video of a stack trace; one that skips an action
produces a video with one dull moment in it.

## 4. Row tagging, which is the fragile part

diff2html renders a table; the page needs to find "file X, new side, lines 19 to 27". The cheat
sheet is explicit that class names in diff2html's output move between versions, so the page
tags rows itself on load - `data-file`, `data-side`, `data-line` - and every selector after that
reads its own attributes rather than diff2html's markup.

That makes the tagging the one place a diff2html upgrade can break the product silently: the
page still renders, the video still records, and nothing is ever highlighted. It gets a real
test (section 7) rather than a hope.

## 5. Decisions to take

**Q1. Which diff2html bundle? Recommendation: the full `diff2html-ui.min.js`.**
Version 3.4.56 ships four, and the choice is syntax highlighting: `diff2html-ui.min.js` is 1.0 MB
because it bundles highlight.js, `diff2html-ui-slim.min.js` is 295 KB without it, and
`diff2html-ui-base.min.js` is 88 KB. The entire point of the video is reading code on screen, so
code should look like code; the cost is a local file read at page load, not a download, and the
page is a run artifact rather than something committed. Recommendation: the full bundle, with
`-slim` named in the cheat sheet as the fallback if load time ever matters.

**Q2. One self-contained file, or a page directory with `vendor/`? Recommendation: one file.**
The roadmap says "bundle vendored at build time". Copying `bundles/` into `src/recorder/page/vendor/`
works, but it adds a build step that has to run before any recording, a gitignored directory that
is easy to have stale, and relative-path questions under `file://`. Inlining the bundle, the CSS
and the diff into a single generated HTML is simpler on every count: no build step, no path
resolution, and the artifact can be opened, attached to a bug report or handed to someone
directly. Recommendation: `buildPage` reads the bundle out of `node_modules/diff2html/bundles/`
and inlines it; the run folder gets one `page.html`.

**Q3. Line-by-line or side-by-side? Recommendation: line-by-line.**
ARCHITECTURE leaves it open. At 1280x720 with type large enough to read in a video, side-by-side
halves the usable width - and most of what this tool reviews is new files, where the left column
is empty and half the frame is wasted. Recommendation: `outputFormat: 'line-by-line'`, hardcoded,
with no config switch until there is a reason for one. Same argument as `render_mode` in step 2.

**Q4. Add a DOM environment for tests? Recommendation: yes, `happy-dom`.**
Row tagging is DOM behaviour, and it is the part a diff2html upgrade breaks silently. diff2html
ships a Node entry point (`html(diffInput, config)`, typed), so a test can render a golden diff
in Node, parse it, run the real tagging function over it, and assert that every added line is
addressable. That test fails the moment an upgrade changes the markup, which is exactly when it
should. The cost is one dev dependency and a per-file vitest environment. Recommendation: take
it - this is the one place in the project where DOM behaviour *is* the product.

**Q5. How is a page produced before step 4 exists? Recommendation: a script, not a command.**
`scripts/preview-page.ts <run folder>` builds the page and prints the path, the way
`scripts/gen-types.ts` already sits outside the CLI. It stays useful after step 4 as a way to
look at a page without recording. Recommendation: a script now; it can graduate to a CLI flag if
it turns out to be reached for often.

**Q6. What does the outro card say? Decided: the review's own finding summary**, for example
"2 issues to fix - 1 high, 1 medium". Not a branding line.

The question that settled it was whether the card is worth having at all. Its costs are close to
zero - it adds no video length, because the wrap-up window is the length of the wrap-up clip
either way, and `show_outro` is already in the schema and already emitted, so removing it would
be a contract change rather than a saving. Its one real benefit is that a `wrap_up` step has
`focus: null`: there is genuinely nothing to look at. Without a card the screen sits on a
de-highlighted diff, still scrolled to wherever the last finding was, while the narration talks
about all of them. A card is the honest end state. But that benefit argues for a *neutral,
informative* end frame, not for a logo - so the card carries something a viewer can pause on.

**Where the text comes from.** Severity is not in `script.json` - a `Step` has `id`, `kind`,
`finding_id`, `text`, `subtitle`, `focus` and `estimated_seconds` - so the count is derivable
from the script but the breakdown is not. `runDirect` therefore reads `review.json` as well
(`readReview` already exists, and the file is in every run folder that got this far) and passes
a finished string into `buildTimeline` as an option. **`buildTimeline` stays a pure function of
script, manifest and config**: it receives a string, not a third file, so step 2's shape is
unchanged and only the stage around it grew an input. `docs/ARCHITECTURE.md` section 6 says the
Director reads two files and needs a one-line amendment saying which part reads what.

Putting `severity` on the script contract was the alternative, and it is the better long-term
shape because it would also enable the per-finding severity badge the cheat sheet suggests. It
is a schema change plus three golden fixtures to serve one card, so it waits for a reason bigger
than this one - the look-at-it loop in section 6 is where that reason would turn up.

## 6. How we decide it looks right

The part that cannot be asserted. The loop:

1. `scripts/preview-page.ts` builds the page for a golden run.
2. I open it in this session's own browser, drive `window.spr.run(...)` through a real
   timeline's actions, and take screenshots at the interesting moments - title card, a highlight
   mid-scroll, the outro.
3. I show you those screenshots and you say what is wrong with them.

This is worth spelling out because it is why Playwright is not in this step. The session can
already open a page, execute JavaScript in it and screenshot it, so the design question gets
answered a step before the automation arrives - and step 4 starts against a page somebody has
actually looked at.

Two things I will be looking at specifically, and will flag if they are bad: whether 16 to 18 px
monospace at 1280x720 is genuinely readable rather than technically legible, and whether the
highlight reads as "look here" without obscuring the code under it.

## 7. Tests

`test/recorder/tag-rows.test.ts` and `test/recorder/page.test.ts`.

- tagging, against diff2html's **real** output for every golden diff rendered in Node: every
  added line is addressable by `[data-file][data-side="new"][data-line="N"]`, the numbers match
  the diff's own new-side numbering, and context lines are tagged on both sides. This is the
  test that catches a diff2html upgrade.
- a range spanning several rows resolves to every row in it, and a range with no rows resolves
  to none without throwing.
- `buildPage` output: one document, no `http://` or `https://` reference anywhere in it (the
  offline guarantee), the diff text present, and the title escaped rather than injected - a
  branch name with a `<` in it must not be able to close a tag.
- `buildPage` is deterministic for the same diff and options.
- the `window.spr` surface: every action type in `timeline.schema.json` has a handler, asserted
  by iterating the schema's own enum rather than a hand-written list, so a new action type
  cannot be added to the contract without the page noticing.
- `summarizeFindings`: singular and plural ("1 issue to fix", "2 issues to fix"), severities in
  severity order rather than the order they happen to appear, and a clean review - which has no
  findings at all and must say something better than "0 issues to fix".
- no network in any of it, per CLAUDE.md.

## 8. Documentation

- `docs/ROADMAP.md`: step 3 done, step 4 next.
- `CLAUDE.md`: `diff2html` moves from planned to installed, with its version; the `src/recorder/`
  layout line; the preview script in the commands section.
- `docs/ARCHITECTURE.md` section 7: the page half of it - the tagging contract, `spr.ready`, and
  whichever way Q1 to Q3 go.
- `docs/cheatsheets/playwright-recording.md`: correct it against 3.4.56. The bundle paths in it
  are right; the bundle sizes, the `Diff2HtmlUI` option names (`highlight`, `stickyFileHeaders`,
  `fileContentToggle`, `synchronisedScroll`) and the `ColorSchemeType` enum are all worth
  recording, and the `(window as any)` note can point at the real `global.d.ts`.
- `docs/DECISIONS.md`: an ADR if Q1, Q2 or Q4 goes against the recommendation, or if building it
  turns up something the way the streaming WAV header did in step 1. Three scoped choices with
  their reasons in the code do not need one each.

## 9. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. The look-at-it loop in section 6, with screenshots, before anything is called done.
3. Commit, push, check CI. No new CI dependency: the tests render diff2html in Node and parse
   with happy-dom, so nothing installs a browser until step 4.
4. Report. Do not start step 4.
