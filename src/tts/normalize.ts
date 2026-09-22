/**
 * What the speech engine is actually given (ADR-027).
 *
 * Pure, and tested on its own, because it decides two things at once: how a clip sounds, and
 * what its cache key is. The manifest defines `cache_key` over the *normalized* text, so two
 * scripts differing only in something this erases share a clip.
 *
 * It handles pronunciation, not sanitisation. `checkScript` has already guaranteed that no
 * markdown, file name, path or URL reaches here (ADR-024), so there is nothing to defend
 * against - only the handful of words an English voice says wrong, which
 * `docs/NARRATION_STYLE.md` names.
 *
 * The map lives in code because it is small, versioned with the code that applies it, and
 * fixed by that document. Milestone 4 will want it configurable, when the tool meets service
 * names and internal acronyms no built-in map could predict; `tts.pronunciations` in the
 * config schema is where it goes, through the `--file` / `SPR_CONFIG` mechanism that already
 * exists. Knowing where it goes is not a reason to build it now.
 */

/** One rewrite: a pattern over the spoken text, and what to say instead. */
export interface Pronunciation {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Spell an acronym out, keeping a plural audible: `DTOs` becomes `D T O s`, which an English
 * voice reads "dee tee oh ess". The separated trailing `s` is the whole point - attached,
 * `Os` gets read as a word. The singular picks up a trailing space that the whitespace
 * collapse at the end of {@link normalizeForSpeech} removes.
 */
function spelled(acronym: string): Pronunciation {
  return {
    pattern: new RegExp(`\\b${acronym}(s)?\\b`, "g"),
    // Every character but the last gains a space after it: `DTO` becomes `D T O`. The
    // acronyms here are ASCII, so there are no surrogate pairs to split.
    replacement: `${acronym.replace(/(.)(?=.)/g, "$1 ")} $1`,
  };
}

/**
 * The pronunciation map, exactly the cases `docs/NARRATION_STYLE.md` fixes.
 *
 * The Narrator is told to write "Nest", "Postgres", "D T O" and "C Q R S" itself, so in a
 * good script most of this never fires. It is the backstop for the script where it does.
 */
export const PRONUNCIATIONS: readonly Pronunciation[] = [
  // Before the bare-acronym rules, so the JS suffix is not left stranded.
  { pattern: /\bNestJS\b/g, replacement: "Nest J S" },
  { pattern: /\bPostgreSQL\b/gi, replacement: "Postgres" },
  spelled("DTO"),
  spelled("CQRS"),
];

/**
 * A camelCase identifier is one word to the voice and several to a listener. Kokoro's
 * phonemizer turns `toHaveBeenCalledOnce` into `təhˌævbˌɪnkˈɔldwˈʌns` - the right sounds with
 * no word boundaries - where `to have been called once` gives `tə hæv bɪn kˈɔld wˈʌns`. So the
 * boundary is put back for the voice only, at each lowercase-to-uppercase step: the subtitle
 * and the script keep the identifier as it is written (ADR-055).
 *
 * Runs of capitals are left alone, so `TypeORM` becomes `Type ORM` rather than `Type O R M`.
 */
const CAMEL_CASE = /([a-z0-9])([A-Z])/g;

/** Backticks are silent to a reader and noise to a voice; the words between them survive. */
const BACKTICKS = /`/g;

/** A slash is spoken, not skipped: "read/write" becomes "read slash write". */
const SLASH = /\s*\/\s*/g;

/** Any run of whitespace, including the newlines a wrapped answer may carry. */
const WHITESPACE = /\s+/g;

/**
 * Turns a script step's spoken text into what the engine should receive.
 *
 * Whitespace is collapsed last and always: a clip must not miss its cache because the model
 * wrapped a line differently. The camelCase split runs after the pronunciation map, so
 * `NestJS` is already `Nest J S` and never becomes `Nest JS`.
 *
 * @param text one step's `text` from `script.json`.
 * @returns the text to synthesize, and to hash into the cache key.
 */
export function normalizeForSpeech(text: string): string {
  let out = text.replace(BACKTICKS, "");
  for (const { pattern, replacement } of PRONUNCIATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(CAMEL_CASE, "$1 $2").replace(SLASH, " slash ").replace(WHITESPACE, " ").trim();
}
