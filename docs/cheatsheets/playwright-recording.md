# Cheat sheet: Playwright recording with diff2html

> Snapshot written September 2026. Verify against playwright.dev (Node.js) and the
> diff2html README. Class names in diff2html output can change between versions: tag
> rows yourself (below) instead of relying on them.

## Install

```bash
pnpm add playwright          # the library; @playwright/test is not needed
pnpm exec playwright install --with-deps chromium
```

Container option: the official Playwright Node image
(`mcr.microsoft.com/playwright:v<version>-<distro>`, match the npm package version)
plus `apt-get install -y ffmpeg`.

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
- t0 is approximate. For tighter sync, show a solid color frame for ~200 ms at t0 and
  detect it with ffmpeg (`blackdetect`), or accept up to ~100 ms drift.
- Always sleep until each action's `at_ms` on a monotonic clock (`performance.now()`);
  never chain fixed sleeps, or drift accumulates.
- `(window as any)` is confined to this file; declare a `Window` interface in
  `recorder/page/global.d.ts` to remove it.

## Build the page

diff2html is available on npm (`diff2html`) with a browser bundle and CSS. Copy the
bundle and CSS from `node_modules/diff2html/bundles/` into the page at build time (no CDN
at render time) so CI is offline-safe. Verify the bundle paths for your version.

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

- 1280x720, dark theme, 16 to 18 px monospace, generous line height.
- Highlight with a thick left border plus a soft background; animate over ~300 ms.
- A small caption bar with the file name and severity badge helps orientation.
