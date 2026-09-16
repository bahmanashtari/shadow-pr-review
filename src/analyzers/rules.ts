/**
 * Deterministic review rules, read straight off the diff text.
 *
 * ADR-002 says plain code handles everything that is not judgement. An import statement or a
 * SQL string is a fact, not an opinion, and the model trial (ADR-018) showed models missing
 * exactly those: every run missed a layer violation that is one `import` line.
 *
 * Every rule quotes the line it fired on, so its evidence is exact by construction and the
 * Verifier's `containsSnippet` cannot fail on it.
 */
import type { Category, Severity } from "../contracts/generated/review.js";

/** One rule's verdict about one line. */
export interface RuleHit {
  severity: Severity;
  category: Category;
  summary: string;
  rationale: string;
  suggestion: string;
}

/** What a rule can see: one added line, plus the whole file for context. */
export interface RuleContext {
  /** Repo-relative path of the file the line belongs to. */
  path: string;
  /** The DDD layer the path sits in, when it has one. */
  layer: Layer | null;
  /** Text of the added line, without its marker. */
  text: string;
  /** Every added line of this file, so a rule can look for a counterpart. */
  addedLines: readonly string[];
}

/** A deterministic rule. */
export interface Rule {
  /** Stable identifier, used in tests and in the trace. */
  key: string;
  check(context: RuleContext): RuleHit | null;
}

/** The DDD layers the rubric cares about. */
export type Layer = "domain" | "application" | "infrastructure" | "interface";

const LAYERS: readonly Layer[] = ["domain", "application", "infrastructure", "interface"];

/** Which layer a file is in, from its path segments. */
export function layerOf(path: string): Layer | null {
  const segments = path.toLowerCase().split("/");
  return LAYERS.find((layer) => segments.includes(layer)) ?? null;
}

/** Packages that mean persistence rather than business rules. */
const ORM_PACKAGE = /^(typeorm|@mikro-orm\/|mikro-orm|prisma|@prisma\/|sequelize|mongoose|knex)/;
/** Packages that mean framework or transport rather than business rules. */
const FRAMEWORK_PACKAGE = /^(@nestjs\/|amqplib|kafkajs|ioredis|@golevelup\/nestjs)/;

const IMPORT = /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/;
/** `import 'side-effect'` and `export ... from '...'` count too. */
const BARE_IMPORT = /^\s*(?:import|export)\s[^'"]*['"]([^'"]+)['"]/;

/** The module specifier an added line imports, or null when it is not an import. */
export function importedModule(text: string): string | null {
  return IMPORT.exec(text)?.[1] ?? BARE_IMPORT.exec(text)?.[1] ?? null;
}

function segmentsInclude(module: string, ...names: readonly string[]): boolean {
  const parts = module.toLowerCase().split("/");
  return names.some((name) => parts.includes(name));
}

/** SQL keywords that make a template literal a query rather than a message. */
const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|FROM|WHERE|VALUES)\b/i;

