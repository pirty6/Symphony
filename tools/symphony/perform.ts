/**
 * perform.ts — Minimal Score executor.
 *
 * Takes a Score (the plan maestro produced) and a per-beat executor
 * function (the cognitive work, supplied by the caller — typically an
 * agent harness) and produces a Performance (the recording).
 *
 * No LLM in this module. The repo's runtime is intentionally
 * LLM-free; the executor callback is the seam where an agent harness
 * (or a human) supplies the actual beat work.
 *
 * Two entry points:
 *   - performScore(score, executeBeat)  — full execution, async
 *   - scaffoldPerformance(score)        — empty Performance ready to fill
 *
 * Pairs with parseAlgorithm: maestro debate -> parseAlgorithm -> Score
 * -> performScore -> Performance -> persistence.saveRun.
 */

import * as crypto from "node:crypto";

import type {
  Beat,
  MoveVerdict,
  Performance,
  PerformanceOutcome,
  PerformedBeat,
  PerformedVoice,
  ExecutableScore,
} from "./types";

// ── Executor callback ──────────────────────────────────────────────

export interface BeatExecutorContext {
  readonly beatIndex: number;
  readonly beat: Beat;
  readonly score: ExecutableScore;
  readonly previous: readonly PerformedBeat[];
}

export interface BeatExecutorResult {
  readonly voices: readonly PerformedVoice[];
  readonly verdict: MoveVerdict | undefined;
  /** Optional. If omitted, defaults to a hash of (scoreId + beatIndex). */
  readonly stateHash?: string;
}

export type BeatExecutor = (
  ctx: BeatExecutorContext,
) => BeatExecutorResult | Promise<BeatExecutorResult>;

// ── Public API ─────────────────────────────────────────────────────

/**
 * Execute a Score by invoking `executeBeat` once per beat, in order.
 *
 * Termination:
 *   - if any verdict has shouldTerminate=true, remaining beats are
 *     not executed and the Performance outcome is set per the final
 *     verdict's outcome.
 *   - otherwise all beats run; outcome derived from verdict mix
 *     (any 'failed' -> 'failed', else 'success'; all-null -> 'partial').
 */
export async function performScore(
  score: ExecutableScore,
  executeBeat: BeatExecutor,
  clock: () => string = () => new Date().toISOString(),
): Promise<Performance> {
  const startedAt = clock();
  const performed: PerformedBeat[] = [];
  let terminatedEarly = false;

  for (let i = 0; i < score.beats.length; i += 1) {
    const beat = score.beats[i];
    const result = await executeBeat({
      beatIndex: i,
      beat,
      score,
      previous: performed,
    });
    const stateHash = result.stateHash ?? defaultStateHash(score.id, i);
    performed.push({
      beatIndex: i,
      voices: result.voices,
      verdict: result.verdict,
      stateHash,
    });
    if (result.verdict?.shouldTerminate) {
      terminatedEarly = true;
      break;
    }
  }

  const outcome = deriveOutcome(performed, terminatedEarly);

  return {
    scoreId: score.id,
    beats: performed,
    startedAt,
    completedAt: clock(),
    outcome,
  };
}

/**
 * Build a Performance scaffold with one empty PerformedBeat per Score
 * beat. Useful when the executor is a human or an external agent that
 * fills the file directly. Outcome is 'in-progress'.
 */
export function scaffoldPerformance(
  score: ExecutableScore,
  clock: () => string = () => new Date().toISOString(),
): Performance {
  const beats: PerformedBeat[] = score.beats.map((beat, i) => ({
    beatIndex: i,
    voices: beat.voices.map((voice) => ({
      instrument: voice.instrument,
      output: "",
      confidence: 0,
    })),
    verdict: undefined,
    stateHash: defaultStateHash(score.id, i),
  }));
  return {
    scoreId: score.id,
    beats,
    startedAt: clock(),
    completedAt: undefined,
    outcome: "in-progress",
  };
}

// ── Internals ──────────────────────────────────────────────────────

function defaultStateHash(scoreId: string, beatIndex: number): string {
  return crypto.createHash("sha256").update(`scaffold:${scoreId}:${beatIndex}`).digest("hex");
}

function deriveOutcome(
  beats: readonly PerformedBeat[],
  terminatedEarly: boolean,
): PerformanceOutcome {
  if (beats.length === 0) {
    return "in-progress";
  }
  const verdicts = beats.map((b) => b.verdict);
  if (verdicts.every((v) => v === null)) {
    return "partial";
  }
  if (verdicts.some((v) => v?.outcome === "failed")) {
    return "failed";
  }
  if (terminatedEarly) {
    const last = verdicts[verdicts.length - 1];
    if (last?.outcome === "applied") {
      return "success";
    }
    if (last?.outcome === "failed") {
      return "failed";
    }
    return "partial";
  }
  return "success";
}
