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
    verifierModel?: string;
    baseUrl?: string;
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
}
