/**
 * score.ts — Symphony Score for the portfolio-runner.
 *
 * Phase order: load → per-candidate-optimize → correlate → enumerate →
 *              rank → emit
 *
 * Exit codes: 0 = portfolio emitted, 1 = fatal error, 2 = judgment requested.
 *
 * Two per-candidate optimizer paths:
 *   1. Default path: candidate uses the registry-default scenarioDistribution.
 *      We invoke runScore() from options-optimizer/score.ts as a library —
 *      this file makes NO edits to options-optimizer/score.ts, cli.ts, or
 *      shapes/*.
 *   2. Empirical path (closes Gap 1): candidate has a per-ticker
 *      scenarioDistribution built from historicalMoves. We walk the strategy
 *      catalog directly with `evaluateStrategyWithScenarios`, replicating the
 *      catalog→order→halt→rank phases of runScore but feeding the per-ticker
 *      distribution into the simulation. The Sortino number then reflects
 *      the candidate's actual historical move distribution, not AAPL_SCENARIOS.
 *
 * MarketContext is now ticker-agnostic. We inject the candidate's spot into
 * `underlyingSpot` and use either the candidate's `ivPre` (Gap 2 closed) or a
 * linear ivRank heuristic (Gap 2 fallback). When the candidate carries a
 * hedgeSpot/hedgeIv/hedgeTicker, those are forwarded into the context so the
 * sim hedges against the candidate's own sector instead of the default.
 * Candidates without hedge fields fall back to the global default hedge
 * (geo-tail proxy).
 */

import {
  runScore as runOptimizerScore,
  type ScoreResult as OptimizerScoreResult,
} from "../options-optimizer/score";
import {
  buildStrategyCatalog,
  orderByBlastRadius,
  evaluateStrategyWithScenarios,
  type EvaluatedStrategy,
  type MarketContext,
  type Scenario,
  type StrategySpec,
} from "../options-optimizer/options-optimizer";
import type { ScreenedCandidate, ScenarioDistribution } from "../candidate-screener/score";
import {
  averagePairwiseCorrelation,
  buildHybridCorrelationMatrix,
  subsetCorrelationSource,
  type CorrelationSource,
} from "./correlation";

// Mirror of unexported constants in tools/plugins/options-optimizer/options-optimizer.ts.
// Kept here so the per-ticker direct-walk path applies the same halt/winner
// filter rules as runScore. If the upstream constants change, update both.
const OPT_MAX_ALLOWED_LOSS_PROBABILITY = 0.25;
const OPT_MIN_SORTINO_IMPROVEMENT = 0.05;
const OPT_MAX_NO_IMPROVEMENT_STREAK = 3;

const DEFAULT_MARKET_BASE: MarketContext = {
  underlyingSpot: 270.94,
  hedgeSpot: 58,
  riskFreeRate: 0.0375,
  underlyingIvPre: 0.38,
  underlyingIvPost: 0.26,
  hedgeIv: 0.3,
  capital: 100_000,
  maxAcceptableTotalLossPct: 20,
};

export interface PortfolioInputs {
  candidates: ScreenedCandidate[];
  capital: number;
  maxLossPct: number;
  seed: number;
  iterations: number;
  maxPortfolioSize: number;
  correlationPenaltyWeight: number;
  shapeName?: string;
}

export interface PerCandidateResult {
  ticker: string;
  sector: string;
  shape: string;
  optimizerExitCode: 0 | 1 | 2;
  winner: EvaluatedStrategy | null;
  noWinnerReason?: string;
  /**
   * Where ivPre came from for this candidate's optimizer run:
   *   - "actual":    candidate.ivPre was supplied in the watchlist (closes Gap 2).
   *   - "heuristic": ivPreFromRank() linear interpolation was used (Gap 2 still open).
   */
  ivPreSource: "actual" | "heuristic";
  /**
   * Whether the screener built a per-ticker empirical scenario distribution
   * from historicalMoves AND it was successfully consumed by
   * `evaluateStrategyWithScenarios`. When true, the Sortino number reflects
   * the candidate's actual historical move distribution rather than the
   * registry-default AAPL_SCENARIOS shape.
   */
  empiricalScenariosUsed: boolean;
  /**
   * Legacy field, retained for backward compatibility with prior tests.
   * Always false now that Gap 1 is closed via evaluateStrategyWithScenarios.
   * Will be removed in a future cleanup.
   */
  historicalMovesIgnored: boolean;
}

