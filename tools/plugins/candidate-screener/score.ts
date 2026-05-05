/**
 * score.ts — Symphony Score for the candidate-screener.
 *
 * Phase order: validate → filter → tag-distribution → emit
 * Exit codes: 0 = success, 1 = fatal validation error, 2 = judgment requested.
 *
 * Filter and distribution-kind registries are co-located here for compactness.
 * Each is keyed by name, and adding a new filter or distribution requires only
 * a single registerXxx() call — score logic itself never references a filter
 * or distribution by name.
 */

export type DistributionKind =
  | "EARNINGS"
  | "FDA_BINARY"
  | "MACRO_SENSITIVE"
  | "SECTOR_ROTATION";

export interface RawCandidate {
  ticker: string;
  sector: string;
  spot: number;
  ivRank: number;
  openInterest: number;
  catalyst: {
    kind: DistributionKind;
    description: string;
    date: string; // ISO date
  };
  /**
   * Optional: actual ATM IV for the nearest post-event expiry, fetched from
   * an options chain. When provided, the portfolio-runner uses this value
   * directly instead of the linear ivRank → ivPre heuristic.
   */
  ivPre?: number;
  /**
   * Optional provenance flag for `ivRank`.
   *   'hv-proxy'   — rank computed from realized vol percentile (proxy used
   *                  before native ATM-IV history is available). This is the
   *                  current default emitted by tools/market-data/fetch.py.
   *   'iv-history' — rank computed from accumulated ATM-IV history for this
   *                  ticker. Honest IV rank. Requires the iv-history sidecar
   *                  log to have run for ~3+ months.
   * Absent = hv-proxy (backward compat). Down-stream consumers that care about
   * confidence (e.g. sizing, gating) should branch on this field.
   */
  ivRankSource?: "hv-proxy" | "iv-history";
  /**
   * Optional: last N earnings-day percentage moves (e.g. 8 quarters).
   * When >= 4 entries are provided AND the catalyst kind is EARNINGS, the
   * screener replaces the registry-default scenario distribution with a
   * per-ticker empirical distribution built from these observations.
   */
  historicalMoves?: number[];
  /**
   * Optional: last 20–30 daily log-returns. Used by the portfolio-runner to
   * compute a real Pearson correlation between candidates instead of the
   * sector-string-equality heuristic. Each entry is a fraction (e.g. 0.012
   * means +1.2% on that day), not a percentage. Pairs that lack this field
   * fall back to the sector-equality correlation.
   */
  dailyReturns30d?: number[];
  /**
   * Optional per-candidate hedge override. When all three fields are present,
   * the portfolio-runner injects them into the MarketContext so the sim
   * hedges against the candidate's own sector ETF instead of the global
   * default. Candidates without these fields fall back to the default hedge
   * (geo-tail proxy).
   */
  hedgeTicker?: string;
  hedgeSpot?: number;
  hedgeIv?: number;
}

export interface ScreenedCandidate extends RawCandidate {
  scenarioDistribution: ScenarioDistribution;
}

export interface ScreenerInputs {
  watchlist: RawCandidate[];
  weekOf: string; // ISO date, Monday of the target week
  seed: number;
  minIvRank: number;
  priceMin: number;
  priceMax: number;
  sectorCap: number;
  eventWindowDays: number;
}

export interface ScreenerResult {
  exitCode: 0 | 1 | 2;
  output: string;
  candidates: ScreenedCandidate[];
  judgment?: JudgmentRequest;
}

export interface JudgmentRequest {
  type: string;
  reviewContext: Record<string, string>;
  composerInstructions: string;
  instrumentInstructions: string;
}

// ── Errors (named only) ────────────────────────────────────────────

export class InvalidWatchlistError extends Error {
  constructor(reason: string) {
    super(`Invalid watchlist: ${reason}`);
    this.name = "InvalidWatchlistError";
  }
}

