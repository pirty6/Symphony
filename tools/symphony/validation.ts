/**
 * validation.ts — Single-source validators for Score and Performance shapes.
 *
 * Three checks lived in two places before this module was extracted:
 *
 *   - `validateVoiceOutputs` and `validateVerdict` were defined in
 *     `perform-runner.ts` and consumed there + by maestro/engine.
 *   - `validateScoreShape` was a private function in `symphony/cli.ts`
 *     used only at score-load time.
 *
 * Centralizing them here:
 *   1. Lets the compiler use `validateScoreShape` at generation time
 *      so legality errors surface where the mistake was made.
 *   2. Removes the maestro \u2192 perform-runner indirection for callers
 *      that only need shape checks (no execution).
 *   3. Gives every error message a single home.
 *
 * Pure functions. No I/O.
 */

import { beatLegality } from "./legality";
import {
  INSTRUMENTS,
  type Beat,
  type ExecutableScore,
  type MoveVerdict,
} from "./types";

// ── Voice producer enum (mirrored from perform-runner) ─────────────

export const VOICE_PRODUCERS = ["maestro-assessor", "maestro-executor"] as const;
export type VoiceProducer = (typeof VOICE_PRODUCERS)[number];

// ── Voice output input shape ───────────────────────────────────────

export interface VoiceOutputInput {
  readonly instrument: string;
  readonly output: string;
  readonly confidence: number;
  readonly producedBy: VoiceProducer;
}

// ── Validators ─────────────────────────────────────────────────────

export function validateVoiceOutputs(
  outputs: readonly Partial<VoiceOutputInput>[],
  beat: Beat,
): string | undefined {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return "voiceOutputs must be a non-empty array";
  }
  if (outputs.length !== beat.voices.length) {
    return `voiceOutputs length ${outputs.length} != beat.voices length ${beat.voices.length}`;
  }
  for (let i = 0; i < outputs.length; i += 1) {
    const v = outputs[i];
    if (typeof v?.instrument !== "string" || v.instrument === "") {
      return `voiceOutputs[${i}].instrument must be a non-empty string`;
    }
    if (!(INSTRUMENTS as readonly string[]).includes(v.instrument)) {
      return `voiceOutputs[${i}].instrument '${v.instrument}' is not one of: ${INSTRUMENTS.join(", ")}`;
    }
    if (typeof v?.output !== "string") {
      return `voiceOutputs[${i}].output must be a string`;
    }
    if (
      typeof v?.confidence !== "number" ||
      Number.isNaN(v.confidence) ||
      v.confidence < 0 ||
      v.confidence > 1
    ) {
      return `voiceOutputs[${i}].confidence must be a number in [0,1]`;
    }
    if (
      typeof v?.producedBy !== "string" ||
      !(VOICE_PRODUCERS as readonly string[]).includes(v.producedBy)
    ) {
      return `voiceOutputs[${i}].producedBy must be one of: ${VOICE_PRODUCERS.join(", ")}`;
    }
  }
  return undefined;
}

export function validateVerdict(v: MoveVerdict): string | undefined {
  if (!v) {
    return "verdict required";
  }
  if (!["applied", "failed", "skipped"].includes(v.outcome)) {
    return `verdict.outcome invalid: ${String(v.outcome)}`;
  }
  if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) {
    return "verdict.confidence must be a number in [0,1]";
  }
  if (typeof v.reason !== "string") {
    return "verdict.reason must be a string";
  }
  if (typeof v.shouldTerminate !== "boolean") {
    return "verdict.shouldTerminate must be boolean";
  }
  return undefined;
}

/**
 * Shape + legality checks on a fully-formed `ExecutableScore`.
 * Returns the list of validation errors; empty array means the score
 * is valid. Used by `symphony verify` at score-load time. The compiler
 * runs an equivalent legality check at generation time via
 * `assertBeatsLegal` in `tools/compiler/compile.ts`.
 */
export function validateScoreShape(score: ExecutableScore): string[] {
  const errors: string[] = [];
  if (score.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${score.schemaVersion}`);
  }
  score.beats.forEach((beat: Beat, idx: number) => {
    if (beat.voices.length === 0) {
      errors.push(`beat ${idx}: must have at least one voice`);
    }
    if (beatLegality(beat.level, beat.voices) === "illegal") {
      errors.push(
        `beat ${idx}: illegal (level=${beat.level}, voices=${beat.voices
          .map((v) => v.instrument)
          .join("+")})`,
      );
    }
  });
  return errors;
}
