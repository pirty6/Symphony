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

import { fingerprintProblem, computeExecutableScoreId } from "./persistence";
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
  /** Optional. Defaults to new Date().toISOString(). Override for determinism in tests. */
  readonly generatedAt?: string;
}

// ── Derivation ─────────────────────────────────────────────────────

function buildFrequencyMap(
  beats: readonly Beat[],
  domain: DomainKey,
): FrequencyMap {
  const counts: Record<Level, number> = {
    1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0,
  };
  for (const beat of beats) {counts[beat.level] += 1;}
  const total = beats.length;

  const activeLevels = total === 0
    ? []
    : LEVELS.filter((l) => counts[l] / total >= LEVEL_ACTIVITY_THRESHOLD);

  return { key: domain, activeLevels };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert an agreed algorithm into a Score.
 *
 * Throws if any step lacks a matching annotation, or if any annotation
 * references a verb not in the steps. Both are caller errors —
 * maestro's debate output should never produce mismatches.
 */
export function parseAlgorithm(input: AlgorithmInput): ExecutableScore {
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

  const frequencyMap = buildFrequencyMap(beats, input.domain);
  const generatedFrom = fingerprintProblem(input.problem);

  const partial: Omit<ExecutableScore, "id" | "generatedAt"> = {
    schemaVersion: 1,
    frequencyMap,
    beats,
    generatedFrom,
  };
  const id = computeExecutableScoreId(partial);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  return { ...partial, id, generatedAt };
}