export class InvalidScreenerInputError extends Error {
  constructor(field: string, value: unknown, reason: string) {
    super(`Invalid screener input: ${field}=${String(value)} (${reason})`);
    this.name = "InvalidScreenerInputError";
  }
}

export class UnimplementedDistributionError extends Error {
  constructor(kind: DistributionKind) {
    super(
      `Scenario distribution kind '${kind}' is not yet implemented. TODO: add a builtin distribution for ${kind}.`,
    );
    this.name = "UnimplementedDistributionError";
  }
}

export class DuplicateFilterError extends Error {
  constructor(name: string) {
    super(`Filter '${name}' is already registered`);
    this.name = "DuplicateFilterError";
  }
}

export class DuplicateDistributionError extends Error {
  constructor(kind: DistributionKind) {
    super(`Distribution '${kind}' is already registered`);
    this.name = "DuplicateDistributionError";
  }
}

// ── Filter registry ───────────────────────────────────────────────

export interface CandidateFilter {
  readonly name: string;
  apply(candidate: RawCandidate, inputs: ScreenerInputs): boolean;
  reason(candidate: RawCandidate, inputs: ScreenerInputs): string;
}

const FILTER_REGISTRY = new Map<string, CandidateFilter>();

export function registerFilter(filter: CandidateFilter): void {
  if (FILTER_REGISTRY.has(filter.name)) {
    throw new DuplicateFilterError(filter.name);
  }
  FILTER_REGISTRY.set(filter.name, filter);
}

export function listFilters(): CandidateFilter[] {
  return [...FILTER_REGISTRY.values()];
}

export function clearFilterRegistry(): void {
  FILTER_REGISTRY.clear();
}

// ── Distribution registry ─────────────────────────────────────────

export interface ScenarioBucket {
  name: string;
  probability: number;
  minMovePct: number;
  maxMovePct: number;
}

export interface ScenarioDistribution {
  kind: DistributionKind;
  buckets: readonly ScenarioBucket[];
}

const DISTRIBUTION_REGISTRY = new Map<DistributionKind, ScenarioDistribution>();

export function registerDistribution(distribution: ScenarioDistribution): void {
  if (DISTRIBUTION_REGISTRY.has(distribution.kind)) {
    throw new DuplicateDistributionError(distribution.kind);
  }
  const total = distribution.buckets.reduce((acc, b) => acc + b.probability, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new RangeError(
      `Distribution '${distribution.kind}' probabilities must sum to 1.0, got ${total}`,
    );
  }
  DISTRIBUTION_REGISTRY.set(distribution.kind, distribution);
}

export function getDistribution(kind: DistributionKind): ScenarioDistribution {
  const dist = DISTRIBUTION_REGISTRY.get(kind);
  if (!dist) throw new UnimplementedDistributionError(kind);
  return dist;
}

export function clearDistributionRegistry(): void {
  DISTRIBUTION_REGISTRY.clear();
}

// ── Built-in filters ──────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseISODate(s: string, field: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new InvalidScreenerInputError(field, s, "must be ISO date YYYY-MM-DD");
  }
  return d;
}

export const binaryEventWindowFilter: CandidateFilter = {
  name: "binary-event-window",
  apply(candidate, inputs) {
    const week = parseISODate(inputs.weekOf, "weekOf");
    const event = parseISODate(candidate.catalyst.date, "catalyst.date");
    const diffDays = (event.getTime() - week.getTime()) / ONE_DAY_MS;
    return diffDays >= 0 && diffDays <= inputs.eventWindowDays;
  },
  reason(candidate, inputs) {
    return `catalyst date ${candidate.catalyst.date} not within ${inputs.eventWindowDays}d of week-of ${inputs.weekOf}`;
  },
};

export const ivRankFilter: CandidateFilter = {
  name: "iv-rank",
  apply(candidate, inputs) {
    return candidate.ivRank >= inputs.minIvRank;
  },
  reason(candidate, inputs) {
    return `IV rank ${candidate.ivRank} below threshold ${inputs.minIvRank}`;
  },
};

