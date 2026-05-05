export type HedgeInstrument = "xle-call" | "xle-shares";

export interface MarketContext {
  /** Spot price of the underlying being optimized. */
  underlyingSpot: number;
  /** Spot price of the hedge instrument. */
  hedgeSpot: number;
  riskFreeRate: number;
  /** Pre-event implied volatility on the underlying. */
  underlyingIvPre: number;
  /** Post-event (crushed) implied volatility on the underlying. */
  underlyingIvPost: number;
  /** Implied volatility on the hedge instrument. */
  hedgeIv: number;
  capital: number;
  maxAcceptableTotalLossPct: number;
  /**
   * Optional ticker labels used in output formatting only. They do NOT affect
   * any pricing or simulation math. Default to "UNDERLYING" / "HEDGE" when
   * absent so backward-compatible callers don't need to supply them.
   */
  underlyingTicker?: string;
  hedgeTicker?: string;
}

export interface StrategySpec {
  aaplShortPutStrike: number;
  aaplLongPutStrike: number;
  hedgeInstrument: HedgeInstrument;
  xleCallStrike?: number;
  aaplAllocationPct: number;
  xleAllocationPct: number;
}

export interface EvaluatedStrategy {
  strategy: StrategySpec;
  blastRadius: number;
  metrics: StrategyMetrics;
  deepDive: DistributionStats;
  maxAcceptableLossBreachProbability: number;
}

export interface DistributionStats {
  mean: number;
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  maxGain: number;
  maxLoss: number;
}

export interface StrategyMetrics {
  sortino: number;
  winRate: number;
  meanPnl: number;
  medianPnl: number;
  probabilityGainAbove20PctAllocated: number;
  probabilityLossAbove50PctAllocated: number;
  hedgeRescueRate: number;
}

export interface OptimizerResult {
  ranked: EvaluatedStrategy[];
  winner: EvaluatedStrategy | null;
  secondBest: EvaluatedStrategy | null;
  evaluatedCount: number;
  totalCatalogCount: number;
  haltedEarly: boolean;
}

export interface OptimizerOptions {
  iterations?: number;
  seed?: number;
  evaluateStrategy?: (
    strategy: StrategySpec,
    context: MarketContext,
    options: Required<Pick<OptimizerOptions, "iterations" | "seed">>,
  ) => EvaluatedStrategy;
}

export class InvalidAllocationError extends Error {
  constructor(aaplAllocationPct: number, xleAllocationPct: number) {
    super(
      `Invalid allocation split: AAPL=${aaplAllocationPct}%, XLE=${xleAllocationPct}% (must sum to 100%)`,
    );
    this.name = "InvalidAllocationError";
  }
}

export class InvalidStrikeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStrikeError";
  }
}

export class InvalidHedgeInstrumentError extends Error {
  constructor(value: string) {
    super(`Invalid hedge instrument: ${value}`);
    this.name = "InvalidHedgeInstrumentError";
  }
}

export class MissingHedgeStrikeError extends Error {
  constructor() {
    super("xleCallStrike is required when hedgeInstrument is xle-call");
    this.name = "MissingHedgeStrikeError";
  }
}

export interface Scenario {
  name: string;
  probability: number;
  minMovePct: number;
  maxMovePct: number;
}

export const AAPL_SCENARIOS: readonly Scenario[] = [
  { name: "CLEAN_BEAT", probability: 0.30, minMovePct: 4, maxMovePct: 8 },
  { name: "BEAT_AND_FADE", probability: 0.22, minMovePct: -1, maxMovePct: 2 },
  { name: "INLINE", probability: 0.15, minMovePct: -2, maxMovePct: 2 },
  { name: "SOFT_GUIDE", probability: 0.13, minMovePct: -6, maxMovePct: -3 },
  { name: "TRANSITION_SHOCK", probability: 0.10, minMovePct: -9, maxMovePct: -5 },
  { name: "CLEAN_MISS", probability: 0.10, minMovePct: -12, maxMovePct: -7 },
] as const;

export const XLE_SCENARIOS: readonly Scenario[] = [
  { name: "CALM", probability: 0.30, minMovePct: -3, maxMovePct: -1 },
  { name: "STABLE", probability: 0.40, minMovePct: -1, maxMovePct: 2 },
  { name: "ESCALATION", probability: 0.18, minMovePct: 3, maxMovePct: 6 },
  { name: "SHOCK", probability: 0.09, minMovePct: 7, maxMovePct: 14 },
  { name: "MAJOR_SHOCK", probability: 0.03, minMovePct: 15, maxMovePct: 25 },
] as const;