export const RULES: readonly Rule[] = [
  {
    key: "domain-imports-infrastructure",
    check: ({ layer, text }) => {
      if (layer !== "domain") return null;
      const module = importedModule(text);
      if (module === null) return null;
      const orm = ORM_PACKAGE.test(module);
      const framework = FRAMEWORK_PACKAGE.test(module);
      const crossLayer = segmentsInclude(module, "infrastructure", "interface");
      if (!orm && !framework && !crossLayer) return null;
      return {
        severity: "high",
        category: "ddd-boundaries",
        summary: "Domain layer imports infrastructure or a framework",
        rationale:
          "The domain layer must not depend on the ORM, the framework, the broker client, or " +
          "the infrastructure and interface layers. This import makes the domain impossible to " +
          "unit test without that dependency and lets persistence concerns leak into business rules.",
        suggestion:
          "Define a port (an interface) in the domain for what is needed here and implement it " +
          "in infrastructure, injecting it by token.",
      };
    },
  },
  {
    key: "application-imports-orm",
    check: ({ layer, text }) => {
      if (layer !== "application") return null;
      const module = importedModule(text);
      if (module === null) return null;
      if (!ORM_PACKAGE.test(module) && !segmentsInclude(module, "infrastructure")) return null;
      return {
        severity: "medium",
        category: "ddd-boundaries",
        summary: "Application layer depends directly on the ORM or a persistence entity",
        rationale:
          "Application services and command handlers orchestrate; they should not use the ORM " +
          "or an infrastructure entity directly. This couples the use case to persistence and " +
          "makes it hard to test without a database.",
        suggestion:
          "Depend on a repository port defined in the domain, and keep the ORM and the mapping " +
          "between domain objects and entities inside infrastructure.",
      };
    },
  },
  {
    key: "not-null-without-default",
    check: ({ text, addedLines }) => {
      if (!/ADD\s+COLUMN/i.test(text)) return null;
      if (!/NOT\s+NULL/i.test(text) || /DEFAULT/i.test(text)) return null;
      // A NOT NULL column on a table created by the same migration is correct.
      const table = /ADD\s+COLUMN[\s\S]*?/i.test(text)
        ? /ALTER\s+TABLE\s+"?([\w.]+)"?/i.exec(text)?.[1]
        : undefined;
      if (table !== undefined) {
        const creates = new RegExp(
          `CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?`,
          "i",
        );
        if (addedLines.some((line) => creates.test(line))) return null;
      }
      return {
        severity: "high",
        category: "data-migration",
        summary: "Migration adds a NOT NULL column with no default",
        rationale:
          "On PostgreSQL, ADD COLUMN ... NOT NULL without DEFAULT fails when the table already " +
          "has rows, so this migration will break the deploy on any environment with data.",
        suggestion:
          "Add the column as nullable, backfill it in batches, then set NOT NULL; or give it a " +
          "DEFAULT if every existing row should share one value.",
      };
    },
  },
  {
    key: "index-without-concurrently",
    check: ({ text }) => {
      if (!/CREATE\s+(UNIQUE\s+)?INDEX/i.test(text) || /CONCURRENTLY/i.test(text)) return null;
      return {
        severity: "medium",
        category: "data-migration",
        summary: "Index is created without CONCURRENTLY",
        rationale:
          "CREATE INDEX takes a lock that blocks writes for the duration of the build, which on " +
          "a large table means downtime during the deploy.",
        suggestion:
          "Use CREATE INDEX CONCURRENTLY, remembering it cannot run inside a transaction, so the " +
          "migration's per-migration transaction has to be turned off.",
      };
    },
  },
  {
    key: "empty-down",
    check: ({ text }) => {
      if (!/\bdown\s*\([^)]*\)\s*:\s*Promise\s*<\s*void\s*>\s*\{\s*\}/.test(text)) return null;
      return {
        severity: "low",
        category: "data-migration",
        summary: "Migration cannot be reverted because down() is empty",
        rationale:
          "An empty down() means this migration cannot be rolled back, so a bad deploy has to be " +
          "fixed forward under pressure.",
        suggestion:
          "Reverse what up() did, or throw with an explicit message saying the change is " +
          "deliberately irreversible.",
      };
    },
  },
  {
    key: "sql-string-interpolation",
    check: ({ text }) => {
      // Only a template literal that looks like SQL and interpolates a value.
      if (!text.includes("${") || !SQL_KEYWORD.test(text)) return null;
      if (!/`/.test(text)) return null;
      return {
        severity: "critical",
        category: "security",
        summary: "SQL is built by string interpolation",
        rationale:
          "Interpolating a value into SQL rather than passing it as a parameter is how SQL " +
          "injection happens. Even when today's caller passes something safe, the next one may not.",
        suggestion:
          "Pass the value as a query parameter, for example queryRunner.query(sql, [value]), and " +
          "keep the SQL itself a constant string.",
      };
    },
  },
];