export const liquidityFilter: CandidateFilter = {
  name: "liquidity",
  apply(candidate) {
    return candidate.openInterest > 1000;
  },
  reason(candidate) {
    return `open interest ${candidate.openInterest} below 1000`;
  },
};

export const priceRangeFilter: CandidateFilter = {
  name: "price-range",
  apply(candidate, inputs) {
    return candidate.spot >= inputs.priceMin && candidate.spot <= inputs.priceMax;
  },
  reason(candidate, inputs) {
    return `spot ${candidate.spot} outside [${inputs.priceMin}, ${inputs.priceMax}]`;
  },
};

// Sector diversity is applied across the surviving set, not per-candidate.

// ── Built-in distributions ────────────────────────────────────────

// Earnings distribution mirrors the AAPL_SCENARIOS shape from the optimizer.
// Calibrated to a typical mega-cap pre-earnings setup; portfolio-runner can
// override per-ticker if needed.
export const EARNINGS_DISTRIBUTION: ScenarioDistribution = {
  kind: "EARNINGS",
  buckets: [
    { name: "CLEAN_BEAT", probability: 0.30, minMovePct: 4, maxMovePct: 8 },
    { name: "BEAT_AND_FADE", probability: 0.22, minMovePct: -1, maxMovePct: 2 },
    { name: "INLINE", probability: 0.15, minMovePct: -2, maxMovePct: 2 },
    { name: "SOFT_GUIDE", probability: 0.13, minMovePct: -6, maxMovePct: -3 },
    { name: "TRANSITION_SHOCK", probability: 0.10, minMovePct: -9, maxMovePct: -5 },
    { name: "CLEAN_MISS", probability: 0.10, minMovePct: -12, maxMovePct: -7 },
  ],
};

// Default registration. Tests can clear and re-register for isolation.
function registerDefaults(): void {
  if (FILTER_REGISTRY.size === 0) {
    registerFilter(binaryEventWindowFilter);
    registerFilter(ivRankFilter);
    registerFilter(liquidityFilter);
    registerFilter(priceRangeFilter);
  }
  if (!DISTRIBUTION_REGISTRY.has("EARNINGS")) {
    registerDistribution(EARNINGS_DISTRIBUTION);
  }
}

// ── Phase logic ───────────────────────────────────────────────────

