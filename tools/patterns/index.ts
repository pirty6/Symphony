/**
 * index.ts — PatternLibrary registry.
 *
 * Single source of truth for "which patterns exist". Maestro's Setup
 * phase calls `getPattern` after picking a pattern by verb-trigger.
 * The compiler calls it to validate pattern names on parse.
 */

import type { Pattern } from "./types";
import { investigatePattern } from "./investigate";
import { refactorPattern } from "./refactor";
import { featurePattern } from "./feature";

const ENTRIES: readonly Pattern[] = [
  investigatePattern,
  refactorPattern,
  featurePattern,
];

const BY_NAME: ReadonlyMap<string, Pattern> = new Map(
  ENTRIES.map((p) => [p.score.pattern, p]),
);

export function getPattern(name: string): Pattern | undefined {
  return BY_NAME.get(name);
}

export function listPatterns(): readonly Pattern[] {
  return ENTRIES;
}

export { investigatePattern, refactorPattern, featurePattern };
export type {
  Pattern,
  PatternScore,
  PatternBeat,
} from "./types";
