/**
 * score.ts — Symphony Score for the options optimizer.
 *
 * Implements the algorithm-of-algorithms loop as a deterministic phase
 * handler table:
 *
 *   formalize → classify → catalog → order → execute → halt → rank → emit
 *
 * Exit codes follow the Symphony contract:
 *   0 = success (winner found)
 *   1 = fatal validation / runtime error (named)
 *   2 = judgment requested (AI/human input needed)
 *
 * Strategy shapes are pulled from the registry in ./shapes — this file
 * never references a specific shape, so adding a new shape (straddle,
 * strangle, iron condor, …) requires NO edits to the loop.
 */

import {
  formatRankedTable,
  formatWinnerDeepDive,
  type EvaluatedStrategy,
  type MarketContext,
  type OptimizerResult,
  type StrategySpec,
} from "./options-optimizer";
import {
  EmptyCatalogError,
  getShape,
  listShapes,
  type Shape,
} from "./shapes";
// Side-effect import: triggers all shape self-registration.
import "./shapes/index";

// ── Public types ──────────────────────────────────────────────────

export type ScorePhase =
  | "formalize"
  | "classify"
  | "catalog"
  | "order"
  | "execute"
  | "halt"
  | "rank"
  | "emit";

export const PHASE_ORDER: readonly ScorePhase[] = [
  "formalize",
  "classify",
  "catalog",
  "order",
  "execute",
  "halt",
  "rank",
  "emit",
] as const;

export interface ScoreInputs {
  capital: number;
  maxLossPct: number;
  seed: number;
  iterations: number;
  shapeName?: string;
  market?: Partial<MarketContext>;
}

export interface JudgmentRequest {
  type: string;
  reviewContext: Record<string, string>;
  composerInstructions: string;
  instrumentInstructions: string;
}

export interface ScoreError {
  name: string;
  message: string;
}

export interface ScoreState {
  phase: ScorePhase;
  inputs: ScoreInputs;
  context?: MarketContext;
  shape?: Shape;
  catalog?: StrategySpec[];
  ordered?: StrategySpec[];
  evaluated?: EvaluatedStrategy[];
  haltedEarly?: boolean;
  ranked?: EvaluatedStrategy[];
  winner?: EvaluatedStrategy | null;
  secondBest?: EvaluatedStrategy | null;
  judgment?: JudgmentRequest;
  error?: ScoreError;
  output?: string;
  result?: OptimizerResult;
}

