/**
 * @vitest-environment node
 *
 * The tagging test. This is the one place in the project where DOM behaviour is the product:
 * diff2html's class names move between versions, so the page tags rows itself and every
 * selector afterwards reads those tags. If an upgrade changes the markup, the page still
 * renders and the video still records - and nothing is ever highlighted. Only this catches it.
 *
 * It runs the *shipped* `spr.js`, evaluated into a DOM over diff2html's real output, so there
 * is no second implementation to drift.
 */
import { readFileSync } from "node:fs";
import { html } from "diff2html";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { fromRoot } from "../../src/lib/paths.js";
import { ingestOfDiff, readGoldenDiff, GOLDEN_SAMPLES } from "../helpers.js";

const SPR_JS = readFileSync(fromRoot("src", "recorder", "page", "spr.js"), "utf8");

/**
 * happy-dom's own document type. The project's tsconfig has no DOM lib - the page's script is
 * plain browser JavaScript for exactly that reason - so the type comes from the library that
 * provides the document rather than from a global.
 */
type Doc = Window["document"];

interface Spr {
  ready: boolean;
  tagRows(root?: unknown): { files: number; rows: number };
  newPathOf(displayed: string): string;
  highlight(file: string, side: string, start: number, end: number): void;
  clear(): void;
  run(action: unknown): void;
}

/** A window holding a rendered diff, with the page's own script evaluated into it. */
function render(diffText: string): { document: Doc; spr: Spr } {
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = html(diffText, {
    drawFileList: false,
    matching: "lines",
    outputFormat: "line-by-line",
  });
  (window as unknown as { eval(source: string): void }).eval(SPR_JS);
  const spr = (window as unknown as { spr: Spr }).spr;
  return { document: window.document, spr };
}

/** Reads a diff fixture from the parser's own fixture folder. */
function fixture(name: string): string {
  return readFileSync(fromRoot("test", "fixtures", "diffs", name), "utf8");
}

describe("tagRows", () => {
  it("makes every added line addressable by file and new-side number", () => {
    const sample = "sample-01-order-outbox";
    const { document, spr } = render(readGoldenDiff(sample));
    spr.tagRows(document);

    // Every added line ingest found must be reachable through the page's own attributes.
    const ingest = ingestOfDiff(readGoldenDiff(sample));
    for (const file of ingest.files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind !== "add" || line.new === null) continue;
          const row = document.querySelector(
            `tr[data-file="${file.path}"][data-new-line="${line.new}"]`,
          );
          expect(row, `${file.path}:${line.new}`).not.toBeNull();
        }
      }
    }
  });

  it("tags a context line on both sides, which is why there is no single data-side", () => {
    const { document, spr } = render(fixture("multi-hunk.patch"));
    spr.tagRows(document);

    const context = document.querySelector("tr[data-old-line][data-new-line]");
    expect(context).not.toBeNull();
    // A context line exists on both sides, at numbers that may differ once lines are added.
    expect(context?.getAttribute("data-old-line")).toBeTruthy();
    expect(context?.getAttribute("data-new-line")).toBeTruthy();
  });

  it("tags an added line with a new number and no old one", () => {
    const { document, spr } = render(fixture("multi-hunk.patch"));
    spr.tagRows(document);

    const added = document.querySelectorAll("tr[data-new-line]:not([data-old-line])");
    expect(added.length).toBeGreaterThan(0);
  });

  it("tags the file wrapper too, so open_file has something to scroll to", () => {
    const { document, spr } = render(readGoldenDiff("sample-02-inventory-consumer"));
    const stats = spr.tagRows(document);

    const wrappers = document.querySelectorAll(".d2h-file-wrapper[data-file]");
    expect(wrappers.length).toBe(stats.files);
    expect(stats.files).toBe(2);
  });

  it("reports how much it tagged", () => {
    const { document, spr } = render(readGoldenDiff("sample-01-order-outbox"));
    const stats = spr.tagRows(document);
    expect(stats.files).toBe(1);
    expect(stats.rows).toBeGreaterThan(30);
  });

  it.each(GOLDEN_SAMPLES)("tags every file of %s with its real path", (sample) => {
    const { document, spr } = render(readGoldenDiff(sample));
    spr.tagRows(document);

    const tagged = [...document.querySelectorAll(".d2h-file-wrapper[data-file]")].map((w) =>
      w.getAttribute("data-file"),
    );
    const expected = ingestOfDiff(readGoldenDiff(sample)).files.map((f) => f.path);
    expect(tagged.sort()).toEqual(expected.sort());
  });
});

