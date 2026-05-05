/**
 * straddle — long ATM call + long ATM put, same expiry.
 *
 * Profits when |move| > combined entry premium; loses worst on the
 * INLINE AAPL scenario where post-earnings IV crush deflates both legs.
 *
 * Self-registers via shapes/index.ts. No edits to score.ts required —
 * proves the Shape contract is genuinely pluggable.
 */

import {
  AAPL_SCENARIOS,
  blackScholesPrice,
  mulberry32,
  POST_EARNINGS_DTE_YEARS,
  PRE_EARNINGS_DTE_YEARS,
  sampleScenario,
  validateScenarioProbabilities,
} from "../options-optimizer";
import type {
  EvaluatedStrategy,
  MarketContext,
  StrategySpec,
} from "../options-optimizer";
import { registerShape } from "./registry";
import type { Shape, ShapeEvaluateOptions } from "./types";

// ── Constants ─────────────────────────────────────────────────────

const ATM_REFERENCE_STRIKE = 271; // round(DEFAULT_MARKET.underlyingSpot = 270.94)
const STRIKE_OFFSETS: readonly number[] = [-2, 0, 2];
const CONTRACT_COUNTS: readonly number[] = [1, 2, 3, 5];
const OPTION_MULTIPLIER = 100;

// ── Errors (named, surfaced via score.ts NAMED_RUNTIME_ERRORS) ────

export class NegativeStrikeError extends Error {
  constructor(strike: number) {
    super(`Straddle strike must be positive and finite, got ${strike}`);
    this.name = "NegativeStrikeError";
  }
}

export class NonPositiveContractsError extends Error {
  constructor(contracts: number) {
    super(`Straddle contracts must be positive and finite, got ${contracts}`);
    this.name = "NonPositiveContractsError";
  }
}

export class InvalidStraddleSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStraddleSpecError";
  }
}

// ── Spec shape ────────────────────────────────────────────────────
//
// The Shape interface is hard-typed to StrategySpec (the put-spread-hedge
// shape's own spec). Rather than modify shapes/types.ts (forbidden), we
// extend StrategySpec with straddle-specific fields. The put-spread-hedge
// fields are populated with sentinel values that satisfy structural
// typing but are never read by straddle's own validate/evaluate.

interface StraddleExtras {
  __shape: "straddle";
  callStrike: number;
  putStrike: number;
  contracts: number;
}

export type StraddleSpec = StrategySpec & StraddleExtras;

function isStraddleSpec(spec: StrategySpec): spec is StraddleSpec {
  return (spec as Partial<StraddleSpec>).__shape === "straddle";
}

function asStraddle(spec: StrategySpec): StraddleSpec {
  if (!isStraddleSpec(spec)) {
    throw new InvalidStraddleSpecError(
      `Expected a straddle spec (missing __shape="straddle" marker)`,
    );
  }
  return spec;
}

// ── Catalog ───────────────────────────────────────────────────────

export function generateStraddleCatalog(): StraddleSpec[] {
  const catalog: StraddleSpec[] = [];
  for (const offset of STRIKE_OFFSETS) {
    const strike = ATM_REFERENCE_STRIKE + offset;
    for (const contracts of CONTRACT_COUNTS) {
      catalog.push({
        // Sentinel StrategySpec fields — unused by straddle's own evaluate.
        aaplLongPutStrike: strike,
        aaplShortPutStrike: strike,
        hedgeInstrument: "xle-shares",
        aaplAllocationPct: 100,
        xleAllocationPct: 0,
        // Straddle-specific
        __shape: "straddle",
        callStrike: strike,
        putStrike: strike,
        contracts,
      });
    }
  }
  return catalog;
}

// ── Validation ────────────────────────────────────────────────────

function validate(spec: StrategySpec): void {
  const s = asStraddle(spec);
  if (!Number.isFinite(s.callStrike) || s.callStrike <= 0) {
    throw new NegativeStrikeError(s.callStrike);
  }
  if (!Number.isFinite(s.putStrike) || s.putStrike <= 0) {
    throw new NegativeStrikeError(s.putStrike);
  }
  if (!Number.isInteger(s.contracts) || s.contracts <= 0) {
    throw new NonPositiveContractsError(s.contracts);
  }
}

// ── Pricing helpers ───────────────────────────────────────────────

export function straddleEntryPremium(
  spec: StraddleSpec,
  context: MarketContext,
): number {
  const callPrice = blackScholesPrice(
    context.underlyingSpot,
    spec.callStrike,
    context.riskFreeRate,
    context.underlyingIvPre,
    PRE_EARNINGS_DTE_YEARS,
    "call",
  );
  const putPrice = blackScholesPrice(
    context.underlyingSpot,
    spec.putStrike,
    context.riskFreeRate,
    context.underlyingIvPre,
    PRE_EARNINGS_DTE_YEARS,
    "put",
  );
  return (callPrice + putPrice) * OPTION_MULTIPLIER * spec.contracts;
}

/**
 * Context-aware blast radius: total entry premium / capital.
 * Use this in tests and analysis. The Shape interface only exposes a
 * context-free blastRadius (see `blastRadiusContextFree`).
 */
