/**
 * What the outro card says (plan m2-step3, Q6).
 *
 * The card exists because a `wrap_up` step has `focus: null` - there is genuinely nothing on
 * the diff to look at while it plays, and without a card the screen sits on a de-highlighted
 * diff scrolled to whichever finding happened to be last, while the narration talks about all
 * of them. Given that it has to say something, it says something a viewer can pause on and
 * screenshot into the pull request, rather than a line of branding.
 *
 * Severity is not in `script.json`, so this reads the review. It returns a string, which is
 * what keeps `buildTimeline` a pure function of script, manifest and config rather than
 * something that needs a third file.
 */
import type { ReviewResult, Severity } from "../contracts/generated/review.js";

/** Most serious first, so the card reads the way the findings are ordered. */
const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

/**
 * One line summarising what was found, for example `2 issues to fix - 1 high, 1 medium`.
 *
 * A clean review says so in words rather than reporting zero of something.
 */
export function summarizeFindings(review: ReviewResult): string {
  const findings = review.findings;
  if (findings.length === 0) return "No issues found";

  const counts = new Map<Severity, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const breakdown = SEVERITY_ORDER.filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity) ?? 0} ${severity}`)
    .join(", ");

  const count = `${findings.length} ${findings.length === 1 ? "issue" : "issues"} to fix`;
  return `${count} - ${breakdown}`;
}
