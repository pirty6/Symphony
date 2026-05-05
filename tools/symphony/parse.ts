/**
 * parse.ts — Minimal algorithm → Score parser.
 *
 * Closes the gap between maestro's debate output (an agreed list of
 * steps with verb-noun annotations) and Symphony's Score artifact.
 *
 * No phase loop, no LLM, no classification — maestro already did that
 * work. This is a deterministic shape converter:
 *
 *   AlgorithmInput { problem, domain, steps[], annotations[] }
 *     ↓
 *   Score { schemaVersion, id, frequencyMap, tempo, beats, generatedFrom, ... }
 *
 * FrequencyMap.levels is derived from the beat histogram so the caller
 * never authors amplitudes by hand. The caller only authors what
 * maestro's debate produces: steps and (verb, level, instrument) tuples.
 */

import { fingerprintProblem, computeScoreId } from "./persistence";
import {
  DOMINANCE_THRESHOLD,
  LEVELS,
  type Beat,
  type Conservatism,
  type DomainKey,
  type FrequencyMap,
  type InstrumentType,
  type Level,
  type Score,
  type Shape,
  type TempoConfig,
  type Voice,
} from "./types";

// ── Input ──────────────────────────────────────────────────────────

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

export interface AlgorithmInput {
  /** Raw user prompt; fed to fingerprintProblem. */
  readonly problem: string;
  /** Domain key for FrequencyMap.key (e.g., "typescript/investigate"). */
  readonly domain: DomainKey;
  readonly steps: readonly AlgorithmStep[];
  readonly annotations: readonly AlgorithmAnnotation[];
  /** Optional. Defaults to { conservatism: "balanced", beatsPerMeasure: 3 }. */
  readonly tempo?: TempoConfig;
  /** Optional. Defaults to "layered". */
  readonly shape?: Shape;
  /** Optional. Defaults to new Date().toISOString(). Override for determinism in tests. */
  readonly generatedAt?: string;
}

// ── Derivation ─────────────────────────────────────────────────────

function buildFrequencyMap(
  beats: readonly Beat[],
  domain: DomainKey,
  shape: Shape,
): FrequencyMap {
  const counts: Record<Level, number> = {
    1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0,
  };
  for (const beat of beats) counts[beat.level]++;
  const total = beats.length;

  const levels: Record<Level, number> = {
    1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0,
  };
  for (const level of LEVELS) {
    levels[level] = total === 0 ? 0 : counts[level] / total;
  }

  const dominantLevels = LEVELS.filter(
    (l) => levels[l] >= DOMINANCE_THRESHOLD,
  );

  return { levels, dominantLevels, shape, key: domain };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert an agreed algorithm into a Score.
 *
 * Throws if any step lacks a matching annotation, or if any annotation
 * references a verb not in the steps. Both are caller errors —
 * maestro's debate output should never produce mismatches.
 */
export function parseAlgorithm(input: AlgorithmInput): Score {
  if (input.steps.length === 0) {
    throw new Error("parseAlgorithm: steps array is empty");
  }

  const annotationsByVerb = new Map<string, AlgorithmAnnotation>();
  for (const annotation of input.annotations) {
    if (annotationsByVerb.has(annotation.verb)) {
      throw new Error(
        `parseAlgorithm: duplicate annotation for verb "${annotation.verb}"`,
      );
    }
    annotationsByVerb.set(annotation.verb, annotation);
  }

  const usedVerbs = new Set<string>();
  const beats: Beat[] = input.steps.map((step) => {
    const annotation = annotationsByVerb.get(step.verb);
    if (!annotation) {
      throw new Error(
        `parseAlgorithm: step "${step.verb}" has no matching annotation`,
      );
    }
    usedVerbs.add(step.verb);
    const voices: readonly Voice[] = [{ instrument: annotation.instrument }];
    return {
      level: annotation.level,
      voices,
      directive: step.directive,
    };
  });

  for (const verb of annotationsByVerb.keys()) {
    if (!usedVerbs.has(verb)) {
      throw new Error(
        `parseAlgorithm: annotation "${verb}" has no matching step`,
      );
    }
  }

  const tempo: TempoConfig =
    input.tempo ?? { conservatism: "balanced" as Conservatism, beatsPerMeasure: 3 };
  const shape: Shape = input.shape ?? "layered";

  const frequencyMap = buildFrequencyMap(beats, input.domain, shape);
  const generatedFrom = fingerprintProblem(input.problem);

  const partial: Omit<Score, "id" | "generatedAt"> = {
    schemaVersion: 1,
    frequencyMap,
    tempo,
    beats,
    generatedFrom,
  };
  const id = computeScoreId(partial);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  return { ...partial, id, generatedAt };
}