export function straddleBlastRadius(
  spec: StraddleSpec,
  context: MarketContext,
): number {
  return straddleEntryPremium(spec, context) / context.capital;
}

/**
 * Context-free proxy used by score.ts for catalog ordering. With ATM
 * strikes within ±2 of spot, premium is dominated by `contracts`, so
 * contracts is monotonic with the contextual premium-to-capital ratio.
 */
function blastRadiusContextFree(spec: StrategySpec): number {
  return asStraddle(spec).contracts;
}

// ── Evaluate ──────────────────────────────────────────────────────

function infeasibleResult(
  spec: StrategySpec,
  entryPremium: number,
): EvaluatedStrategy {
  return {
    strategy: spec,
    blastRadius: blastRadiusContextFree(spec),
    metrics: {
      sortino: Number.NEGATIVE_INFINITY,
      winRate: 0,
      meanPnl: -entryPremium,
      medianPnl: -entryPremium,
      probabilityGainAbove20PctAllocated: 0,
      probabilityLossAbove50PctAllocated: 1,
      hedgeRescueRate: 0,
    },
    deepDive: {
      mean: -entryPremium,
      median: -entryPremium,
      p5: -entryPremium,
      p25: -entryPremium,
      p75: -entryPremium,
      p95: -entryPremium,
      maxGain: 0,
      maxLoss: -entryPremium,
    },
    maxAcceptableLossBreachProbability: 1,
  };
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function evaluate(
  spec: StrategySpec,
  context: MarketContext,
  options: ShapeEvaluateOptions,
): EvaluatedStrategy {
  validate(spec);
  validateScenarioProbabilities(AAPL_SCENARIOS);
  const s = asStraddle(spec);

  const entryPremium = straddleEntryPremium(s, context);
  if (entryPremium > context.capital) {
    // Catalog-time we can't know capital; skip gracefully here.
    return infeasibleResult(spec, entryPremium);
  }

  const random = mulberry32(options.seed);
  const pnls: number[] = [];

  for (let i = 0; i < options.iterations; i++) {
    const scenario = sampleScenario(random, AAPL_SCENARIOS);
    const movePct =
      scenario.minMovePct +
      (scenario.maxMovePct - scenario.minMovePct) * random();
    const exitSpot = context.underlyingSpot * (1 + movePct / 100);

    const exitCall = blackScholesPrice(
      exitSpot,
      s.callStrike,
      context.riskFreeRate,
      context.underlyingIvPost, // post-earnings IV crush
      POST_EARNINGS_DTE_YEARS,
      "call",
    );
    const exitPut = blackScholesPrice(
      exitSpot,
      s.putStrike,
      context.riskFreeRate,
      context.underlyingIvPost,
      POST_EARNINGS_DTE_YEARS,
      "put",
    );
    const exitValue = (exitCall + exitPut) * OPTION_MULTIPLIER * s.contracts;
    pnls.push(exitValue - entryPremium);
  }

  const sorted = [...pnls].sort((a, b) => a - b);
  const mean = pnls.reduce((acc, v) => acc + v, 0) / pnls.length;
  const med =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  const allocated = entryPremium; // capital actually at risk
  const wins = pnls.filter((p) => p > 0).length;
  const gainsAbove20 = pnls.filter((p) => p > allocated * 0.2).length;
  const lossesAbove50 = pnls.filter((p) => p < -allocated * 0.5).length;
  const breaches = pnls.filter(
    (p) => p < -context.capital * (context.maxAcceptableTotalLossPct / 100),
  ).length;

  const downsideVar =
    pnls.reduce((acc, p) => {
      const d = Math.min(0, p / allocated);
      return acc + d * d;
    }, 0) / pnls.length;
  const downsideDev = Math.sqrt(downsideVar);
  const meanReturn = mean / allocated;
  const sortino =
    downsideDev === 0
      ? meanReturn > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : meanReturn / downsideDev;

  return {
    strategy: spec,
    blastRadius: blastRadiusContextFree(spec),
    metrics: {
      sortino,
      winRate: wins / pnls.length,
      meanPnl: mean,
      medianPnl: med,
      probabilityGainAbove20PctAllocated: gainsAbove20 / pnls.length,
      probabilityLossAbove50PctAllocated: lossesAbove50 / pnls.length,
      hedgeRescueRate: 0, // straddle has no hedge leg
    },
    deepDive: {
      mean,
      median: med,
      p5: quantile(sorted, 0.05),
      p25: quantile(sorted, 0.25),
      p75: quantile(sorted, 0.75),
      p95: quantile(sorted, 0.95),
      maxGain: sorted[sorted.length - 1],
      maxLoss: sorted[0],
    },
    maxAcceptableLossBreachProbability: breaches / pnls.length,
  };
}

// ── Public Shape ──────────────────────────────────────────────────

export const straddleShape: Shape = {
  name: "straddle",
  validate,
  generateCatalog: () => generateStraddleCatalog() as StrategySpec[],
  blastRadius: blastRadiusContextFree,
  evaluate,
};

registerShape(straddleShape);
