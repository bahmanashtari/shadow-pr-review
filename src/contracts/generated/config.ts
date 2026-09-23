/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: config/config.schema.json. Regenerate with `pnpm gen:types`.
 */

/**
 * Tool configuration: config/default.json merged with SPR_* environment variables. Secrets never live here.
 */
export interface SprConfig {
  llm: {
    provider: "anthropic" | "ollama" | "fake";
    model: string;
    /**
     * Per-stage overrides of llm.model (ADR-057). A stage with no entry uses llm.model, so one model everywhere stays the default.
     */
    models?: {
      review?: string;
      verify?: string;
      narrate?: string;
    };
    baseUrl?: string;
    /**
     * Reasoning effort. Only the hosted Anthropic provider uses this; Ollama ignores it.
     */
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    /**
     * Let an Ollama model think before answering. Default true (ADR-021): equal recall, better grounding, about 15 times the wall clock. Set SPR_LLM_THINK=false when iterating on prompts.
     */
    think?: boolean;
    maxRetries: number;
    temperature: number;
  };
  budgets: {
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    agentSteps: number;
    wallClockSeconds: number;
  };
  ingest: {
    ignoreGlobs: string[];
    maxFileBytes: number;
    maxDiffBytes: number;
  };
  review: {
    maxRawFindings: number;
    maxFindings: number;
  };
  narration: {
    /**
     * Spoken words per narration step. The floor is 40 because checkScript also holds an intro or a wrap-up to 15 to 40 words (NARRATION_STYLE.md); a lower cap here would make those two rules contradict, and the Narrator could never satisfy both.
     */
    maxWordsPerStep: number;
    language: string;
  };
  tts: {
    provider: "kokoro-http" | "piper" | "fake";
    baseUrl: string;
    voice: string;
    speed: number;
  };
  video: {
    width: number;
    height: number;
    theme: "light" | "dark";
    gapMs: number;
    subtitles: "off" | "sidecar" | "burn";
  };
  runs: {
    dir: string;
  };
  /**
   * On-disk cache of LLM and TTS responses, keyed by a hash of the request. Shared across runs, so re-running a stage costs nothing.
   */
  cache: {
    enabled: boolean;
    dir: string;
  };
}
