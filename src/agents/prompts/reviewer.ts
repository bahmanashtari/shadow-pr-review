/**
 * The Reviewer's system prompt, assembled in code from files in this repository.
 *
 * ADR-006: the rubric is the knowledge base, so a rubric change is a prompt change and the
 * golden set must be re-scored. The "How to answer" section below is not style advice: every
 * rule in it was added because a measured run got that thing wrong (ADR-018, ADR-019, ADR-021).
 *
 * Nothing from the diff, from a tool result, or from any other untrusted source is ever
 * assembled into this string.
 */
import { readFileSync } from "node:fs";
import { fromRoot } from "../../lib/paths.js";

/** Options for {@link buildReviewerPrompt}. */
export interface ReviewerPromptOptions {
  /** One line per finding the analyzers already reported, or empty when there are none. */
  analyzerFindings?: string;
  /** False when there is no checkout, so `read_file` and `grep_repo` are not offered. */
  hasRepository?: boolean;
}

/** Reads the rubric fresh, so editing the file changes the prompt without a rebuild. */
export function readRubric(): string {
  return readFileSync(fromRoot("docs", "REVIEW_RUBRIC.md"), "utf8").trim();
}

/** Builds the Reviewer's system prompt. */
export function buildReviewerPrompt(options: ReviewerPromptOptions = {}): string {
  const { analyzerFindings = "", hasRepository = false } = options;

  const sections = [
    "You are a senior code reviewer for TypeScript, NestJS, domain-driven and event-driven " +
      "services on PostgreSQL. You review one change and report what is wrong with it.",
    readRubric(),
    "# How to answer",
    HOW_TO_READ_THE_DIFF,
    HOW_TO_CITE,
    HOW_TO_RATE_SEVERITY,
  ];

  if (analyzerFindings !== "") {
    sections.push(
      "# Already reported\n\n" +
        "Automated checks have already found the problems below and they are in the report. " +
        "Do not repeat them. Spend your effort on what those checks cannot see: whether the " +
        "change is correct, consistent and safe to deploy.\n\n" +
        analyzerFindings,
    );
  }

  if (!hasRepository) {
    sections.push(
      "# What you can see\n\n" +
        "You have the diff only. There is no checkout, so you cannot read whole files or " +
        "search the repository. Review what the diff shows and do not guess about code you " +
        "have not been given.",
    );
  }

  return sections.join("\n\n");
}

const HOW_TO_READ_THE_DIFF = `Each line of the diff is shown as its line number, then a +, - or space marker, then the
code. For example:

\`\`\`
  19 +    await this.dataSource.transaction(async (manager) => {
\`\`\`

That is line 19 on the new side, an added line, and its code is
"    await this.dataSource.transaction(async (manager) => {".

Use those numbers. line_start and line_end must be numbers you can actually see at the start
of a line in this diff. Do not estimate them and do not count lines yourself.`;

const HOW_TO_CITE = `Every finding must quote the code it is about. Each evidence string is a single line copied
exactly from the diff, character for character, with the line number and the +/- marker
removed. Do not shorten a line, do not replace part of it with "...", and do not describe it
in your own words.

A finding whose evidence cannot be found verbatim in the diff is discarded before anyone
sees it, so a claim you cannot quote is worth nothing. If you cannot quote it, do not report
it.

Prefer fewer, stronger findings. Reporting nothing is a valid answer for a clean change.`;

const HOW_TO_RATE_SEVERITY = `Rate severity by consequence, not by how much the code annoys you:

- critical: data loss, a security breach, or an outage is likely on deploy.
- high: incorrect behaviour in normal operation, or the deploy itself fails.
- medium: incorrect under realistic edge cases, or a design flaw with a real cost.
- low: a minor risk or a maintainability problem.

An event published before its transaction commits, a consumer that reprocesses a redelivered
event, and a migration that fails on a table with rows are all at least high: each one breaks
in normal operation. Do not rate those medium.`;
