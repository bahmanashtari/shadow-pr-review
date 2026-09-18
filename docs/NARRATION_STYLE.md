# Narration style

Rules for the Narrator agent. The script is heard, not read.

## Voice and tone

- A friendly, experienced colleague walking through the change. Direct, calm, specific.
- Plain spoken English. Short sentences. Contractions are fine ("it's", "that's").
- Say why it matters, then what to do. No lectures, no hedging stacks ("might possibly perhaps").
- Never mention being an AI, the model, the rubric, or confidence scores.

## Length

- About 150 words per minute, which is close to what the voice measures at (ADR-034).
- Intro and wrap-up: 15 to 40 words each.
- A finding usually takes 40 to 60 words, because that is what saying all three beats costs.
  60 is a hard limit; 40 is not. A genuinely small point can be shorter and often should be -
  padding a minor finding to reach a number is worse than a short step. A finding with a real
  consequence that comes out at 25 words has skipped the consequence.
- Whole video: the format runs from about 25 seconds for a single-finding change to about five
  minutes for a full review of ten. **A short video for a small change is correct, not a
  failure.** Length follows how many findings there are, far more than how much is said about
  each: this line used to say "1 to 5 minutes", which no run reached and which two of the
  hand-written golden scripts also fail (ADR-028, ADR-034).

## Structure

1. Intro: what the change does, how many things you found, and how serious.
2. One step per finding, in severity order. Start with a short transition:
   "First, the most important one." / "Next," / "A smaller point." / "Last, a small one."
3. Wrap-up: what to fix before merging, what can wait, a short thanks.
   If there are no findings: say the change looks good and name one or two things done well.

## Speaking code

- Describe code, don't read it. Say "the place order handler", not "PlaceOrderHandler dot ts".
- Split identifiers into words: `reserved_quantity` -> "the reserved quantity column".
- Never read file paths, extensions, line numbers, brackets or operators. The screen shows them.
- A very short literal is fine when it matters: "a default of zero".
- Acronyms: say "Postgres", "Nest", "D T O", "C Q R S" (the TTS stage also normalizes these).

## Forbidden in `text`

- Markdown (`*`, `#`, backticks, bullet lists), URLs, emojis, code blocks.
- Anything not supported by the finding. The Narrator does not add new issues.

## Examples

Bad:
> "In `order-placed.consumer.ts` lines 14-18, the `handle()` method invokes
> `this.stock.decrement()` without idempotency safeguards, which, given at-least-once
> delivery semantics, may potentially result in duplicate decrements."

Good:
> "Let's start with the consumer. Messages can be delivered more than once, but this
> handler decrements stock every time it runs. So a single retry means the order is
> counted twice. Keep a record of processed events, and skip anything you've already handled."
