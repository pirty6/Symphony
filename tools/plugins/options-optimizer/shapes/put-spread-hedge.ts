/**
 * put-spread-hedge — the original options-optimizer strategy shape.
 *
 * Long-put spread on AAPL paired with an XLE hedge (call or shares).
 * Wraps the existing simulation engine in tools/plugins/options-optimizer/options-optimizer.ts
 * without modifying it; all existing semantics are preserved.
 */

import {
  blastRadius as putSpreadHedgeBlastRadius,
  buildStrategyCatalog,
  evaluateStrategy,
} from "../options-optimizer";
import type {
  EvaluatedStrategy,
  MarketContext,
  StrategySpec,
} from "../options-optimizer";
import { registerShape } from "./registry";
import type { Shape, ShapeEvaluateOptions } from "./types";

function validate(spec: StrategySpec): void {
  // Delegate to the engine's evaluate — which calls validateStrategySpec —
  // by triggering only the validation path. We do this lazily through
  // evaluate() in the score; here we surface a cheap structural check
  // that mirrors the public invariants without running the simulation.
  if (spec.aaplAllocationPct + spec.xleAllocationPct !== 100) {
    const err = new Error(
      `Invalid allocation split: AAPL=${spec.aaplAllocationPct}%, XLE=${spec.xleAllocationPct}% (must sum to 100%)`,
    );
    err.name = "InvalidAllocationError";
    throw err;
  }
  if (spec.aaplLongPutStrike <= spec.aaplShortPutStrike) {
    const err = new Error(
      `AAPL put spread is invalid: long strike ${spec.aaplLongPutStrike} must be above short strike ${spec.aaplShortPutStrike}`,
    );
    err.name = "InvalidStrikeError";
    throw err;
  }
}

function evaluate(
  spec: StrategySpec,
  context: MarketContext,
  options: ShapeEvaluateOptions,
): EvaluatedStrategy {
  return evaluateStrategy(spec, context, options);
}

export const putSpreadHedgeShape: Shape = {
  name: "put-spread-hedge",
  validate,
  generateCatalog: () => buildStrategyCatalog(),
  blastRadius: (spec) => putSpreadHedgeBlastRadius(spec),
  evaluate,
};

registerShape(putSpreadHedgeShape);
