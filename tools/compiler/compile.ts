/**
 * compile.ts — Compiler: PatternScore + problem + context → Score.
 *
 * Two entry points, mirroring the two authoring paths:
 *
 *   compileScore(pattern, { problem, context })
 *     The preferred path. Pure function: same inputs → same Score
 *     (modulo `generatedAt`). Validates `context` against the Pattern's
 *     `requiredContext` and copies the static directives from
 *     `pattern.score.beats` verbatim into the executable Score.
 *
 *   parseAlgorithm(input)
 *     Low-level fallback. Caller authors steps and annotations directly.
 *     Used when the user-edited algorithm diverged from any pattern
 *     (extra steps, custom verbs). Maestro should rarely need this.
 *
 * No phase loop, no LLM, no classification — maestro already did that
 * work. Pure deterministic shape conversion.
 *
 * The directive on each beat is **static prose** authored on the
 * Pattern. Repo-specific knobs live on `Score.context`, not interpolated
 * into directive text. The agent at execution time reads the directive
 * and the context together.
 */

import { fingerprintProblem, computeExecutableScoreId } from "../symphony/persistence";
import { beatLegality, pairRationale } from "../symphony/legality";
import {
  LEVEL_ACTIVITY_THRESHOLD,
  LEVELS,
  type Beat,
  type DomainKey,
  type FrequencyMap,
  type InstrumentType,
  type Level,
  type ExecutableScore,
  type Voice,
} from "../symphony/types";
import type { Pattern, PatternScore } from "../patterns/types";

// ── Low-level Algorithm input ──────────────────────────────────────

export interface AlgorithmStep {
  /** Verb identifier matching an annotation entry (e.g., "clarify"). */
  readonly verb: string;
  /** The full directive text for this beat. */
  readonly directive: string;
}

export interface AlgorithmAnnotation {
  readonly verb: string;
  readonly level: Level;
  readonly instrument: InstrumentType;
}

/**
 * Provenance metadata recorded on an `AlgorithmInput` when it was
 * derived from a registered (or freshly drafted) Pattern. Carried
 * through to the resulting `ExecutableScore.pattern` so a saved run
 * can be traced back to the pattern that authored it.
 */
export interface AlgorithmProvenance {
  /** Pattern name as on `PatternScore.pattern`. */
  readonly pattern: string;
}

export interface AlgorithmInput {
  /** Raw user prompt; fed to fingerprintProblem. */
  readonly problem: string;
  /** Domain key for FrequencyMap.key (e.g., "typescript/investigate"). */
  readonly domain: DomainKey;
  readonly steps: readonly AlgorithmStep[];
  readonly annotations: readonly AlgorithmAnnotation[];
  /**
   * Repo-specific knobs the executing agent reads alongside each
   * directive. Propagated verbatim to `ExecutableScore.context`.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Optional provenance: which pattern (if any) authored this algorithm. */
  readonly provenance?: AlgorithmProvenance;
  readonly generatedAt?: string;
}

// ── Derivation ─────────────────────────────────────────────────────

function buildFrequencyMap(beats: readonly Beat[], domain: DomainKey): FrequencyMap {
  const counts: Record<Level, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
  };
  for (const beat of beats) {
    counts[beat.level] += 1;
  }
  const total = beats.length;

  const activeLevels =
    total === 0 ? [] : LEVELS.filter((l) => counts[l] / total >= LEVEL_ACTIVITY_THRESHOLD);

  return { key: domain, activeLevels };
}

function patternBeatsToBeats(score: PatternScore): readonly Beat[] {
  return score.beats.map((pb) => {
    const voices: readonly Voice[] = [{ instrument: pb.instrument }];
    return { level: pb.level, voices, directive: pb.directive };
  });
}

/**
 * Reject any beat whose (level, instrument) pair is illegal per the
 * legality matrix. Catches authoring mistakes at score-generation
 * time instead of waiting for the load-time validator in `symphony
 * verify`. Pure read-only check; throws with the offending beat
 * index, level, instruments, and the rule's rationale.
 */
function assertBeatsLegal(beats: readonly Beat[], where: string): void {
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (beatLegality(beat.level, beat.voices) !== "illegal") {
      continue;
    }
    const offending = beat.voices.find(
      (v) => pairRationale(beat.level, v.instrument) !== undefined,
    );
    const rationale = offending ? pairRationale(beat.level, offending.instrument) : undefined;
    const voiceList = beat.voices.map((v) => v.instrument).join("+");
    throw new Error(
      `${where}: beat ${i} is illegal (level=${beat.level}, voices=${voiceList})` +
        (rationale ? ` \u2014 ${rationale}` : ""),
    );
  }
}

// ── Pattern path ───────────────────────────────────────────────────

export interface CompileArgs {
  /** Raw user prompt; fed to fingerprintProblem. */
  readonly problem: string;
  /**
   * Repo-specific keys the pattern may consume at execution time
   * (target, invariant, scope, contract, etc.). Validated against
   * `pattern.requiredContext`.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Optional. Override for determinism in tests. */
  readonly generatedAt?: string;
}

/**
 * Compile a Pattern + concrete inputs into an executable Score.
 *
 * Validates the supplied `context` against `pattern.requiredContext`.
 * Throws when a required key is missing or empty.
 */
