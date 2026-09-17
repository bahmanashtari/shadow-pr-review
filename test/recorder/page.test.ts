import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPage, escapeHtml, toScriptString } from "../../src/recorder/page.js";
import { loadSchema } from "../../src/contracts/schemas.js";
import { fromRoot } from "../../src/lib/paths.js";
import { GOLDEN_SAMPLES, readGoldenDiff } from "../helpers.js";

const OPTIONS = { title: "Review: a change", outro: "2 issues to fix - 1 high, 1 medium" };

function page(sample = GOLDEN_SAMPLES[0] ?? "sample-01-order-outbox"): string {
  return buildPage(readGoldenDiff(sample), OPTIONS);
}

describe("buildPage", () => {
  it("produces one document with no marker left in it", () => {
    const html = page();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/__SPR_[A-Z_]+__/);
  });

  it("inlines everything, so the page needs no network", () => {
    // The offline guarantee: this renders the same on a laptop and in a CI container.
    const html = page();
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?\/\//);
    // The diff2html bundle and stylesheet are really there, not merely referenced.
    expect(html).toContain("Diff2HtmlUI");
    expect(html).toContain("d2h-file-wrapper");
    expect(html.length).toBeGreaterThan(500_000);
  });

  it("carries the diff and this project's script", () => {
    const html = page();
    expect(html).toContain("window.spr.init(");
    expect(html).toContain("d2h-code-linenumber");
    expect(html).toContain("place-order.handler.ts");
  });

  it("is deterministic for the same diff and options", () => {
    expect(page()).toBe(page());
  });

  it.each(GOLDEN_SAMPLES)("builds for %s", (sample) => {
    expect(() => buildPage(readGoldenDiff(sample), OPTIONS)).not.toThrow();
  });
});

describe("escaping", () => {
  it("escapes a title so it cannot close a tag", () => {
    // A branch name is user-controlled and ends up on the title card.
    const html = buildPage("diff --git a/a.ts b/a.ts\n", {
      title: '</div><script>alert("x")</script>',
      outro: "1 issue to fix - 1 low",
    });
    expect(html).not.toContain('<script>alert("x")');
    expect(html).toContain("&lt;/div&gt;");
  });

  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
  ])("escapes %s", (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it("escapes a diff that closes a script tag", () => {
    // A diff of an HTML file really can contain this, and JSON.stringify does not escape "/".
    const diff = 'diff --git a/i.html b/i.html\n+  </script><script>alert("x")</script>\n';
    const literal = toScriptString(diff);
    expect(literal).not.toContain("</script>");
    expect(literal).toContain("<\\/script>");
    // Still the same string once JavaScript has parsed it.
    expect(JSON.parse(literal.replace(/<\\\//g, "</"))).toBe(diff);

    expect(buildPage(diff, OPTIONS)).not.toContain('</script><script>alert("x")');
  });
});

describe("the page script", () => {
  it("handles every action type the timeline contract defines", () => {
    // Asserted against the schema's own enum rather than a hand-written list, so a new action
    // type cannot join the contract without the page noticing.
    const timeline = loadSchema("timeline");
    const properties = timeline.properties as Record<string, unknown>;
    const actions = properties.actions as {
      items?: { properties?: { type?: { enum?: string[] } } };
    };
    const types = actions.items?.properties?.type?.enum ?? [];

    const source = readFileSync(fromRoot("src", "recorder", "page", "spr.js"), "utf8");
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) expect(source).toContain(`case "${type}":`);
  });
});

describe("the page stylesheet", () => {
  it("keeps the rule that anchors diff2html's absolute line numbers to their rows", () => {
    /*
     * A guard rather than a real test, because no DOM test can catch what this prevents:
     * happy-dom does no layout, so the bug this rule fixes - line numbers detaching from their
     * code while an inner container scrolls - is invisible to every assertion in this file. It
     * was found by looking at a rendered page, and this exists so a refactor does not quietly
     * delete the one line holding it together.
     */
    const css = readFileSync(fromRoot("src", "recorder", "page", "spr.css"), "utf8");
    expect(css).toMatch(/\.d2h-diff-tbody tr\s*\{[^}]*position:\s*relative/);
  });
});