export interface PortfolioCandidate {
  tickers: string[];
  sectors: string[];
  aggregateSortino: number;
  averagePairwiseCorrelation: number;
  /**
   * Provenance of the off-diagonal correlations within this subset:
   *   'realized'        — every pair had ≥20 daily returns and used Pearson
   *   'sector-fallback' — every pair fell back to sector-equality
   *   'mixed'           — some pairs realized, some fallback
   * Singletons report 'realized' (no off-diagonal pairs).
   */
  correlationSource: CorrelationSource | "mixed";
  penalty: number;
  netScore: number;
  members: PerCandidateResult[];
}

export interface PortfolioResult {
  exitCode: 0 | 1 | 2;
  output: string;
  perCandidate: PerCandidateResult[];
  ranked: PortfolioCandidate[];
  judgment?: JudgmentRequest;
}

export interface JudgmentRequest {
  type: string;
  reviewContext: Record<string, string>;
  composerInstructions: string;
  instrumentInstructions: string;
}

// ── Errors (named only) ────────────────────────────────────────────

export class InvalidPortfolioInputError extends Error {
  constructor(field: string, value: unknown, reason: string) {
    super(`Invalid portfolio input: ${field}=${String(value)} (${reason})`);
    this.name = "InvalidPortfolioInputError";
  }
}

export class EmptyPortfolioCandidatesError extends Error {
  constructor() {
    super("Portfolio runner requires at least one screened candidate");
    this.name = "EmptyPortfolioCandidatesError";
  }
}

// ── IV heuristic (documented above) ────────────────────────────────

function ivPreFromRank(ivRank: number): number {
  // ivRank ∈ [0,100]. Map linearly to [0.20, 0.50] for pre-earnings IV.
  // ONLY used as a fallback when ScreenedCandidate.ivPre is not provided.
  return 0.20 + (ivRank / 100) * 0.30;
}

function ivPostFromPre(ivPre: number): number {
  // Post-earnings crush: ~30% reduction (typical mega-cap).
  return ivPre * 0.7;
}

function buildCandidateMarketContext(
  candidate: ScreenedCandidate,
  _inputs: PortfolioInputs,
): { context: Partial<MarketContext>; ivPreSource: "actual" | "heuristic" } {
  const ivPreSource: "actual" | "heuristic" =
    typeof candidate.ivPre === "number" ? "actual" : "heuristic";
  const ivPre =
    ivPreSource === "actual" ? (candidate.ivPre as number) : ivPreFromRank(candidate.ivRank);
  const ivPost = ivPostFromPre(ivPre);
  const context: Partial<MarketContext> = {
    underlyingSpot: candidate.spot,
    underlyingIvPre: ivPre,
    underlyingIvPost: ivPost,
    underlyingTicker: candidate.ticker,
  };
  // Per-candidate hedge override is all-or-nothing (validated by the screener).
  if (
    typeof candidate.hedgeTicker === "string" &&
    typeof candidate.hedgeSpot === "number" &&
    typeof candidate.hedgeIv === "number"
  ) {
    context.hedgeTicker = candidate.hedgeTicker;
    context.hedgeSpot = candidate.hedgeSpot;
    context.hedgeIv = candidate.hedgeIv;
  }
  return { context, ivPreSource };
}

/**
 * True when the screener built a per-ticker empirical scenarioDistribution
 * from historicalMoves. Detected via the bucket-name prefix produced by
 * `maybeBuildEmpiricalDistribution` in candidate-screener/score.ts.
 */
function hasEmpiricalDistribution(candidate: ScreenedCandidate): boolean {
  const first = candidate.scenarioDistribution.buckets[0];
  return first !== undefined && first.name.startsWith(`${candidate.ticker}_HIST_`);
}