export const PRE_EARNINGS_DTE_YEARS = 21 / 365;
export const POST_EARNINGS_DTE_YEARS = 14 / 365;
const MIN_SORTINO_IMPROVEMENT = 0.05;
const MAX_ALLOWED_LOSS_PROBABILITY = 0.25;

const DEFAULT_AAPL_SPREADS: ReadonlyArray<readonly [number, number]> = [
  [272, 262],
  [270, 260],
  [270, 262],
  [268, 258],
  [265, 255],
];

const DEFAULT_XLE_CALL_STRIKES: readonly number[] = [59, 60, 61];
const DEFAULT_ALLOCATIONS: ReadonlyArray<readonly [number, number]> = [
  [40, 60],
  [50, 50],
  [60, 40],
  [70, 30],
];

export function validateScenarioProbabilities(scenarios: readonly Scenario[]): void {
  const total = scenarios.reduce((acc, scenario) => acc + scenario.probability, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new RangeError(`Scenario probabilities must sum to 1.0, got ${total}`);
  }
}

function validateStrategySpec(spec: StrategySpec): void {
  if (spec.aaplAllocationPct + spec.xleAllocationPct !== 100) {
    throw new InvalidAllocationError(spec.aaplAllocationPct, spec.xleAllocationPct);
  }

  if (spec.aaplLongPutStrike <= spec.aaplShortPutStrike) {
    throw new InvalidStrikeError(
      `AAPL put spread is invalid: long strike ${spec.aaplLongPutStrike} must be above short strike ${spec.aaplShortPutStrike}`,
    );
  }

  if (spec.hedgeInstrument !== "xle-call" && spec.hedgeInstrument !== "xle-shares") {
    throw new InvalidHedgeInstrumentError(spec.hedgeInstrument);
  }

  if (spec.hedgeInstrument === "xle-call") {
    if (typeof spec.xleCallStrike !== "number") {
      throw new MissingHedgeStrikeError();
    }
    if (spec.xleCallStrike <= 0) {
      throw new InvalidStrikeError(`XLE call strike must be positive, got ${spec.xleCallStrike}`);
    }
  }
}

export function buildStrategyCatalog(): StrategySpec[] {
  const catalog: StrategySpec[] = [];

  for (const [longPut, shortPut] of DEFAULT_AAPL_SPREADS) {
    for (const [aaplAllocationPct, xleAllocationPct] of DEFAULT_ALLOCATIONS) {
      for (const xleCallStrike of DEFAULT_XLE_CALL_STRIKES) {
        catalog.push({
          aaplLongPutStrike: longPut,
          aaplShortPutStrike: shortPut,
          hedgeInstrument: "xle-call",
          xleCallStrike,
          aaplAllocationPct,
          xleAllocationPct,
        });
      }

      catalog.push({
        aaplLongPutStrike: longPut,
        aaplShortPutStrike: shortPut,
        hedgeInstrument: "xle-shares",
        aaplAllocationPct,
        xleAllocationPct,
      });
    }
  }

  return catalog;
}

export function blastRadius(spec: StrategySpec): number {
  const width = spec.aaplLongPutStrike - spec.aaplShortPutStrike;
  return width * (spec.aaplAllocationPct / 100);
}

export function orderByBlastRadius(specs: StrategySpec[]): StrategySpec[] {
  return [...specs].sort((a, b) => {
    const delta = blastRadius(a) - blastRadius(b);
    if (delta !== 0) return delta;
    return strategyLabel(a).localeCompare(strategyLabel(b));
  });
}

function normalCdf(x: number): number {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228;

  if (x >= 0) {
    const t = 1 / (1 + p * x);
    return 1 - c * Math.exp((-x * x) / 2) * t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  }

  return 1 - normalCdf(-x);
}