export interface ScoreResult {
  exitCode: 0 | 1 | 2;
  output: string;
  state: ScoreState;
  judgment?: JudgmentRequest;
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_SHAPE_NAME = "put-spread-hedge";
const MIN_SORTINO_IMPROVEMENT = 0.05;
const MAX_NO_IMPROVEMENT_STREAK = 3;
const DEFAULT_LOSS_PROBABILITY_FILTER = 0.25;

const DEFAULT_MARKET: MarketContext = {
  underlyingSpot: 270.94,
  hedgeSpot: 58,
  riskFreeRate: 0.0375,
  underlyingIvPre: 0.38,
  underlyingIvPost: 0.26,
  hedgeIv: 0.3,
  capital: 100_000,
  maxAcceptableTotalLossPct: 20,
};

// ── Errors ────────────────────────────────────────────────────────

export class InvalidScoreInputError extends Error {
  constructor(field: string, value: unknown, reason: string) {
    super(
      `Invalid score input: ${field}=${String(value)} (${reason})`,
    );
    this.name = "InvalidScoreInputError";
  }
}

// ── Phase handlers (table) ────────────────────────────────────────

function relativeImprovement(previous: number, current: number): number {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    if (previous === current) return 0;
    return current > previous ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return (current - previous) / (Math.abs(previous) + 1e-9);
}

function phaseFormalize(state: ScoreState): ScoreState {
  const { capital, maxLossPct, seed, iterations } = state.inputs;

  if (!Number.isFinite(capital) || capital <= 0) {
    throw new InvalidScoreInputError("capital", capital, "must be a positive finite number");
  }
  if (!Number.isFinite(maxLossPct) || maxLossPct <= 0 || maxLossPct >= 100) {
    throw new InvalidScoreInputError(
      "max-loss-pct",
      maxLossPct,
      "must be in (0, 100)",
    );
  }
  if (!Number.isInteger(seed) || seed < 0) {
    throw new InvalidScoreInputError("seed", seed, "must be a non-negative integer");
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new InvalidScoreInputError(
      "iterations",
      iterations,
      "must be a positive integer",
    );
  }

  const context: MarketContext = {
    ...DEFAULT_MARKET,
    ...state.inputs.market,
    capital,
    maxAcceptableTotalLossPct: maxLossPct,
  };

  return { ...state, phase: "classify", context };
}

function phaseClassify(state: ScoreState): ScoreState {
  const requested = state.inputs.shapeName ?? DEFAULT_SHAPE_NAME;
  const registered = listShapes();

  if (registered.length === 0) {
    return {
      ...state,
      phase: "emit",
      judgment: {
        type: "shape-registration",
        reviewContext: {
          REQUESTED_SHAPE: requested,
          REGISTERED_SHAPES: "(none)",
        },
        composerInstructions:
          "No strategy shapes are registered. Register at least one shape under tools/plugins/options-optimizer/shapes/ and re-invoke.",
        instrumentInstructions:
          "ALLOWED TOOLS: read_file, list_dir. Inspect tools/plugins/options-optimizer/shapes/ to confirm the registry import wiring is intact.",
      },
    };
  }

  const shape = getShape(requested); // throws UnknownShapeError on miss
  return { ...state, phase: "catalog", shape };
}

function phaseCatalog(state: ScoreState): ScoreState {
  const shape = state.shape!;
  const catalog = shape.generateCatalog();
  if (catalog.length === 0) {
    throw new EmptyCatalogError(shape.name);
  }
  for (const spec of catalog) {
    shape.validate(spec); // surface any malformed seed entries early
  }
  return { ...state, phase: "order", catalog };
}

function phaseOrder(state: ScoreState): ScoreState {
  const shape = state.shape!;
  const catalog = state.catalog!;
  const ordered = [...catalog].sort((a, b) => {
    const delta = shape.blastRadius(a) - shape.blastRadius(b);
    if (delta !== 0) return delta;
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  });
  return { ...state, phase: "execute", ordered };
}

function phaseExecute(state: ScoreState): ScoreState {
  const shape = state.shape!;
  const ordered = state.ordered!;
  const context = state.context!;
  const { iterations, seed } = state.inputs;

  const evaluated: EvaluatedStrategy[] = [];
  let haltedEarly = false;
  let noImprovementStreak = 0;
  let previousSortino: number | null = null;

  for (let i = 0; i < ordered.length; i++) {
    const result = shape.evaluate(ordered[i], context, {
      iterations,
      seed: seed + i,
    });
    evaluated.push(result);

    if (previousSortino !== null) {
      const improvement = relativeImprovement(previousSortino, result.metrics.sortino);
      if (improvement < MIN_SORTINO_IMPROVEMENT) {
        noImprovementStreak++;
      } else {
        noImprovementStreak = 0;
      }
      if (noImprovementStreak >= MAX_NO_IMPROVEMENT_STREAK) {
        haltedEarly = true;
        break;
      }
    }
    previousSortino = result.metrics.sortino;
  }

  return { ...state, phase: "halt", evaluated, haltedEarly };
}

function phaseHalt(state: ScoreState): ScoreState {
  // Pure separator: codifies the halt point so downstream phases
  // (rank/emit) see a frozen evaluated set. No mutation.
  return { ...state, phase: "rank" };
}

function phaseRank(state: ScoreState): ScoreState {
  const evaluated = state.evaluated!;
  const ranked = [...evaluated].sort((a, b) => {
    const delta = b.metrics.sortino - a.metrics.sortino;
    if (delta !== 0) return delta;
    return b.metrics.meanPnl - a.metrics.meanPnl;
  });
  const eligible = ranked.filter(
    (entry) =>
      entry.metrics.probabilityLossAbove50PctAllocated <
      DEFAULT_LOSS_PROBABILITY_FILTER,
  );
  return {
    ...state,
    phase: "emit",
    ranked,
    winner: eligible[0] ?? null,
    secondBest: ranked[1] ?? null,
  };
}

function phaseEmit(state: ScoreState): ScoreState {
  const ranked = state.ranked!;
  const evaluated = state.evaluated!;
  const result: OptimizerResult = {
    ranked,
    winner: state.winner ?? null,
    secondBest: state.secondBest ?? null,
    evaluatedCount: evaluated.length,
    totalCatalogCount: state.catalog!.length,
    haltedEarly: state.haltedEarly ?? false,
  };

  if (!state.winner) {
    return {
      ...state,
      result,
      judgment: {
        type: "no-eligible-winner",
        reviewContext: {
          SHAPE: state.shape!.name,
          EVALUATED_COUNT: String(evaluated.length),
          CATALOG_COUNT: String(state.catalog!.length),
          MAX_LOSS_PCT: String(state.inputs.maxLossPct),
          BEST_LOSS_PROBABILITY:
            ranked[0] !== undefined
              ? String(ranked[0].metrics.probabilityLossAbove50PctAllocated)
              : "n/a",
        },
        composerInstructions:
          "No strategy survived the loss filter. Re-invoke with a relaxed --max-loss-pct, a different --seed, or --shape to widen the search.",
        instrumentInstructions:
          "ALLOWED TOOLS: read_file. Inspect the ranked table in the prior output. Decide whether to relax the loss filter or pivot to a different shape.",
      },
    };
  }

  const output = [
    `SCORE: options-optimizer | shape=${state.shape!.name}`,
    `Evaluated ${evaluated.length}/${state.catalog!.length} strategies${
      state.haltedEarly ? " (halted early)" : ""
    }`,
    "",
    formatRankedTable(ranked),
    "",
    formatWinnerDeepDive(state.winner, state.secondBest ?? null, state.context!),
  ].join("\n");

  return { ...state, output, result };
}

const PHASE_HANDLERS: Record<ScorePhase, (state: ScoreState) => ScoreState> = {
  formalize: phaseFormalize,
  classify: phaseClassify,
  catalog: phaseCatalog,
  order: phaseOrder,
  execute: phaseExecute,
  halt: phaseHalt,
  rank: phaseRank,
  emit: phaseEmit,
};

// ── Main entry ────────────────────────────────────────────────────

const NAMED_RUNTIME_ERRORS = new Set([
  "InvalidScoreInputError",
  "InvalidAllocationError",
  "InvalidStrikeError",
  "InvalidHedgeInstrumentError",
  "MissingHedgeStrikeError",
  "EmptyCatalogError",
  "UnknownShapeError",
  "DuplicateShapeError",
  "RangeError",
]);

export function runScore(inputs: ScoreInputs): ScoreResult {
  let state: ScoreState = { phase: "formalize", inputs };

  try {
    while (true) {
      const handler = PHASE_HANDLERS[state.phase];
      const next = handler(state);
      if (next.judgment) {
        return {
          exitCode: 2,
          output: formatJudgment(next.judgment),
          state: next,
          judgment: next.judgment,
        };
      }
      const previousPhase = state.phase;
      state = next;
      if (state.phase === "emit" && state.output !== undefined) {
        return { exitCode: 0, output: state.output, state };
      }
      if (state.phase === previousPhase && state.phase !== "emit") {
        // Defensive: prevent infinite loop on a misconfigured non-terminal handler.
        throw new Error(`Phase handler ${previousPhase} did not advance`);
      }
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (NAMED_RUNTIME_ERRORS.has(err.name)) {
      return {
        exitCode: 1,
        output: `SCORE_ERROR: ${err.name}: ${err.message}`,
        state: { ...state, error: { name: err.name, message: err.message } },
      };
    }
    throw error;
  }
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
