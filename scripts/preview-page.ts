/**
 * Builds a run folder's page and prints where it went, so it can be opened and looked at.
 *
 * A development aid rather than a pipeline stage: the Recorder (Milestone 2 step 4) builds the
 * same page itself when it records. This exists because step 3's output is judged by eye, and
 * because "show me the page for this run without recording it" stays useful for debugging
 * afterwards.
 *
 *   pnpm tsx scripts/preview-page.ts runs/<id>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPage, PAGE_FILE } from "../src/recorder/page.js";

const runDir = process.argv[2];
if (runDir === undefined) {
  console.error("usage: pnpm tsx scripts/preview-page.ts <run folder>");
  process.exit(1);
}

const resolved = path.resolve(runDir);
const diff = readFileSync(path.join(resolved, "diff.patch"), "utf8");
const html = buildPage(diff);
const out = path.join(resolved, PAGE_FILE);
writeFileSync(out, html, "utf8");

console.log(`${out}  (${(html.length / 1024).toFixed(0)} KB)`);