function phaseValidate(inputs: ScreenerInputs): void {
  if (!Array.isArray(inputs.watchlist) || inputs.watchlist.length === 0) {
    throw new InvalidWatchlistError("watchlist must be a non-empty array");
  }
  for (const c of inputs.watchlist) {
    if (!c.ticker || typeof c.ticker !== "string") {
      throw new InvalidWatchlistError(`candidate missing ticker: ${JSON.stringify(c)}`);
    }
    if (!c.sector || typeof c.sector !== "string") {
      throw new InvalidWatchlistError(`${c.ticker}: sector required`);
    }
    if (!Number.isFinite(c.spot) || c.spot <= 0) {
      throw new InvalidWatchlistError(`${c.ticker}: spot must be positive`);
    }
    if (!Number.isFinite(c.ivRank) || c.ivRank < 0 || c.ivRank > 100) {
      throw new InvalidWatchlistError(`${c.ticker}: ivRank must be in [0, 100]`);
    }
    if (!Number.isFinite(c.openInterest) || c.openInterest < 0) {
      throw new InvalidWatchlistError(`${c.ticker}: openInterest must be >= 0`);
    }
    if (!c.catalyst || !c.catalyst.kind || !c.catalyst.date) {
      throw new InvalidWatchlistError(`${c.ticker}: catalyst.kind and catalyst.date required`);
    }
    if (c.ivPre !== undefined) {
      if (!Number.isFinite(c.ivPre) || c.ivPre <= 0 || c.ivPre >= 5) {
        throw new InvalidWatchlistError(
          `${c.ticker}: ivPre must be a finite number in (0, 5) when provided (e.g. 0.38 for 38%)`,
        );
      }
    }
    if (c.ivRankSource !== undefined) {
      if (c.ivRankSource !== "hv-proxy" && c.ivRankSource !== "iv-history") {
        throw new InvalidWatchlistError(
          `${c.ticker}: ivRankSource must be 'hv-proxy' or 'iv-history' when provided`,
        );
      }
    }
    if (c.historicalMoves !== undefined) {
      if (!Array.isArray(c.historicalMoves) || c.historicalMoves.length > 32) {
        throw new InvalidWatchlistError(
          `${c.ticker}: historicalMoves must be an array of at most 32 numeric % moves`,
        );
      }
      for (const m of c.historicalMoves) {
        if (!Number.isFinite(m) || Math.abs(m) > 100) {
          throw new InvalidWatchlistError(
            `${c.ticker}: each historicalMoves entry must be a finite percentage in [-100, 100]`,
          );
        }
      }
    }
    if (c.dailyReturns30d !== undefined) {
      if (
        !Array.isArray(c.dailyReturns30d) ||
        c.dailyReturns30d.length < 20 ||
        c.dailyReturns30d.length > 30
      ) {
        throw new InvalidWatchlistError(
          `${c.ticker}: dailyReturns30d must be an array of 20–30 numeric daily returns when provided`,
        );
      }
      for (const r of c.dailyReturns30d) {
        if (!Number.isFinite(r) || Math.abs(r) > 0.5) {
          throw new InvalidWatchlistError(
            `${c.ticker}: each dailyReturns30d entry must be a finite fraction with |value| ≤ 0.5 (e.g. 0.012 for +1.2%)`,
          );
        }
      }
    }
    // Hedge override: all-or-nothing. Either all three fields are present or
    // none are. This prevents partial hedge specs from silently inheriting
    // wrong defaults (e.g. PFE spot with XLE IV).
    const hedgeFieldsPresent = [c.hedgeTicker, c.hedgeSpot, c.hedgeIv].filter(
      (v) => v !== undefined,
    ).length;
    if (hedgeFieldsPresent !== 0 && hedgeFieldsPresent !== 3) {
      throw new InvalidWatchlistError(
        `${c.ticker}: hedgeTicker, hedgeSpot, and hedgeIv must all be provided together (got ${hedgeFieldsPresent}/3)`,
      );
    }
    if (c.hedgeTicker !== undefined) {
      if (typeof c.hedgeTicker !== "string" || c.hedgeTicker.length === 0) {
        throw new InvalidWatchlistError(`${c.ticker}: hedgeTicker must be a non-empty string`);
      }
      if (!Number.isFinite(c.hedgeSpot as number) || (c.hedgeSpot as number) <= 0) {
        throw new InvalidWatchlistError(`${c.ticker}: hedgeSpot must be a positive number`);
      }
      if (
        !Number.isFinite(c.hedgeIv as number) ||
        (c.hedgeIv as number) <= 0 ||
        (c.hedgeIv as number) >= 5
      ) {
        throw new InvalidWatchlistError(
          `${c.ticker}: hedgeIv must be a finite number in (0, 5) (e.g. 0.22 for 22%)`,
        );
      }
    }
  }
  parseISODate(inputs.weekOf, "weekOf");
  if (!Number.isInteger(inputs.seed) || inputs.seed < 0) {
    throw new InvalidScreenerInputError("seed", inputs.seed, "non-negative integer required");
  }
  if (!Number.isFinite(inputs.minIvRank) || inputs.minIvRank < 0 || inputs.minIvRank > 100) {
    throw new InvalidScreenerInputError("minIvRank", inputs.minIvRank, "must be in [0, 100]");
  }
  if (!Number.isFinite(inputs.priceMin) || inputs.priceMin < 0) {
    throw new InvalidScreenerInputError("priceMin", inputs.priceMin, "must be >= 0");
  }
  if (!Number.isFinite(inputs.priceMax) || inputs.priceMax <= inputs.priceMin) {
    throw new InvalidScreenerInputError(
      "priceMax",
      inputs.priceMax,
      "must be > priceMin",
    );
  }
  if (!Number.isInteger(inputs.sectorCap) || inputs.sectorCap < 1) {
    throw new InvalidScreenerInputError(
      "sectorCap",
      inputs.sectorCap,
      "must be a positive integer",
    );
  }
  if (!Number.isInteger(inputs.eventWindowDays) || inputs.eventWindowDays < 1) {
    throw new InvalidScreenerInputError(
      "eventWindowDays",
      inputs.eventWindowDays,
      "must be a positive integer",
    );
  }
}