export function compileScore(pattern: Pattern, args: CompileArgs): ExecutableScore {
  const context = args.context ?? {};
  for (const key of pattern.requiredContext) {
    const value = context[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      throw new Error(`compileScore: pattern "${pattern.score.pattern}" requires context.${key}`);
    }
  }

  const beats = patternBeatsToBeats(pattern.score);
  assertBeatsLegal(beats, `compileScore: pattern "${pattern.score.pattern}"`);
  const frequencyMap = buildFrequencyMap(beats, pattern.score.domain);
  const generatedFrom = fingerprintProblem(args.problem);

  const partial: Omit<ExecutableScore, "id" | "generatedAt"> = {
    schemaVersion: 1,
    frequencyMap,
    beats,
    generatedFrom,
    pattern: pattern.score.pattern,
    context: { ...context },
  };
  const id = computeExecutableScoreId(partial);
  const generatedAt = args.generatedAt ?? new Date().toISOString();

  return { ...partial, id, generatedAt };
}

// ── Low-level Algorithm path (fallback) ────────────────────────────

/**
 * Convert an explicit algorithm into a Score. Used when the user-edited
 * algorithm diverged from any pattern. Throws on step/annotation
 * mismatches — those are caller errors.
 */
export function parseAlgorithm(input: AlgorithmInput): ExecutableScore {
  if (input.steps.length === 0) {
    throw new Error("parseAlgorithm: steps array is empty");
  }

  const annotationsByVerb = new Map<string, AlgorithmAnnotation>();
  for (const annotation of input.annotations) {
    if (annotationsByVerb.has(annotation.verb)) {
      throw new Error(`parseAlgorithm: duplicate annotation for verb "${annotation.verb}"`);
    }
    annotationsByVerb.set(annotation.verb, annotation);
  }

  const usedVerbs = new Set<string>();
  const beats: Beat[] = input.steps.map((step) => {
    const annotation = annotationsByVerb.get(step.verb);
    if (!annotation) {
      throw new Error(`parseAlgorithm: step "${step.verb}" has no matching annotation`);
    }
    usedVerbs.add(step.verb);
    const voices: readonly Voice[] = [{ instrument: annotation.instrument }];
    return { level: annotation.level, voices, directive: step.directive };
  });

  for (const verb of annotationsByVerb.keys()) {
    if (!usedVerbs.has(verb)) {
      throw new Error(`parseAlgorithm: annotation "${verb}" has no matching step`);
    }
  }

  assertBeatsLegal(beats, "parseAlgorithm");

  const frequencyMap = buildFrequencyMap(beats, input.domain);
  const generatedFrom = fingerprintProblem(input.problem);

  const base: Omit<ExecutableScore, "id" | "generatedAt"> = {
    schemaVersion: 1,
    frequencyMap,
    beats,
    generatedFrom,
  };
  const partial: Omit<ExecutableScore, "id" | "generatedAt"> = {
    ...base,
    ...(input.provenance ? { pattern: input.provenance.pattern } : {}),
    ...(input.context ? { context: { ...input.context } } : {}),
  };
  const id = computeExecutableScoreId(partial);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  return { ...partial, id, generatedAt };
}

// ── Pattern → AlgorithmInput (uniform handoff) ─────────────────────

/**
 * Derive a free-form `AlgorithmInput` from a Pattern + concrete inputs.
 *
 * Mirrors `compileScore` — same context validation, same beat→step
 * mapping — but emits the lower-level Algorithm shape instead of a
 * compiled Score. Used by `maestro plan` to write an editable
 * `algorithm.json` artifact that `symphony parse` consumes.
 *
 * Provenance (`{ pattern: pattern.score.pattern }`) is attached so
 * the resulting Score can still be traced back to the authoring
 * Pattern even though the handoff format is uniform.
 */
export function algorithmFromPattern(pattern: Pattern, args: CompileArgs): AlgorithmInput {
  const context = args.context ?? {};
  for (const key of pattern.requiredContext) {
    const value = context[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      throw new Error(
        `algorithmFromPattern: pattern "${pattern.score.pattern}" requires context.${key}`,
      );
    }
  }
  const steps: readonly AlgorithmStep[] = pattern.score.beats.map((pb) => ({
    verb: pb.step,
    directive: pb.directive,
  }));
  // Annotations are unique per verb. A pattern may legally repeat a
  // step name across beats only if the (level, instrument) tuple
  // matches; otherwise the algorithm is ambiguous and parseAlgorithm
  // would reject it downstream — surface that here instead.
  const seen = new Map<string, AlgorithmAnnotation>();
  for (const pb of pattern.score.beats) {
    const prior = seen.get(pb.step);
    const next: AlgorithmAnnotation = {
      verb: pb.step,
      level: pb.level,
      instrument: pb.instrument,
    };
    if (prior && (prior.level !== next.level || prior.instrument !== next.instrument)) {
      throw new Error(
        `algorithmFromPattern: pattern "${pattern.score.pattern}" has step "${pb.step}" with conflicting (level, instrument) across beats`,
      );
    }
    seen.set(pb.step, next);
  }
  const annotations: readonly AlgorithmAnnotation[] = Array.from(seen.values());
  return {
    problem: args.problem,
    domain: pattern.score.domain,
    steps,
    annotations,
    context: { ...context },
    provenance: { pattern: pattern.score.pattern },
    ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
  };
}
