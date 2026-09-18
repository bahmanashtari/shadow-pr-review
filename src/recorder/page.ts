/**
 * Builds the page the Recorder drives: one self-contained HTML file.
 *
 * Everything is inlined - the diff2html bundle, both stylesheets, this project's browser
 * script and the diff itself - so the page has no network reference and no relative path to
 * resolve. That is what lets it render identically on a laptop and in an offline CI container,
 * and it means the artifact can be opened, attached to a bug report or handed to someone as a
 * single file.
 *
 * The alternative, copying `bundles/` into a gitignored `vendor/` directory at build time, buys
 * nothing here and adds a build step that has to have run before any recording.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { StageError } from "../lib/errors.js";
import { fromRoot } from "../lib/paths.js";

/** The page's own files, which ship to the browser as they are. */
const PAGE_DIR = fromRoot("src", "recorder", "page");

/**
 * The full UI bundle, which carries highlight.js: about 1 MB against 295 KB for
 * `diff2html-ui-slim.min.js`. The whole point of the video is reading code on screen, so code
 * should look like code, and the cost is a local file read rather than a download.
 */
const BUNDLE = "bundles/js/diff2html-ui.min.js";
const BUNDLE_CSS = "bundles/css/diff2html.min.css";

/** Markers the template carries, each replaced exactly once. */
const MARKERS = {
  css: "__SPR_CSS__",
  js: "__SPR_JS__",
  bundleCss: "__SPR_DIFF2HTML_CSS__",
  bundleJs: "__SPR_DIFF2HTML_JS__",
  diff: "__SPR_DIFF_JSON__",
} as const;

/** Resolves a file inside the installed diff2html package. */
function diff2htmlFile(relative: string): string {
  const require = createRequire(import.meta.url);
  try {
    // Resolving the package's own entry point, then walking up from it, works whether the
    // dependency is hoisted, nested or pnpm-linked.
    const entry = require.resolve("diff2html");
    const root = entry.slice(0, entry.lastIndexOf(`${path.sep}lib${path.sep}`));
    return path.join(root, ...relative.split("/"));
  } catch (cause) {
    throw new StageError("record", `Cannot find the diff2html package. Run \`pnpm install\`.`, {
      cause,
    });
  }
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    throw new StageError("record", `Cannot read a file the page needs: ${file}`, { cause });
  }
}

/**
 * A JavaScript string literal safe to sit inside a `<script>` tag.
 *
 * `JSON.stringify` alone is not enough: it does not escape `/`, so a diff that touches an HTML
 * file and contains `</script>` would close the tag and put the rest of the patch into the
 * document as markup.
 */
export function toScriptString(text: string): string {
  return JSON.stringify(text).replace(/<\//g, "<\\/");
}

/**
 * Refuses to inline code that would close its own tag.
 *
 * The installed diff2html bundle contains no such sequence, and escaping arbitrary minified
 * JavaScript is not safe to do blindly - `<\/` is only valid inside a string or a regex - so
 * this fails loudly instead, and a future version that breaks the assumption says so.
 */
function assertInlinable(what: string, code: string, closer: string): void {
  if (code.includes(closer)) {
    throw new StageError(
      "record",
      `${what} contains "${closer}", so it cannot be inlined into the page safely.`,
    );
  }
}

/**
 * Turns a unified diff into the page that renders it.
 *
 * @param diffText the contents of `diff.patch`.
 * @returns a complete HTML document.
 */
export function buildPage(diffText: string): string {
  const template = read(path.join(PAGE_DIR, "index.html"));
  const css = read(path.join(PAGE_DIR, "spr.css"));
  const js = read(path.join(PAGE_DIR, "spr.js"));
  const bundleJs = read(diff2htmlFile(BUNDLE));
  const bundleCss = read(diff2htmlFile(BUNDLE_CSS));

  assertInlinable("The diff2html bundle", bundleJs, "</script");
  assertInlinable("The page script", js, "</script");
  assertInlinable("The diff2html stylesheet", bundleCss, "</style");
  assertInlinable("The page stylesheet", css, "</style");

  return template
    .replace(MARKERS.bundleCss, () => bundleCss)
    .replace(MARKERS.css, () => css)
    .replace(MARKERS.bundleJs, () => bundleJs)
    .replace(MARKERS.js, () => js)
    .replace(MARKERS.diff, () => toScriptString(diffText));
}

/** File the page is written to, relative to the run folder. */
export const PAGE_FILE = "page.html";