function applyPerCandidateFilters(inputs: ScreenerInputs): RawCandidate[] {
  const filters = listFilters();
  return inputs.watchlist.filter((candidate) =>
    filters.every((f) => f.apply(candidate, inputs)),
  );
}

function applySectorDiversity(
  candidates: RawCandidate[],
  cap: number,
): RawCandidate[] {
  // Within each sector, keep the top-`cap` by ivRank (deterministic tiebreak by ticker).
  const sorted = [...candidates].sort((a, b) => {
    if (b.ivRank !== a.ivRank) return b.ivRank - a.ivRank;
    return a.ticker.localeCompare(b.ticker);
  });
  const counts = new Map<string, number>();
  const kept: RawCandidate[] = [];
  for (const c of sorted) {
    const used = counts.get(c.sector) ?? 0;
    if (used < cap) {
      kept.push(c);
      counts.set(c.sector, used + 1);
    }
  }
  return kept;
}

function tagDistributions(candidates: RawCandidate[]): {
  tagged: ScreenedCandidate[];
  unimplemented: DistributionKind[];
  perTickerEmpirical: string[];
} {
  const tagged: ScreenedCandidate[] = [];
  const unimplemented: DistributionKind[] = [];
  const perTickerEmpirical: string[] = [];
  for (const candidate of candidates) {
    try {
      const empirical = maybeBuildEmpiricalDistribution(candidate);
      const dist = empirical ?? getDistribution(candidate.catalyst.kind);
      if (empirical) perTickerEmpirical.push(candidate.ticker);
      tagged.push({ ...candidate, scenarioDistribution: dist });
    } catch (err) {
      if (err instanceof UnimplementedDistributionError) {
        unimplemented.push(candidate.catalyst.kind);
      } else {
        throw err;
      }
    }
  }
  return { tagged, unimplemented, perTickerEmpirical };
}

/**
 * Build a non-parametric scenario distribution from a candidate's historical
 * earnings-day moves. Each observation becomes a bucket with equal probability
 * 1/N. The sampling band around each observation is ±σ/4, where σ is the
 * sample standard deviation of the moves. This scales the band with the
 * ticker's realized volatility instead of using a fixed ±0.5% (which was
 * arbitrary and produced artificial gaps for high-vol tickers). A floor of
 * ±0.25% is applied for very low-σ samples to avoid degenerate near-point
 * masses. This is still non-parametric — bucket centers come from observations,
 * not from a fitted Gaussian — so skew and kurtosis are preserved.
 *
 * Returns null when:
 *   - historicalMoves is absent or has < 4 entries (sample too small)
 *   - catalyst kind is not EARNINGS (FDA / macro distributions need different treatment)
 */
