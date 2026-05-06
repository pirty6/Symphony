/**
 * perform-runner.ts — pure, side-effect-free executor for an
 * ExecutableScore.
 *
 * Shared by:
 *   - tools/maestro/engine.ts (interactive: pause/resume per beat)
 *   - tools/symphony/cli.ts `perform` (batch: consume an inputs file, emit Performance)
 *
 * The validators (`validateVoiceOutputs`, `validateVerdict`) and the
 * `stateHashFor` helper live here so both callers enforce identical
 * shape guarantees and produce identical content-hashed state.
 *
 * `runPerformance` is the batch entry point: given an ExecutableScore
 * and an array of PerformBeatInput records (one per beat), fold them
 * into a Performance. Inputs are validated per-beat with the same
 * rules the engine applies; the first failure aborts and returns
 * `{ kind: "failed", error, beatIndex }` so the caller can inspect.
 *
 * Distinct from the older `tools/symphony/perform.ts`:
 *   - perform.ts        — async callback-based scaffolding helper.
 *   - perform-runner.ts — synchronous fold over already-resolved inputs;
 *                         the actual executor used by both maestro and
 *                         the new `symphony perform` command.
 */

import * as crypto from "node:crypto";

import type {
  ExecutableScore,
  MoveVerdict,
  Performance,
  PerformedBeat,
  PerformedVoice,
} from "./types";
import {
  VOICE_PRODUCERS,
  validateVerdict,
  validateVoiceOutputs,
  type VoiceOutputInput,
  type VoiceProducer,
} from "./validation";

// ── Re-exports for back-compat ─────────────────────────────────────
// Older callers (maestro/engine.ts, tests) import these names from
// `./perform-runner`. Validators were extracted to `./validation` so
// the compiler can run them at generation time too; perform-runner
// keeps the names visible here.
export { VOICE_PRODUCERS, validateVoiceOutputs, validateVerdict };
export type { VoiceOutputInput, VoiceProducer };

// ── Inputs to the runner ───────────────────────────────────────────

export interface PerformBeatInput {
  readonly voiceOutputs: readonly VoiceOutputInput[];
  readonly verdict: MoveVerdict;
}

export type PerformanceResult =
  | { readonly kind: "ok"; readonly performance: Performance }
  | { readonly kind: "failed"; readonly error: string; readonly beatIndex: number };

export interface RunPerformanceOptions {
  readonly clock?: () => string;
}

// ── Hash + outcome derivation ──────────────────────────────────────

export function stateHashFor(scoreId: string, beatIndex: number): string {
  return crypto.createHash("sha256").update(`engine:${scoreId}:${beatIndex}`).digest("hex");
}

export function deriveOutcome(
  beats: readonly PerformedBeat[],
  terminatedEarly: boolean,
): Performance["outcome"] {
  if (beats.length === 0) {
    return "in-progress";
  }
  if (beats.some((b) => b.verdict?.outcome === "failed")) {
    return "failed";
  }
  if (terminatedEarly) {
    const last = beats[beats.length - 1].verdict;
    return last?.outcome === "applied" ? "success" : "partial";
  }
  // No beat was actually applied (all skipped) — the run completed its
  // shape but produced no work. Refuse to call that "success".
  if (!beats.some((b) => b.verdict?.outcome === "applied")) {
    return "partial";
  }
  return "success";
}

// ── Batch executor ─────────────────────────────────────────────────

function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Pure batch executor. Folds `inputs` over `score.beats`, applying the
 * same shape validation the maestro engine enforces. Stops early on
 * `verdict.shouldTerminate=true`.
 *
 * Constraints:
 *   - `inputs.length` must equal `score.beats.length` UNLESS an earlier
 *     beat sets `verdict.shouldTerminate=true`. A short input list with
 *     no early termination returns `failed` rather than silently
 *     producing a partial Performance — the runner refuses to invent
 *     missing beats.
 */
export function runPerformance(
  score: ExecutableScore,
  inputs: readonly PerformBeatInput[],
  opts: RunPerformanceOptions = {},
): PerformanceResult {
  const clock = opts.clock ?? defaultClock;
  const startedAt = clock();
  if (inputs.length === 0) {
    return { kind: "failed", error: "inputs must be a non-empty array", beatIndex: 0 };
  }
  if (inputs.length > score.beats.length) {
    return {
      kind: "failed",
      error: `inputs length ${inputs.length} > score.beats length ${score.beats.length}`,
      beatIndex: score.beats.length,
    };
  }

  const beats: PerformedBeat[] = [];
  let terminatedEarly = false;

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const beat = score.beats[i];
    const shapeErr = validateVoiceOutputs(input.voiceOutputs, beat);
    if (shapeErr) {
      return { kind: "failed", error: shapeErr, beatIndex: i };
    }
    const verdictErr = validateVerdict(input.verdict);
    if (verdictErr) {
      return { kind: "failed", error: verdictErr, beatIndex: i };
    }
    const performed: PerformedBeat = {
      beatIndex: i,
      voices: input.voiceOutputs.map<PerformedVoice>((v) => ({
        instrument: v.instrument as PerformedVoice["instrument"],
        output: v.output,
        confidence: v.confidence,
        producedBy: v.producedBy,
      })),
      verdict: input.verdict,
      stateHash: stateHashFor(score.id, i),
    };
    beats.push(performed);
    if (input.verdict.shouldTerminate) {
      terminatedEarly = true;
      break;
    }
  }

  if (!terminatedEarly && beats.length < score.beats.length) {
    return {
      kind: "failed",
      error: `inputs exhausted at beat ${beats.length} but score has ${score.beats.length} beats and no shouldTerminate=true was set`,
      beatIndex: beats.length,
    };
  }

  const performance: Performance = {
    scoreId: score.id,
    beats,
    startedAt,
    completedAt: clock(),
    outcome: deriveOutcome(beats, terminatedEarly),
  };
  return { kind: "ok", performance };
}