/**
 * Convert a screener `ScenarioDistribution` into the optimizer's `Scenario[]`
 * shape. The two interfaces are structurally identical; this is a typed cast
 * with a fresh array to avoid leaking the readonly bucket reference.
 */
function distributionToScenarios(dist: ScenarioDistribution): Scenario[] {
  return dist.buckets.map((b) => ({
    name: b.name,
    probability: b.probability,
    minMovePct: b.minMovePct,
    maxMovePct: b.maxMovePct,
  }));
}

/**
 * Direct-walk path for candidates with per-ticker empirical scenario
 * distributions. Replicates the catalog→order→halt→rank phases of `runScore`
 * but calls `evaluateStrategyWithScenarios` so the simulation actually
 * consumes the per-ticker distribution. The halt rule and winner filter
 * mirror the constants documented at the top of this module.
 *
 * Returns the winning strategy (highest Sortino with P(loss>50%)<25%) or null
 * if no eligible winner exists.
 */
function runOptimizerDirectWithScenarios(
  candidate: ScreenedCandidate,
  inputs: PortfolioInputs,
  perRunSeed: number,
  partialMarket: Partial<MarketContext>,
): { winner: EvaluatedStrategy | null; reason?: string } {
  const scenarios = distributionToScenarios(candidate.scenarioDistribution);
  const context: MarketContext = {
    ...DEFAULT_MARKET_BASE,
    ...partialMarket,
    capital: inputs.capital,
    maxAcceptableTotalLossPct: inputs.maxLossPct,
  };

  const ordered: StrategySpec[] = orderByBlastRadius(buildStrategyCatalog());
  const evaluated: EvaluatedStrategy[] = [];
  let bestSortinoSoFar = -Infinity;
  let noImprovementStreak = 0;

  for (let idx = 0; idx < ordered.length; idx++) {
    const spec = ordered[idx];
    let result: EvaluatedStrategy;
    try {
      result = evaluateStrategyWithScenarios(spec, context, scenarios, {
        iterations: inputs.iterations,
        seed: perRunSeed + idx,
      });
    } catch {
      continue; // Invalid spec (e.g. negative entry premium) — skip silently.
    }
    evaluated.push(result);

    const sortino = result.metrics.sortino;
    if (sortino > bestSortinoSoFar) {
      const improvement =
        bestSortinoSoFar === -Infinity
          ? Infinity
          : (sortino - bestSortinoSoFar) /
            (Math.abs(bestSortinoSoFar) + 1e-9);
      bestSortinoSoFar = sortino;
      noImprovementStreak =
        improvement < OPT_MIN_SORTINO_IMPROVEMENT ? noImprovementStreak + 1 : 0;
    } else {
      noImprovementStreak += 1;
    }
    if (noImprovementStreak >= OPT_MAX_NO_IMPROVEMENT_STREAK) break;
  }

  const eligible = evaluated.filter(
    (e) => e.metrics.probabilityLossAbove50PctAllocated < OPT_MAX_ALLOWED_LOSS_PROBABILITY,
  );
  if (eligible.length === 0) {
    return { winner: null, reason: "no eligible strategy under loss-probability filter" };
  }
  const winner = [...eligible].sort(
    (a, b) => b.metrics.sortino - a.metrics.sortino,
  )[0];
  return { winner };
}

// ── Phase logic ───────────────────────────────────────────────────

function phaseValidate(inputs: PortfolioInputs): void {
  if (!Array.isArray(inputs.candidates) || inputs.candidates.length === 0) {
    throw new EmptyPortfolioCandidatesError();
  }
  if (!Number.isFinite(inputs.capital) || inputs.capital <= 0) {
    throw new InvalidPortfolioInputError("capital", inputs.capital, "must be positive");
  }
  if (!Number.isFinite(inputs.maxLossPct) || inputs.maxLossPct <= 0 || inputs.maxLossPct >= 100) {
    throw new InvalidPortfolioInputError("maxLossPct", inputs.maxLossPct, "must be in (0, 100)");
  }
  if (!Number.isInteger(inputs.seed) || inputs.seed < 0) {
    throw new InvalidPortfolioInputError("seed", inputs.seed, "non-negative integer required");
  }
  if (!Number.isInteger(inputs.iterations) || inputs.iterations <= 0) {
    throw new InvalidPortfolioInputError("iterations", inputs.iterations, "positive integer required");
  }
  if (
    !Number.isInteger(inputs.maxPortfolioSize) ||
    inputs.maxPortfolioSize < 1 ||
    inputs.maxPortfolioSize > inputs.candidates.length
  ) {
    throw new InvalidPortfolioInputError(
      "maxPortfolioSize",
      inputs.maxPortfolioSize,
      `must be in [1, ${inputs.candidates.length}]`,
    );
  }
  if (!Number.isFinite(inputs.correlationPenaltyWeight) || inputs.correlationPenaltyWeight < 0) {
    throw new InvalidPortfolioInputError(
      "correlationPenaltyWeight",
      inputs.correlationPenaltyWeight,
      "must be >= 0",
    );
  }
}

