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
import { fixPattern } from "./fix";

const ENTRIES: readonly Pattern[] = [
  investigatePattern,
  refactorPattern,
  featurePattern,
  fixPattern,
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

export { investigatePattern, refactorPattern, featurePattern, fixPattern };
export type {
  Pattern,
  PatternScore,
  PatternBeat,
} from "./types";
