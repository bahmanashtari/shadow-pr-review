/**
 * Deterministic path heuristics that rank a changed file's risk.
 * Used to order files for the Reviewer and to decide what survives the diff size budget.
 * Scores come from the whole path, matched case-insensitively; every matching rule adds up.
 */

/** One entry of the risk table. */
export interface RiskRule {
  /** Short name, used in tests and when explaining a score. */
  readonly name: string;
  /** Points added when {@link matches} is true. May be negative. */
  readonly points: number;
  /** Tested against the lowercased, forward-slash path. */
  readonly matches: (path: string) => boolean;
}

/** True when the path has `name` as one of its `/`-separated segments. */
function hasSegment(path: string, ...names: readonly string[]): boolean {
  const segments = path.split("/");
  return names.some((name) => segments.includes(name));
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

const EVENT_WORDS = [
  "consumer",
  "producer",
  "publisher",
  "subscriber",
  "handler",
  "listener",
  "outbox",
  "inbox",
  "saga",
  "process-manager",
  "event",
] as const;

const SECURITY_WORDS = [
  "auth",
  "guard",
  "permission",
  "policy",
  "security",
  "crypto",
  "token",
] as const;

/** The risk table, in table order. Exported so a unit test can pin every rule. */
export const RISK_RULES: readonly RiskRule[] = [
  {
    name: "migration",
    points: 5,
    matches: (p) => hasSegment(p, "migration", "migrations") || p.endsWith(".sql"),
  },
  { name: "domain", points: 4, matches: (p) => hasSegment(p, "domain") },
  {
    name: "messaging",
    points: 4,
    matches: (p) => EVENT_WORDS.some((w) => basename(p).includes(w)),
  },
  {
    name: "security",
    points: 4,
    matches: (p) => SECURITY_WORDS.some((w) => p.includes(w)),
  },
  {
    name: "infrastructure",
    points: 2,
    matches: (p) =>
      hasSegment(p, "infrastructure") ||
      p.includes(".github/workflows/") ||
      basename(p) === "dockerfile" ||
      basename(p).startsWith("dockerfile.") ||
      basename(p).includes("docker-compose") ||
      basename(p) === ".env" ||
      basename(p).startsWith(".env.") ||
      /\.config\./.test(basename(p)),
  },
  { name: "source", points: 1, matches: (p) => p.endsWith(".ts") && hasSegment(p, "src") },
  {
    name: "tests",
    points: -2,
    matches: (p) =>
      p.endsWith(".spec.ts") ||
      p.endsWith(".test.ts") ||
      hasSegment(p, "test", "tests", "__tests__"),
  },
  { name: "docs", points: -3, matches: (p) => p.endsWith(".md") || hasSegment(p, "docs") },
];

/** Names of every rule that fires for `path`, in table order. */
export function matchedRules(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return RISK_RULES.filter((rule) => rule.matches(normalized)).map((rule) => rule.name);
}

/** Sums every matching rule. Higher means the file deserves more review attention. */
export function riskScore(path: string): number {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return RISK_RULES.reduce(
    (total, rule) => (rule.matches(normalized) ? total + rule.points : total),
    0,
  );
}
