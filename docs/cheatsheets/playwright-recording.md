# Cheat sheet: Playwright recording with diff2html

> Snapshot written September 2026. Verify against playwright.dev (Node.js) and the
> diff2html README. Class names in diff2html output can change between versions: tag
> rows yourself (below) instead of relying on them.

## Install

```bash
pnpm add playwright          # the library; @playwright/test is not needed
pnpm exec playwright install chromium-headless-shell
```

> Measured at **playwright 1.63.0**, September 2026 (ADR-031). Three findings, each of which
> changed what this section used to say:
>
> - **The headless shell is enough**, including for `recordVideo`. A default install fetches
>   `chromium` (369 MB), `chromium-headless-shell` (195 MB) and Playwright's own `ffmpeg`
>   (2.5 MB); with the full Chromium moved aside, recording still worked. About 94 MiB of
>   download, ~20 s.
> - **`--with-deps` is unnecessary on `ubuntu-latest`**, which already ships Google Chrome,
>   Chromium, Firefox and Selenium, so the system libraries are present.
> - **Do not reach for `actions/cache`.** A full install is 567 MB on disk; saving and
>   restoring that is plausibly slower than downloading 94 MiB again.

Container option: the official Playwright Node image
(`mcr.microsoft.com/playwright:v<version>-<distro>`, match the npm package version)
plus `apt-get install -y ffmpeg`. Measured at **912 MB compressed** for
`v1.63.0-noble` amd64 - about ten times the browser download - and it supplies its own Node,
which would override an `.nvmrc` pin. Worth it when you want parity with a shipped image, not
for running tests.

**Playwright brings its own ffmpeg** and uses it to encode the WebM, so recording needs no
system ffmpeg. The Composer still does.

## Record a context

```ts
// src/recorder/record.ts
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { Timeline } from "../contracts/generated/timeline.js";

export interface RecordResult { videoPath: string; t0Seconds: number }

/** Opens the diff page, executes the timeline, and returns the video path and t0. */
export async function record(htmlPath: string, outDir: string, timeline: Timeline): Promise<RecordResult> {
  const { width, height } = timeline.video;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: outDir, size: { width, height } },
    });
    const started = performance.now();           // recording starts with the context (approximately)
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForFunction(() => (window as any).spr?.ready === true);
    const t0 = performance.now();

    for (const action of timeline.actions) {
      const wait = action.at_ms - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      await page.evaluate((a) => (window as any).spr.run(a), action);
    }
    const tail = timeline.total_duration_ms - (performance.now() - t0);
    if (tail > 0) await sleep(tail);

    const video = page.video();
    await context.close();                        // the video file is finalized on close
    if (!video) throw new Error("Playwright did not record a video");
    return { videoPath: await video.path(), t0Seconds: (t0 - started) / 1000 };
  } finally {
    await browser.close();
  }
}
```

Notes:
- The output is WebM (VP8). The Composer re-encodes to H.264 MP4.
- Playwright names the file after an internal hash, so rename it to the contract's name.
- **Close the context on the failure path too.** The video file is finalised on close, so a
  crash that skips it leaves nothing rather than most of a video.
- t0 is approximate, and in practice small: **measured at about 130 ms** on a developer
  machine, and 134 ms on a real 57-second run. The `blackdetect` trick below is therefore not
  worth it - it would add a visible flash to the opening of every video to correct an error
  nobody can perceive. Record the number in `record.json` and let the Composer trim it; revisit
  only if the Composer's duration check starts failing.
- The old advice, kept for the day it is needed: for tighter sync, show a solid colour frame for
  ~200 ms at t0 and detect it with ffmpeg (`blackdetect`).
- Always sleep until each action's `at_ms` on a monotonic clock (`performance.now()`);
  never chain fixed sleeps, or drift accumulates.
- `(window as any)` is not needed: `src/recorder/page/global.d.ts` declares `window`, its `spr`
  shape and a minimal `document`, which is what lets `page.evaluate` callbacks type-check in a
  project with no DOM lib.
- Recording runs in **real time** - a 57-second video takes 57 seconds - so keep it out of unit
  suites and give any test that does record a generous timeout.

## Build the page

> Built against diff2html **3.4.56**, September 2026. `src/recorder/page.ts` is what actually
> runs; this is the notes behind it.

Bundles that ship in the package, with their sizes at 3.4.56:

| File | Size | Notes |
|---|---|---|
| `bundles/js/diff2html-ui.min.js` | 1.0 MB | Bundles highlight.js. What this project uses (ADR-030). |
| `bundles/js/diff2html-ui-slim.min.js` | 295 KB | Same UI, no syntax highlighting. The fallback if load time ever matters. |
| `bundles/js/diff2html-ui-base.min.js` | 88 KB | Base UI only. |
| `bundles/css/diff2html.min.css` | 17 KB | Required either way. |

The package also has a Node entry point - `html(diffInput, config)` from `diff2html`, typed -
which is what makes the row-tagging testable without a browser.

Rather than copying the bundles into a `vendor/` directory, `buildPage` inlines them, so the
page is one self-contained file with no network reference and no path to resolve (ADR-030).
**Escape the diff before embedding it**: `JSON.stringify` does not escape `/`, so a diff of an
HTML file containing `</script>` will close the tag.

```html
<link rel="stylesheet" href="vendor/diff2html.min.css">
<script src="vendor/diff2html-ui.min.js"></script>
<div id="diff"></div>
<script>
  const ui = new Diff2HtmlUI(document.getElementById('diff'), DIFF_TEXT, {
    drawFileList: false, matching: 'lines', outputFormat: 'line-by-line', colorScheme: 'dark'
  });
  ui.draw();
  // Then walk the rendered table and tag rows:
  // row.dataset.file, row.dataset.newLine, row.dataset.oldLine
  // so selectors become: tr[data-file="..."][data-new-line="19"]
  //
  // Both line attributes, never a single data-side: a context line exists on both sides at
  // numbers that differ once lines are added above it.
  //
  // A rename displays as src/{old.ts → new.ts}; expand it and take the new path, which is what
  // findings name.
</script>
```

## The `window.spr` API (injected)

```js
window.spr = {
  ready: true,
  run(action) {},                        // dispatches a timeline action to the methods below
  showTitle(text) {}, hideTitle() {},
  openFile(file) {},                     // collapse others, expand this file
  scrollTo(file, side, start, end) {},   // el.scrollIntoView({behavior:'smooth', block:'center'})
  highlight(file, side, start, end) {},  // add .spr-hl to rows; CSS outline + tinted background
  clear() {},
  showOutro(text) {},
};
```

The Recorder only calls `spr.run(action)`, so the timeline schema is the single interface
between Node and the page.

## Visual tips

- 1280x720, dark theme, 16 to 18 px monospace, generous line height. 17 px reads well.
- Highlight with a thick left border plus a soft background; animate over ~300 ms.
- `stickyFileHeaders: true` keeps the file name on screen, which is simpler than building a
  caption bar - but those headers carry their own stacking, so a full-screen card needs a
  `z-index` above them.
- Show the title card from the start rather than fading it in at t=0, or the video opens on a
  flash of diff and the pre-roll shows a bare page.

## The trap worth knowing about

`.d2h-code-linenumber` is `position: absolute`. With no positioned ancestor its containing
block is the document, which is fine when the document scrolls - code and gutter move together.
**Scroll an inner container instead and the numbers stay behind while the code moves**, so every
line number on screen is wrong. Give the rows `position: relative` so each number is anchored to
its own line. No DOM test can catch this (happy-dom does no layout); it is only visible by
looking at a rendered page.