describe("newPathOf", () => {
  it.each([
    // diff2html compacts a rename to a common prefix and a braced pair.
    ["src/{old-name.ts → new-name.ts}", "src/new-name.ts"],
    ["{a → b}/file.ts", "b/file.ts"],
    // No common prefix: both paths in full.
    ["old/a.ts → new/b.ts", "new/b.ts"],
    // The ordinary case is untouched.
    ["services/orders/src/domain/order.ts", "services/orders/src/domain/order.ts"],
    ["", ""],
  ])("%s -> %s", (displayed, expected) => {
    const { spr } = render("diff --git a/x b/x\n");
    expect(spr.newPathOf(displayed)).toBe(expected);
  });

  it("tags a renamed file with its new path, the one findings name", () => {
    const { document, spr } = render(fixture("rename-with-edits.patch"));
    spr.tagRows(document);

    const files = [...document.querySelectorAll(".d2h-file-wrapper[data-file]")].map((w) =>
      w.getAttribute("data-file"),
    );
    expect(files).toEqual(["src/new-name.ts"]);
    expect(files[0]).not.toContain("→");
  });
});

describe("highlight", () => {
  let dom: { document: Doc; spr: Spr };

  beforeEach(() => {
    dom = render(readGoldenDiff("sample-01-order-outbox"));
    dom.spr.tagRows(dom.document);
  });

  it("lights every row in a range, and marks its ends", () => {
    const file = "services/order-service/src/application/commands/place-order.handler.ts";
    dom.spr.highlight(file, "new", 2, 7);

    const lit = dom.document.querySelectorAll("tr.spr-hl");
    expect(lit.length).toBe(6);
    expect(dom.document.querySelectorAll("tr.spr-hl-first").length).toBe(1);
    expect(dom.document.querySelectorAll("tr.spr-hl-last").length).toBe(1);
  });

  it("clears everything it lit", () => {
    const file = "services/order-service/src/application/commands/place-order.handler.ts";
    dom.spr.highlight(file, "new", 2, 7);
    dom.spr.clear();

    expect(dom.document.querySelectorAll("tr.spr-hl").length).toBe(0);
    expect(dom.document.querySelectorAll("tr.spr-hl-first, tr.spr-hl-last").length).toBe(0);
  });

  it("does nothing, rather than throwing, for a range with no rows", () => {
    // A page that dies mid-recording produces a video of a stack trace.
    expect(() => {
      dom.spr.highlight("no/such/file.ts", "new", 1, 5);
      dom.spr.highlight(
        "services/order-service/src/application/commands/place-order.handler.ts",
        "new",
        9000,
        9100,
      );
    }).not.toThrow();
    expect(dom.document.querySelectorAll("tr.spr-hl").length).toBe(0);
  });

  it("ignores an action type it does not know, and a malformed one", () => {
    expect(() => {
      dom.spr.run({ type: "teleport", at_ms: 0, step_id: "S00" });
      dom.spr.run({});
      dom.spr.run(null);
    }).not.toThrow();
  });

  it("dispatches a real highlight action through run()", () => {
    dom.spr.run({
      at_ms: 0,
      step_id: "S01",
      type: "highlight",
      file: "services/order-service/src/application/commands/place-order.handler.ts",
      side: "new",
      line_start: 22,
      line_end: 22,
    });
    expect(dom.document.querySelectorAll("tr.spr-hl").length).toBe(1);
  });
});