function phasePerCandidateOptimize(inputs: PortfolioInputs): PerCandidateResult[] {
  const out: PerCandidateResult[] = [];
  for (let i = 0; i < inputs.candidates.length; i++) {
    const candidate = inputs.candidates[i];
    const { context, ivPreSource } = buildCandidateMarketContext(candidate, inputs);
    const empirical = hasEmpiricalDistribution(candidate);
    const perRunSeed = inputs.seed + i;

    let winner: EvaluatedStrategy | null;
    let optimizerExitCode: 0 | 1 | 2;
    let noWinnerReason: string | undefined;
    let historicalMovesIgnored: boolean;
    let empiricalScenariosUsed: boolean;

    if (empirical) {
      // Gap-1-closing path: walk the catalog directly with the per-ticker
      // empirical distribution. Sortino now reflects the candidate's actual
      // historical move distribution, not AAPL_SCENARIOS.
      const direct = runOptimizerDirectWithScenarios(candidate, inputs, perRunSeed, context);
      winner = direct.winner;
      optimizerExitCode = winner !== null ? 0 : 2;
      noWinnerReason = direct.reason;
      historicalMovesIgnored = false;
      empiricalScenariosUsed = true;
    } else {
      // Default path: registry-default scenario distribution → use runScore.
      const optimizerResult: OptimizerScoreResult = runOptimizerScore({
        capital: inputs.capital,
        maxLossPct: inputs.maxLossPct,
        seed: perRunSeed,
        iterations: inputs.iterations,
        shapeName: inputs.shapeName,
        market: context,
      });
      winner = optimizerResult.state.winner ?? null;
      optimizerExitCode = optimizerResult.exitCode;
      noWinnerReason =
        optimizerResult.exitCode === 2
          ? optimizerResult.judgment?.type ?? "judgment-requested"
          : optimizerResult.exitCode === 1
            ? optimizerResult.output.split("\n")[0]
            : undefined;
      historicalMovesIgnored = false;
      empiricalScenariosUsed = false;
    }

    out.push({
      ticker: candidate.ticker,
      sector: candidate.sector,
      shape: inputs.shapeName ?? "put-spread-hedge",
      optimizerExitCode,
      winner,
      noWinnerReason,
      ivPreSource,
      empiricalScenariosUsed,
      historicalMovesIgnored,
    });
  }
  return out;
}

// Subsets of size 1..maxSize. Indices into `survivors` array.
function* enumerateSubsets(n: number, maxSize: number): Generator<number[]> {
  const indices: number[] = [];
  function* recurse(start: number, depth: number): Generator<number[]> {
    if (indices.length > 0) yield [...indices];
    if (depth === maxSize) return;
    for (let i = start; i < n; i++) {
      indices.push(i);
      yield* recurse(i + 1, depth + 1);
      indices.pop();
    }
  }
  yield* recurse(0, 0);
}

