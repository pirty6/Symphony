/**
 * Strategy shape interface — pluggable contract for the options optimizer
 * Symphony Score. Each shape is a self-contained module exporting a single
 * Shape that can be registered into the catalog without any edits to
 * tools/plugins/options-optimizer/score.ts.
 */

import type {
  EvaluatedStrategy,
  MarketContext,
  StrategySpec,
} from "../options-optimizer";

export interface ShapeEvaluateOptions {
  iterations: number;
  seed: number;
}

export interface Shape {
  /** Stable, kebab-case identifier used by the registry and CLI. */
  readonly name: string;

  /** Throws a named validation error if the spec is malformed. */
  validate(spec: StrategySpec): void;

  /** Enumerate every spec this shape considers (catalog completeness). */
  generateCatalog(): StrategySpec[];

  /** Blast-radius axis used by the score's order phase. */
  blastRadius(spec: StrategySpec): number;

  /** Single-spec evaluation (deterministic for a given seed). */
  evaluate(
    spec: StrategySpec,
    context: MarketContext,
    options: ShapeEvaluateOptions,
  ): EvaluatedStrategy;
}