export function blackScholesPrice(
  spot: number,
  strike: number,
  riskFreeRate: number,
  sigma: number,
  timeYears: number,
  optionType: "call" | "put",
): number {
  const safeT = Math.max(timeYears, 1e-9);
  const safeSigma = Math.max(sigma, 1e-9);
  const sqrtT = Math.sqrt(safeT);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + (safeSigma * safeSigma) / 2) * safeT) / (safeSigma * sqrtT);
  const d2 = d1 - safeSigma * sqrtT;

  if (optionType === "call") {
    return spot * normalCdf(d1) - strike * Math.exp(-riskFreeRate * safeT) * normalCdf(d2);
  }
  return strike * Math.exp(-riskFreeRate * safeT) * normalCdf(-d2) - spot * normalCdf(-d1);
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

export function sampleScenario(random: () => number, scenarios: readonly Scenario[]): Scenario {
  const value = random();
  let cumulative = 0;
  for (const scenario of scenarios) {
    cumulative += scenario.probability;
    if (value <= cumulative) {
      return scenario;
    }
  }
  return scenarios[scenarios.length - 1];
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sortinoRatio(returns: readonly number[]): number {
  if (returns.length === 0) return 0;
  const avg = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  const downsideVariance =
    returns.reduce((acc, value) => {
      const downside = Math.min(0, value);
      return acc + downside * downside;
    }, 0) / returns.length;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) {
    return avg > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return avg / downsideDev;
}

function relativeImprovement(previous: number, current: number): number {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    if (previous === current) return 0;
    return current > previous ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return (current - previous) / (Math.abs(previous) + 1e-9);
}

export function evaluateStrategy(
  strategy: StrategySpec,
  context: MarketContext,
  options: Required<Pick<OptimizerOptions, "iterations" | "seed">>,
): EvaluatedStrategy {
  validateStrategySpec(strategy);
  validateScenarioProbabilities(AAPL_SCENARIOS);
  validateScenarioProbabilities(XLE_SCENARIOS);

  const random = mulberry32(options.seed);

  const aaplAllocationDollars = context.capital * (strategy.aaplAllocationPct / 100);
  const xleAllocationDollars = context.capital * (strategy.xleAllocationPct / 100);
  const allocatedCapital = aaplAllocationDollars + xleAllocationDollars;

  const aaplEntrySpread =
    blackScholesPrice(
      context.underlyingSpot,
      strategy.aaplLongPutStrike,
      context.riskFreeRate,
      context.underlyingIvPre,
      PRE_EARNINGS_DTE_YEARS,
      "put",
    ) -
    blackScholesPrice(
      context.underlyingSpot,
      strategy.aaplShortPutStrike,
      context.riskFreeRate,
      context.underlyingIvPre,
      PRE_EARNINGS_DTE_YEARS,
      "put",
    );

  if (aaplEntrySpread <= 0) {
    throw new InvalidStrikeError(
      `AAPL spread entry premium must be positive for ${strategy.aaplLongPutStrike}/${strategy.aaplShortPutStrike}`,
    );
  }

  const aaplContracts = aaplAllocationDollars / (aaplEntrySpread * 100);

  let xleCallEntryPremium = 0;
  let xleCallContracts = 0;
  let xleShares = 0;

  if (strategy.hedgeInstrument === "xle-call") {
    const strike = strategy.xleCallStrike;
    if (typeof strike !== "number") {
      throw new MissingHedgeStrikeError();
    }
    xleCallEntryPremium = blackScholesPrice(
      context.hedgeSpot,
      strike,
      context.riskFreeRate,
      context.hedgeIv,
      PRE_EARNINGS_DTE_YEARS,
      "call",
    );
    if (xleCallEntryPremium <= 0) {
      throw new InvalidStrikeError(`XLE call entry premium must be positive for strike ${strike}`);
    }
    xleCallContracts = xleAllocationDollars / (xleCallEntryPremium * 100);
  } else {
    xleShares = xleAllocationDollars / context.hedgeSpot;
  }

  const totalPnl: number[] = [];
  const aaplLegPnl: number[] = [];
  const hedgeLegPnl: number[] = [];

  for (let i = 0; i < options.iterations; i++) {
    const aaplScenario = sampleScenario(random, AAPL_SCENARIOS);
    const xleScenario = sampleScenario(random, XLE_SCENARIOS);

    let aaplMovePct = randomBetween(random, aaplScenario.minMovePct, aaplScenario.maxMovePct);
    const xleMovePct = randomBetween(random, xleScenario.minMovePct, xleScenario.maxMovePct);

    if (xleScenario.name === "SHOCK") {
      aaplMovePct += -randomBetween(random, 0.5, 2);
    } else if (xleScenario.name === "MAJOR_SHOCK") {
      aaplMovePct += -randomBetween(random, 2, 4);
    }

    const aaplExitSpot = context.underlyingSpot * (1 + aaplMovePct / 100);
    const xleExitSpot = context.hedgeSpot * (1 + xleMovePct / 100);

    const aaplExitSpread =
      blackScholesPrice(
        aaplExitSpot,
        strategy.aaplLongPutStrike,
        context.riskFreeRate,
        context.underlyingIvPost,
        POST_EARNINGS_DTE_YEARS,
        "put",
      ) -
      blackScholesPrice(
        aaplExitSpot,
        strategy.aaplShortPutStrike,
        context.riskFreeRate,
        context.underlyingIvPost,
        POST_EARNINGS_DTE_YEARS,
        "put",
      );

    const aaplPnl = aaplContracts * (aaplExitSpread - aaplEntrySpread) * 100;

    let hedgePnl = 0;
    if (strategy.hedgeInstrument === "xle-call") {
      const strike = strategy.xleCallStrike as number;
      const xleExitIv =
        xleScenario.name === "SHOCK" || xleScenario.name === "MAJOR_SHOCK"
          ? context.hedgeIv + 0.10
          : context.hedgeIv;
      const xleExitPremium = blackScholesPrice(
        xleExitSpot,
        strike,
        context.riskFreeRate,
        xleExitIv,
        POST_EARNINGS_DTE_YEARS,
        "call",
      );
      hedgePnl = xleCallContracts * (xleExitPremium - xleCallEntryPremium) * 100;
    } else {
      hedgePnl = xleShares * (xleExitSpot - context.hedgeSpot);
    }

    totalPnl.push(aaplPnl + hedgePnl);
    aaplLegPnl.push(aaplPnl);
    hedgeLegPnl.push(hedgePnl);
  }

  const totalReturns = totalPnl.map((pnl) => pnl / allocatedCapital);
  const sortedPnl = [...totalPnl].sort((a, b) => a - b);
  const meanPnl = totalPnl.reduce((acc, value) => acc + value, 0) / totalPnl.length;
  const medianPnl = median(totalPnl);
  const winning = totalPnl.filter((pnl) => pnl > 0).length;
  const gainsAbove20 = totalPnl.filter((pnl) => pnl > allocatedCapital * 0.2).length;
  const lossesAbove50 = totalPnl.filter((pnl) => pnl < -allocatedCapital * 0.5).length;
  const maxLossBreachCount = totalPnl.filter(
    (pnl) => pnl < -context.capital * (context.maxAcceptableTotalLossPct / 100),
  ).length;

  let rescuableCases = 0;
  let rescues = 0;
  for (let i = 0; i < totalPnl.length; i++) {
    if (aaplLegPnl[i] < 0) {
      rescuableCases++;
      if (hedgeLegPnl[i] > 0) {
        rescues++;
      }
    }
  }

  return {
    strategy,
    blastRadius: blastRadius(strategy),
    metrics: {
      sortino: sortinoRatio(totalReturns),
      winRate: winning / totalPnl.length,
      meanPnl,
      medianPnl,
      probabilityGainAbove20PctAllocated: gainsAbove20 / totalPnl.length,
      probabilityLossAbove50PctAllocated: lossesAbove50 / totalPnl.length,
      hedgeRescueRate: rescuableCases > 0 ? rescues / rescuableCases : 0,
    },
    deepDive: {
      mean: meanPnl,
      median: medianPnl,
      p5: quantile(sortedPnl, 0.05),
      p25: quantile(sortedPnl, 0.25),
      p75: quantile(sortedPnl, 0.75),
      p95: quantile(sortedPnl, 0.95),
      maxGain: sortedPnl[sortedPnl.length - 1],
      maxLoss: sortedPnl[0],
    },
    maxAcceptableLossBreachProbability: maxLossBreachCount / totalPnl.length,
  };
}

/**
 * Additive variant of `evaluateStrategy` that accepts an injectable scenario
 * distribution for the AAPL leg. The XLE leg continues to sample from
 * `XLE_SCENARIOS` (geo-tail proxy is shape-level concern, not ticker-level).
 *
 * Used by portfolio-runner to feed per-ticker empirical distributions built
 * from `historicalMoves` into the simulation. Closes Gap 1 by allowing the
 * simulation to actually consume the per-ticker `scenarioDistribution` that
 * the screener already builds.
 *
 * Behavioural contract:
 *   - When `scenarios === AAPL_SCENARIOS`, output is bit-for-bit identical to
 *     `evaluateStrategy(strategy, context, options)` for the same seed.
 *   - When `scenarios` is any other valid distribution (probabilities sum to
 *     1.0), the AAPL leg's move sampling uses `scenarios` instead.
 *   - The XLE-shock cross-impact rule (`SHOCK` / `MAJOR_SHOCK` adds drag to
 *     AAPL) still fires regardless of which AAPL scenario name was sampled.
 *     This preserves the cross-asset behaviour of the original simulation.
 */
export function evaluateStrategyWithScenarios(
  strategy: StrategySpec,
  context: MarketContext,
  scenarios: readonly Scenario[],
  options: Required<Pick<OptimizerOptions, "iterations" | "seed">>,
): EvaluatedStrategy {
  validateStrategySpec(strategy);
  validateScenarioProbabilities(scenarios);
  validateScenarioProbabilities(XLE_SCENARIOS);

  const random = mulberry32(options.seed);

  const aaplAllocationDollars = context.capital * (strategy.aaplAllocationPct / 100);
  const xleAllocationDollars = context.capital * (strategy.xleAllocationPct / 100);
  const allocatedCapital = aaplAllocationDollars + xleAllocationDollars;

  const aaplEntrySpread =
    blackScholesPrice(
      context.underlyingSpot,
      strategy.aaplLongPutStrike,
      context.riskFreeRate,
      context.underlyingIvPre,
      PRE_EARNINGS_DTE_YEARS,
      "put",
    ) -
    blackScholesPrice(
      context.underlyingSpot,
      strategy.aaplShortPutStrike,
      context.riskFreeRate,
      context.underlyingIvPre,
      PRE_EARNINGS_DTE_YEARS,
      "put",
    );

  if (aaplEntrySpread <= 0) {
    throw new InvalidStrikeError(
      `AAPL spread entry premium must be positive for ${strategy.aaplLongPutStrike}/${strategy.aaplShortPutStrike}`,
    );
  }

  const aaplContracts = aaplAllocationDollars / (aaplEntrySpread * 100);

  let xleCallEntryPremium = 0;
  let xleCallContracts = 0;
  let xleShares = 0;

  if (strategy.hedgeInstrument === "xle-call") {
    const strike = strategy.xleCallStrike;
    if (typeof strike !== "number") {
      throw new MissingHedgeStrikeError();
    }
    xleCallEntryPremium = blackScholesPrice(
      context.hedgeSpot,
      strike,
      context.riskFreeRate,
      context.hedgeIv,
      PRE_EARNINGS_DTE_YEARS,
      "call",
    );
    if (xleCallEntryPremium <= 0) {
      throw new InvalidStrikeError(`XLE call entry premium must be positive for strike ${strike}`);
    }
    xleCallContracts = xleAllocationDollars / (xleCallEntryPremium * 100);
  } else {
    xleShares = xleAllocationDollars / context.hedgeSpot;
  }

  const totalPnl: number[] = [];
  const aaplLegPnl: number[] = [];
  const hedgeLegPnl: number[] = [];

  for (let i = 0; i < options.iterations; i++) {
    const aaplScenario = sampleScenario(random, scenarios);
    const xleScenario = sampleScenario(random, XLE_SCENARIOS);

    let aaplMovePct = randomBetween(random, aaplScenario.minMovePct, aaplScenario.maxMovePct);
    const xleMovePct = randomBetween(random, xleScenario.minMovePct, xleScenario.maxMovePct);

    if (xleScenario.name === "SHOCK") {
      aaplMovePct += -randomBetween(random, 0.5, 2);
    } else if (xleScenario.name === "MAJOR_SHOCK") {
      aaplMovePct += -randomBetween(random, 2, 4);
    }

    const aaplExitSpot = context.underlyingSpot * (1 + aaplMovePct / 100);
    const xleExitSpot = context.hedgeSpot * (1 + xleMovePct / 100);

    const aaplExitSpread =
      blackScholesPrice(
        aaplExitSpot,
        strategy.aaplLongPutStrike,
        context.riskFreeRate,
        context.underlyingIvPost,
        POST_EARNINGS_DTE_YEARS,
        "put",
      ) -
      blackScholesPrice(
        aaplExitSpot,
        strategy.aaplShortPutStrike,
        context.riskFreeRate,
        context.underlyingIvPost,
        POST_EARNINGS_DTE_YEARS,
        "put",
      );

    const aaplPnl = aaplContracts * (aaplExitSpread - aaplEntrySpread) * 100;

    let hedgePnl = 0;
    if (strategy.hedgeInstrument === "xle-call") {
      const strike = strategy.xleCallStrike as number;
      const xleExitIv =
        xleScenario.name === "SHOCK" || xleScenario.name === "MAJOR_SHOCK"
          ? context.hedgeIv + 0.10
          : context.hedgeIv;
      const xleExitPremium = blackScholesPrice(
        xleExitSpot,
        strike,
        context.riskFreeRate,
        xleExitIv,
        POST_EARNINGS_DTE_YEARS,
        "call",
      );
      hedgePnl = xleCallContracts * (xleExitPremium - xleCallEntryPremium) * 100;
    } else {
      hedgePnl = xleShares * (xleExitSpot - context.hedgeSpot);
    }

    totalPnl.push(aaplPnl + hedgePnl);
    aaplLegPnl.push(aaplPnl);
    hedgeLegPnl.push(hedgePnl);
  }

  const totalReturns = totalPnl.map((pnl) => pnl / allocatedCapital);
  const sortedPnl = [...totalPnl].sort((a, b) => a - b);
  const meanPnl = totalPnl.reduce((acc, value) => acc + value, 0) / totalPnl.length;
  const medianPnl = median(totalPnl);
  const winning = totalPnl.filter((pnl) => pnl > 0).length;
  const gainsAbove20 = totalPnl.filter((pnl) => pnl > allocatedCapital * 0.2).length;
  const lossesAbove50 = totalPnl.filter((pnl) => pnl < -allocatedCapital * 0.5).length;
  const maxLossBreachCount = totalPnl.filter(
    (pnl) => pnl < -context.capital * (context.maxAcceptableTotalLossPct / 100),
  ).length;

  let rescuableCases = 0;
  let rescues = 0;
  for (let i = 0; i < totalPnl.length; i++) {
    if (aaplLegPnl[i] < 0) {
      rescuableCases++;
      if (hedgeLegPnl[i] > 0) {
        rescues++;
      }
    }
  }

  return {
    strategy,
    blastRadius: blastRadius(strategy),
    metrics: {
      sortino: sortinoRatio(totalReturns),
      winRate: winning / totalPnl.length,
      meanPnl,
      medianPnl,
      probabilityGainAbove20PctAllocated: gainsAbove20 / totalPnl.length,
      probabilityLossAbove50PctAllocated: lossesAbove50 / totalPnl.length,
      hedgeRescueRate: rescuableCases > 0 ? rescues / rescuableCases : 0,
    },
    deepDive: {
      mean: meanPnl,
      median: medianPnl,
      p5: quantile(sortedPnl, 0.05),
      p25: quantile(sortedPnl, 0.25),
      p75: quantile(sortedPnl, 0.75),
      p95: quantile(sortedPnl, 0.95),
      maxGain: sortedPnl[sortedPnl.length - 1],
      maxLoss: sortedPnl[0],
    },
    maxAcceptableLossBreachProbability: maxLossBreachCount / totalPnl.length,
  };
}

export function runOptionsOptimizer(
  context: MarketContext,
  options: OptimizerOptions = {},
): OptimizerResult {
  const iterations = options.iterations ?? 50_000;
  const seed = options.seed ?? 42;
  const evaluator = options.evaluateStrategy ?? evaluateStrategy;

  const catalog = orderByBlastRadius(buildStrategyCatalog());
  const evaluated: EvaluatedStrategy[] = [];

  let haltedEarly = false;
  let noImprovementStreak = 0;
  let previousSortino: number | null = null;

  for (let i = 0; i < catalog.length; i++) {
    const strategy = catalog[i];
    const result = evaluator(strategy, context, { iterations, seed: seed + i });
    evaluated.push(result);

    if (previousSortino !== null) {
      const improvement = relativeImprovement(previousSortino, result.metrics.sortino);
      if (improvement < MIN_SORTINO_IMPROVEMENT) {
        noImprovementStreak++;
      } else {
        noImprovementStreak = 0;
      }
      if (noImprovementStreak >= 3) {
        haltedEarly = true;
        break;
      }
    }

    previousSortino = result.metrics.sortino;
  }

  const ranked = [...evaluated].sort((a, b) => {
    const delta = b.metrics.sortino - a.metrics.sortino;
    if (delta !== 0) return delta;
    return b.metrics.meanPnl - a.metrics.meanPnl;
  });

  const eligible = ranked.filter(
    (entry) => entry.metrics.probabilityLossAbove50PctAllocated < MAX_ALLOWED_LOSS_PROBABILITY,
  );

  return {
    ranked,
    winner: eligible[0] ?? null,
    secondBest: ranked[1] ?? null,
    evaluatedCount: evaluated.length,
    totalCatalogCount: catalog.length,
    haltedEarly,
  };
}

export function strategyLabel(strategy: StrategySpec): string {
  const hedge =
    strategy.hedgeInstrument === "xle-call"
      ? `XLEC${strategy.xleCallStrike}`
      : "XLE-SHARES";
  return `AAPL ${strategy.aaplLongPutStrike}/${strategy.aaplShortPutStrike} + ${hedge} @ ${strategy.aaplAllocationPct}/${strategy.xleAllocationPct}`;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function fmtDollar(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function formatRankedTable(entries: readonly EvaluatedStrategy[]): string {
  const header =
    "Rank | Strategy | Sortino | WinRate | Mean P&L | Median P&L | P(gain>20%) | P(loss>50%) | HedgeRescue";
  const divider = "---|---|---:|---:|---:|---:|---:|---:|---:";
  const rows = entries.map((entry, index) => {
    return [
      `${index + 1}`,
      strategyLabel(entry.strategy),
      Number.isFinite(entry.metrics.sortino) ? entry.metrics.sortino.toFixed(4) : "Infinity",
      fmtPct(entry.metrics.winRate),
      fmtDollar(entry.metrics.meanPnl),
      fmtDollar(entry.metrics.medianPnl),
      fmtPct(entry.metrics.probabilityGainAbove20PctAllocated),
      fmtPct(entry.metrics.probabilityLossAbove50PctAllocated),
      fmtPct(entry.metrics.hedgeRescueRate),
    ].join(" | ");
  });
  return [header, divider, ...rows].join("\n");
}

export function formatWinnerDeepDive(
  winner: EvaluatedStrategy,
  secondBest: EvaluatedStrategy | null,
  context: MarketContext,
): string {
  const ulTicker = context.underlyingTicker ?? "UNDERLYING";
  const hgTicker = context.hedgeTicker ?? "HEDGE";
  const winnerAaplDollars = context.capital * (winner.strategy.aaplAllocationPct / 100);
  const winnerXleDollars = context.capital * (winner.strategy.xleAllocationPct / 100);
  const comparison = secondBest
    ? `Second-best: ${strategyLabel(secondBest.strategy)} | Sortino ${
        Number.isFinite(secondBest.metrics.sortino) ? secondBest.metrics.sortino.toFixed(4) : "Infinity"
      } | Mean P&L ${fmtDollar(secondBest.metrics.meanPnl)} | P(loss>50%) ${fmtPct(
        secondBest.metrics.probabilityLossAbove50PctAllocated,
      )}`
    : "Second-best: n/a";

  return [
    `Winner: ${strategyLabel(winner.strategy)}`,
    `Allocation: ${ulTicker} ${winner.strategy.aaplAllocationPct}% (${fmtDollar(winnerAaplDollars)}), ${hgTicker} ${winner.strategy.xleAllocationPct}% (${fmtDollar(winnerXleDollars)})`,
    `Distribution: mean ${fmtDollar(winner.deepDive.mean)}, median ${fmtDollar(winner.deepDive.median)}, p5 ${fmtDollar(winner.deepDive.p5)}, p25 ${fmtDollar(winner.deepDive.p25)}, p75 ${fmtDollar(winner.deepDive.p75)}, p95 ${fmtDollar(winner.deepDive.p95)}, max gain ${fmtDollar(winner.deepDive.maxGain)}, max loss ${fmtDollar(winner.deepDive.maxLoss)}`,
    comparison,
  ].join("\n");
}