function phaseEnumeratePortfolios(
  perCandidate: PerCandidateResult[],
  inputs: PortfolioInputs,
): PortfolioCandidate[] {
  const survivors = perCandidate.filter((r) => r.winner !== null);
  if (survivors.length === 0) return [];

  // Look up the original candidate by ticker so we can attach dailyReturns30d
  // for the realized-correlation path. PerCandidateResult intentionally does
  // not carry the raw return series (it would bloat every downstream record).
  const candidateByTicker = new Map(inputs.candidates.map((c) => [c.ticker, c]));
  const correlationInputs = survivors.map((s) => {
    const orig = candidateByTicker.get(s.ticker);
    return {
      ticker: s.ticker,
      sector: s.sector,
      dailyReturns: orig?.dailyReturns30d,
    };
  });
  const { matrix, sources } = buildHybridCorrelationMatrix(correlationInputs);

  const portfolios: PortfolioCandidate[] = [];
  for (const subset of enumerateSubsets(survivors.length, inputs.maxPortfolioSize)) {
    const members = subset.map((i) => survivors[i]);
    const aggregateSortino = members.reduce(
      (acc, m) => acc + (m.winner!.metrics.sortino ?? 0),
      0,
    );
    const corr = averagePairwiseCorrelation(matrix, subset);
    const penalty = corr * inputs.correlationPenaltyWeight * subset.length;
    portfolios.push({
      tickers: members.map((m) => m.ticker),
      sectors: members.map((m) => m.sector),
      aggregateSortino,
      averagePairwiseCorrelation: corr,
      correlationSource: subsetCorrelationSource(sources, subset),
      penalty,
      netScore: aggregateSortino - penalty,
      members,
    });
  }
  return portfolios;
}

function phaseRank(portfolios: PortfolioCandidate[]): PortfolioCandidate[] {
  return [...portfolios].sort((a, b) => {
    if (b.netScore !== a.netScore) return b.netScore - a.netScore;
    if (a.averagePairwiseCorrelation !== b.averagePairwiseCorrelation) {
      return a.averagePairwiseCorrelation - b.averagePairwiseCorrelation;
    }
    return a.tickers.join(",").localeCompare(b.tickers.join(","));
  });
}

// ── Public entry ─────────────────────────────────────────────────

export function runPortfolio(inputs: PortfolioInputs): PortfolioResult {
  try {
    phaseValidate(inputs);
    const perCandidate = phasePerCandidateOptimize(inputs);
    const portfolios = phaseEnumeratePortfolios(perCandidate, inputs);
    const ranked = phaseRank(portfolios);

    if (ranked.length === 0) {
      const judgment: JudgmentRequest = {
        type: "no-portfolio",
        reviewContext: {
          CANDIDATE_COUNT: String(inputs.candidates.length),
          OPTIMIZER_FAILURES: String(
            perCandidate.filter((r) => r.winner === null).length,
          ),
          REASONS: perCandidate
            .filter((r) => r.winner === null)
            .map((r) => `${r.ticker}:${r.noWinnerReason ?? "unknown"}`)
            .join(";") || "(none)",
        },
        composerInstructions:
          "No per-candidate optimizer run produced an eligible winner. Re-invoke with a larger --iterations, a different --shape, or relaxed --max-loss-pct.",
        instrumentInstructions:
          "ALLOWED TOOLS: read_file. Inspect tools/plugins/options-optimizer/score.ts loss filter and per-candidate market context heuristics.",
      };
      return {
        exitCode: 2,
        output: formatJudgment(judgment),
        perCandidate,
        ranked: [],
        judgment,
      };
    }

    return {
      exitCode: 0,
      output: formatPortfolioOutput(perCandidate, ranked, inputs),
      perCandidate,
      ranked,
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      exitCode: 1,
      output: `PORTFOLIO_ERROR: ${err.name}: ${err.message}`,
      perCandidate: [],
      ranked: [],
    };
  }
}

// ── Formatting helpers ────────────────────────────────────────────