export function maybeBuildEmpiricalDistribution(
  candidate: RawCandidate,
): ScenarioDistribution | null {
  if (candidate.catalyst.kind !== "EARNINGS") return null;
  const moves = candidate.historicalMoves;
  if (!Array.isArray(moves) || moves.length < 4) return null;

  const N = moves.length;
  const probability = 1 / N;
  const mean = moves.reduce((a, b) => a + b, 0) / N;
  const variance =
    moves.reduce((acc, m) => acc + (m - mean) * (m - mean), 0) / (N - 1);
  const stdev = Math.sqrt(variance);
  const halfBand = Math.max(stdev / 4, 0.25);
  const buckets: ScenarioBucket[] = moves.map((move, idx) => ({
    name: `${candidate.ticker}_HIST_${idx + 1}`,
    probability,
    minMovePct: move - halfBand,
    maxMovePct: move + halfBand,
  }));
  // Renormalise the last bucket to absorb floating-point drift in the sum.
  const sumExceptLast = buckets.slice(0, -1).reduce((a, b) => a + b.probability, 0);
  buckets[buckets.length - 1] = {
    ...buckets[buckets.length - 1],
    probability: 1 - sumExceptLast,
  };
  return { kind: "EARNINGS", buckets };
}

// ── Public entry ─────────────────────────────────────────────────

export function runScreener(inputs: ScreenerInputs): ScreenerResult {
  registerDefaults();

  try {
    phaseValidate(inputs);
    const passed = applyPerCandidateFilters(inputs);
    const diversified = applySectorDiversity(passed, inputs.sectorCap);
    const { tagged, unimplemented, perTickerEmpirical } = tagDistributions(diversified);

    if (tagged.length === 0) {
      const judgment: JudgmentRequest = {
        type: "no-candidates",
        reviewContext: {
          WATCHLIST_SIZE: String(inputs.watchlist.length),
          PASSED_FILTERS: String(passed.length),
          AFTER_DIVERSITY: String(diversified.length),
          UNIMPLEMENTED_DISTRIBUTIONS:
            unimplemented.length > 0 ? unimplemented.join(",") : "(none)",
        },
        composerInstructions:
          "No candidates survived the screen. Re-invoke with a larger watchlist, lower --min-iv-rank, wider --price-min/--price-max, or implement missing distribution kinds.",
        instrumentInstructions:
          "ALLOWED TOOLS: read_file, list_dir. Inspect tools/plugins/candidate-screener/score.ts to add a new built-in distribution if the unimplemented set is non-empty.",
      };
      return {
        exitCode: 2,
        output: formatJudgment(judgment),
        candidates: [],
        judgment,
      };
    }

    const lines = [
      `SCREENER: candidate-screener | week-of=${inputs.weekOf}`,
      `Watchlist=${inputs.watchlist.length} → passed=${passed.length} → diversified=${diversified.length} → tagged=${tagged.length}${
        unimplemented.length > 0
          ? ` (skipped ${unimplemented.length} unimplemented distribution kinds: ${unimplemented.join(",")})`
          : ""
      }`,
      perTickerEmpirical.length > 0
        ? `Per-ticker empirical distributions built from historicalMoves for: ${perTickerEmpirical.join(",")}`
        : "All candidates use the registry-default scenario distribution (no historicalMoves provided).",
      "",
      formatCandidatesTable(tagged),
      "",
      "CANDIDATES_JSON_BEGIN",
      JSON.stringify(tagged, null, 2),
      "CANDIDATES_JSON_END",
    ];
    return { exitCode: 0, output: lines.join("\n"), candidates: tagged };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      exitCode: 1,
      output: `SCREENER_ERROR: ${err.name}: ${err.message}`,
      candidates: [],
    };
  }
}

// ── Formatting helpers ────────────────────────────────────────────

function formatCandidatesTable(candidates: readonly ScreenedCandidate[]): string {
  const header = "Ticker | Sector | Spot | IV Rank | Open Interest | Catalyst | Date | Distribution";
  const divider = "---|---|---:|---:|---:|---|---|---";
  const rows = candidates.map((c) =>
    [
      c.ticker,
      c.sector,
      c.spot.toFixed(2),
      c.ivRank.toFixed(1),
      c.openInterest.toString(),
      c.catalyst.description,
      c.catalyst.date,
      c.scenarioDistribution.kind,
    ].join(" | "),
  );
  return [header, divider, ...rows].join("\n");
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
