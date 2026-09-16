import { describe, expect, it } from "vitest";
import { analyze, describeForPrompt } from "../../src/analyzers/analyze.js";
import { importedModule, layerOf, RULES } from "../../src/analyzers/rules.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { HunkIndex } from "../../src/ingest/hunk-index.js";
import type { IngestResult, Source } from "../../src/contracts/generated/ingest.js";
import { GOLDEN_SAMPLES, defaultConfig, readGoldenDiff } from "../helpers.js";

const SOURCE: Source = {
  type: "local_diff",
  repo: null,
  pr_number: null,
  ref: null,
  base_sha: null,
  head_sha: null,
  title: null,
};

/** Builds an ingest from a synthetic "new file" containing exactly these lines. */
function ingestOf(file: string, lines: readonly string[]): IngestResult {
  const body = lines.map((l) => `+${l}`).join("\n");
  const rawDiff =
    `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n` +
    `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  return buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() }).ingest;
}

const rulesFired = (file: string, lines: readonly string[]): string[] =>
  analyze(ingestOf(file, lines)).map((f) => f.rule);

const DOMAIN = "services/orders/src/domain/order.aggregate.ts";
const APPLICATION = "services/orders/src/application/commands/place-order.handler.ts";
const MIGRATION = "services/orders/src/infrastructure/migrations/1700000000000-Add.ts";

describe("layerOf", () => {
  it.each([
    [DOMAIN, "domain"],
    [APPLICATION, "application"],
    ["src/infrastructure/persistence/order.entity.ts", "infrastructure"],
    ["src/interface/http/order.controller.ts", "interface"],
    ["src/shared/util.ts", null],
  ])("%s -> %s", (path, expected) => {
    expect(layerOf(path)).toBe(expected);
  });
});

describe("importedModule", () => {
  it.each([
    ["import { DataSource } from 'typeorm';", "typeorm"],
    ['import type { X } from "../x";', "../x"],
    ["import 'reflect-metadata';", "reflect-metadata"],
    ["export { Order } from './order';", "./order"],
    ["const x = 1;", null],
  ])("%s", (line, expected) => {
    expect(importedModule(line)).toBe(expected);
  });
});

describe("domain-imports-infrastructure", () => {
  it.each([
    "import { Entity } from 'typeorm';",
    "import { Injectable } from '@nestjs/common';",
    "import { OrderEntity } from '../../infrastructure/persistence/order.entity';",
    "import { Dto } from '../interface/http/order.dto';",
  ])("fires on %s", (line) => {
    expect(rulesFired(DOMAIN, [line])).toContain("domain-imports-infrastructure");
  });

  it.each([
    "import { Money } from './money';",
    "import { DomainError } from '../errors/domain.error';",
    "import { randomUUID } from 'node:crypto';",
    "const repository = this.orders;",
  ])("stays quiet on %s", (line) => {
    expect(rulesFired(DOMAIN, [line])).toEqual([]);
  });

  it("does not fire outside the domain layer", () => {
    expect(rulesFired("src/shared/db.ts", ["import { Entity } from 'typeorm';"])).toEqual([]);
  });
});

describe("application-imports-orm", () => {
  it.each([
    "import { DataSource } from 'typeorm';",
    "import { OrderEntity } from '../../infrastructure/persistence/order.entity';",
  ])("fires on %s", (line) => {
    expect(rulesFired(APPLICATION, [line])).toContain("application-imports-orm");
  });

  it.each([
    "import { OrderRepository } from '../../domain/order.repository';",
    "import { CommandHandler } from '@nestjs/cqrs';",
  ])("stays quiet on %s", (line) => {
    // NestJS in the application layer is normal; only the domain must stay clean.
    expect(rulesFired(APPLICATION, [line])).toEqual([]);
  });
});

describe("not-null-without-default", () => {
  it("fires on a NOT NULL column added to an existing table", () => {
    expect(
      rulesFired(MIGRATION, ['`ALTER TABLE "stock_item" ADD COLUMN "qty" integer NOT NULL`,']),
    ).toContain("not-null-without-default");
  });

  it("stays quiet when the same migration creates that table", () => {
    // A NOT NULL column on a brand new table is correct, not a bug.
    expect(
      rulesFired(MIGRATION, [
        '`CREATE TABLE "stock_item" (id uuid PRIMARY KEY)`,',
        '`ALTER TABLE "stock_item" ADD COLUMN "qty" integer NOT NULL`,',
      ]),
    ).toEqual([]);
  });

  it("stays quiet when a default is given, or the column is nullable", () => {
    expect(
      rulesFired(MIGRATION, ['`ALTER TABLE "s" ADD COLUMN "q" integer NOT NULL DEFAULT 0`,']),
    ).toEqual([]);
    expect(rulesFired(MIGRATION, ['`ALTER TABLE "s" ADD COLUMN "q" integer`,'])).toEqual([]);
  });
});

describe("index-without-concurrently", () => {
  it("fires on a plain CREATE INDEX", () => {
    expect(rulesFired(MIGRATION, ['`CREATE INDEX "idx_sku" ON "stock_item" ("sku")`,'])).toContain(
      "index-without-concurrently",
    );
  });

  it("stays quiet on CONCURRENTLY", () => {
    expect(
      rulesFired(MIGRATION, ['`CREATE INDEX CONCURRENTLY "idx_sku" ON "stock_item" ("sku")`,']),
    ).toEqual([]);
  });
});

describe("empty-down", () => {
  it("fires on an empty body and not on a real one", () => {
    expect(
      rulesFired(MIGRATION, ["public async down(queryRunner: QueryRunner): Promise<void> {}"]),
    ).toContain("empty-down");
    expect(
      rulesFired(MIGRATION, ["public async down(queryRunner: QueryRunner): Promise<void> {"]),
    ).toEqual([]);
  });
});

describe("sql-string-interpolation", () => {
  it("fires when a value is interpolated into a query", () => {
    expect(
      rulesFired(MIGRATION, ["await queryRunner.query(`SELECT * FROM users WHERE id = ${id}`);"]),
    ).toContain("sql-string-interpolation");
  });

  it("stays quiet on a template literal that is not SQL", () => {
    expect(rulesFired(MIGRATION, ["throw new Error(`Invalid email: ${raw}`);"])).toEqual([]);
  });

  it("stays quiet on SQL with no interpolation", () => {
    // The golden migration uses a template literal with no substitution.
    expect(
      rulesFired(MIGRATION, [
        '`ALTER TABLE "stock_item" ADD COLUMN "q" integer NOT NULL DEFAULT 0`,',
      ]),
    ).toEqual([]);
  });
});

describe("analyze", () => {
  it("gives every finding an exact quote and a real line", () => {
    for (const sample of GOLDEN_SAMPLES) {
      const { ingest } = buildIngest({
        rawDiff: readGoldenDiff(sample),
        source: SOURCE,
        config: defaultConfig(),
      });
      const index = HunkIndex.fromIngest(ingest);
      for (const finding of analyze(ingest)) {
        expect(
          index.hasRange(finding.file, "new", finding.line_start, finding.line_end),
          `${sample} ${finding.rule} range`,
        ).toBe(true);
        for (const snippet of finding.evidence) {
          expect(index.containsSnippet(finding.file, snippet), `${sample} ${finding.rule}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("finds the layer violation both models missed", () => {
    const { ingest } = buildIngest({
      rawDiff: readGoldenDiff("sample-01-order-outbox"),
      source: SOURCE,
      config: defaultConfig(),
    });
    const findings = analyze(ingest);
    expect(findings.map((f) => f.rule)).toEqual([
      "application-imports-orm",
      "application-imports-orm",
    ]);
    expect(findings.map((f) => f.line_start)).toEqual([2, 7]);
  });

  it("finds the migration problems in sample 02", () => {
    const { ingest } = buildIngest({
      rawDiff: readGoldenDiff("sample-02-inventory-consumer"),
      source: SOURCE,
      config: defaultConfig(),
    });
    expect(analyze(ingest).map((f) => f.rule)).toEqual(["not-null-without-default", "empty-down"]);
  });

  it("reports nothing on the sample that exists to test restraint", () => {
    const { ingest } = buildIngest({
      rawDiff: readGoldenDiff("sample-03-email-value-object"),
      source: SOURCE,
      config: defaultConfig(),
    });
    expect(analyze(ingest)).toEqual([]);
  });

  it("is deterministic and runs every rule by default", () => {
    const ingest = ingestOf(APPLICATION, ["import { DataSource } from 'typeorm';"]);
    expect(analyze(ingest)).toEqual(analyze(ingest));
    expect(RULES.map((r) => r.key)).toEqual([
      "domain-imports-infrastructure",
      "application-imports-orm",
      "not-null-without-default",
      "index-without-concurrently",
      "empty-down",
      "sql-string-interpolation",
    ]);
  });

  it("only ever looks at added lines", () => {
    const rawDiff =
      `diff --git a/${DOMAIN} b/${DOMAIN}\nindex 111..222 100644\n--- a/${DOMAIN}\n+++ b/${DOMAIN}\n` +
      `@@ -1 +1 @@\n-import { Entity } from 'typeorm';\n+import { Money } from './money';\n`;
    const { ingest } = buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() });
    // The typeorm import is being removed, which is the opposite of a problem.
    expect(analyze(ingest)).toEqual([]);
  });
});

describe("describeForPrompt", () => {
  it("lists one line per finding and nothing at all for none", () => {
    const ingest = ingestOf(APPLICATION, ["import { DataSource } from 'typeorm';"]);
    expect(describeForPrompt(analyze(ingest))).toBe(
      `- ${APPLICATION}:1 [medium/ddd-boundaries] Application layer depends directly on the ORM or a persistence entity`,
    );
    expect(describeForPrompt([])).toBe("");
  });
});