function formatPortfolioOutput(
  perCandidate: PerCandidateResult[],
  ranked: PortfolioCandidate[],
  inputs: PortfolioInputs,
): string {
  const perRows = perCandidate.map((r) => {
    const sortino =
      r.winner !== null && Number.isFinite(r.winner.metrics.sortino)
        ? r.winner.metrics.sortino.toFixed(4)
        : r.winner === null
          ? "(no winner)"
          : "Infinity";
    const lossProb =
      r.winner !== null
        ? `${(r.winner.metrics.probabilityLossAbove50PctAllocated * 100).toFixed(2)}%`
        : "n/a";
    const ivTag = r.ivPreSource === "actual" ? "real" : "heur";
    const histTag = r.empiricalScenariosUsed
      ? "EMPIRICAL"
      : r.historicalMovesIgnored
        ? "HIST_IGNORED"
        : "—";
    return [r.ticker, r.sector, r.shape, sortino, lossProb, ivTag, histTag].join(" | ");
  });

  // Data-quality banner — separated so the user sees it even at a glance.
  const heuristicCount = perCandidate.filter((r) => r.ivPreSource === "heuristic").length;
  const empiricalCount = perCandidate.filter((r) => r.empiricalScenariosUsed).length;
  const ignoredCount = perCandidate.filter((r) => r.historicalMovesIgnored).length;
  const dataBanner: string[] = [];
  if (heuristicCount > 0) {
    dataBanner.push(
      `DATA_WARNING: ${heuristicCount}/${perCandidate.length} candidates used the linear ivRank→ivPre heuristic (Gap 2 open). Provide ivPre in the watchlist JSON for trustworthy IV.`,
    );
  }
  if (empiricalCount > 0) {
    dataBanner.push(
      `DATA_NOTE: ${empiricalCount}/${perCandidate.length} candidates used per-ticker empirical scenario distributions (Gap 1 closed via evaluateStrategyWithScenarios). Sortino reflects the candidate's actual historical move distribution.`,
    );
  }
  if (ignoredCount > 0) {
    dataBanner.push(
      `DATA_WARNING: ${ignoredCount}/${perCandidate.length} candidates have per-ticker empirical scenarioDistribution but the optimizer ignored it. (Should be 0 — investigate if non-zero.)`,
    );
  }

  const portfolioRows = ranked.slice(0, 10).map((p, idx) =>
    [
      `${idx + 1}`,
      p.tickers.join("+"),
      p.aggregateSortino.toFixed(4),
      p.averagePairwiseCorrelation.toFixed(2),
      p.correlationSource,
      p.penalty.toFixed(4),
      p.netScore.toFixed(4),
    ].join(" | "),
  );

  const top = ranked[0];
  const correlationFlag =
    top.averagePairwiseCorrelation > 0
      ? `\nCORRELATION FLAG: top portfolio has avg pairwise correlation ${top.averagePairwiseCorrelation.toFixed(2)} — these legs are NOT independent.`
      : "";

  return [
    `PORTFOLIO: portfolio-runner | candidates=${inputs.candidates.length} | maxSize=${inputs.maxPortfolioSize}`,
    ...dataBanner,
    "",
    "PER_CANDIDATE_BEGIN",
    "Ticker | Sector | Shape | Sortino | P(loss>50%) | IV | Hist",
    "---|---|---|---:|---:|---|---",
    ...perRows,
    "PER_CANDIDATE_END",
    "",
    "PORTFOLIO_RANK_BEGIN",
    "Rank | Tickers | Sum Sortino | Avg Corr | CorrSource | Penalty | Net Score",
    "---|---|---:|---:|---|---:|---:",
    ...portfolioRows,
    "PORTFOLIO_RANK_END",
    "",
    `Top portfolio: ${top.tickers.join("+")}`,
    `  sectors=[${top.sectors.join(",")}], aggregate Sortino=${top.aggregateSortino.toFixed(4)}, avg pairwise corr=${top.averagePairwiseCorrelation.toFixed(2)}, net score=${top.netScore.toFixed(4)}` +
      correlationFlag,
  ].join("\n");
}

function formatJudgment(j: JudgmentRequest): string {
  const ctx = Object.entries(j.reviewContext)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return [
    `JUDGMENT_REQUEST: ${j.type}`,
    "REVIEW_CONTEXT_BEGIN",
    ctx,
    "REVIEW_CONTEXT_END",
    "COMPOSER_INSTRUCTIONS_BEGIN",
    j.composerInstructions,
    "COMPOSER_INSTRUCTIONS_END",
    "INSTRUMENT_INSTRUCTIONS_BEGIN",
    j.instrumentInstructions,
    "INSTRUMENT_INSTRUCTIONS_END",
  ].join("\n");
}
