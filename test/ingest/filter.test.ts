import { describe, expect, it } from "vitest";
import { classify } from "../../src/ingest/filter.js";
import type { ParsedFile } from "../../src/ingest/parse-diff.js";
import { configWithIngest, defaultConfig } from "../helpers.js";

function file(path: string, extra: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    old_path: null,
    status: "modified",
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    raw: "",
    bytes: 100,
    ...extra,
  };
}

const ingest = defaultConfig().ingest;

describe("classify", () => {
  it("skips binary files before anything else", () => {
    expect(classify(file("src/app.ts", { binary: true }), ingest)).toBe("binary");
  });

  it("skips a single file over maxFileBytes", () => {
    const big = file("src/app.ts", { bytes: ingest.maxFileBytes + 1 });
    expect(classify(big, ingest)).toBe("too_large");
    expect(classify(file("src/app.ts", { bytes: ingest.maxFileBytes }), ingest)).toBeNull();
  });

  it.each([
    ["pnpm-lock.yaml", "lockfile"],
    ["services/api/pnpm-lock.yaml", "lockfile"],
    ["packages/web/dist/main.js", "generated"],
    ["coverage/lcov-report/index.html", "generated"],
    ["src/api/generated/client.ts", "generated"],
    ["src/ui/__snapshots__/Button.test.tsx.snap", "generated"],
    ["public/js/app.min.js", "generated"],
    ["tools/node_modules/left-pad/index.js", "vendored"],
  ])("%s is skipped as %s", (path, reason) => {
    expect(classify(file(path), ingest)).toBe(reason);
  });

  it("keeps ordinary source files", () => {
    expect(
      classify(file("services/order-service/src/domain/order.aggregate.ts"), ingest),
    ).toBeNull();
  });

  it("keeps a generated-looking file that no glob matches", () => {
    // The config decides what is ignored; the categories only name the reason.
    expect(classify(file("src/schema.gen.ts"), ingest)).toBeNull();
    expect(classify(file("vendor/lib/thing.js"), ingest)).toBeNull();
  });

  it("reports an extra glob that fits no category as ignored_by_config", () => {
    const config = configWithIngest({ ignoreGlobs: ["**/*.md", "docs/**"] });
    expect(classify(file("README.md"), config.ingest)).toBe("ignored_by_config");
    expect(classify(file("docs/ARCHITECTURE.md"), config.ingest)).toBe("ignored_by_config");
    expect(classify(file("src/app.ts"), config.ingest)).toBeNull();
  });

  it("matches dotfiles", () => {
    const config = configWithIngest({ ignoreGlobs: ["**/.github/**"] });
    expect(classify(file(".github/workflows/ci.yml"), config.ingest)).toBe("ignored_by_config");
  });
});
