/**
 * correlation.ts — pairwise correlation matrix for portfolio aggregation.
 *
 * Two correlation models are supported:
 *
 *   1. **Sector-equality** (legacy): two candidates in the same sector get
 *      correlation 1.0; different sectors get 0.0. Diagonal is always 1.0.
 *      This is a coarse heuristic kept as a fallback when daily-return data
 *      is unavailable.
 *
 *   2. **Realized Pearson correlation**: when both candidates supply a
 *      `dailyReturns` series of comparable length, compute
 *      `cov(r_A, r_B) / (σ_A · σ_B)` over the overlap of the two series.
 *      This is the right answer when the data exists.
 *
 * The hybrid builder picks per-pair: realized when both sides have returns,
 * sector-equality otherwise. It also reports the source per pair so the
 * portfolio output can label the column.
 */

export interface CorrelationInput {
  ticker: string;
  sector: string;
  /**
   * Optional daily return series. Pearson correlation is computed pairwise
   * over the overlap (truncated to the shorter of the two series, aligned
   * from the right — i.e. most-recent N days of each side).
   */
  dailyReturns?: readonly number[];
}

export type CorrelationMatrix = number[][];

export type CorrelationSource = "realized" | "sector-fallback";
export type CorrelationSourceMatrix = CorrelationSource[][];

export interface CorrelationBuildResult {
  matrix: CorrelationMatrix;
  sources: CorrelationSourceMatrix;
}

/**
 * Pearson correlation of two equal-length series. Returns 0 when either
 * series has zero variance (constant returns) — undefined correlation is
 * conservatively reported as no linear relationship.
 */
export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `pearsonCorrelation: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  const n = a.length;
  if (n < 2) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  const denom = Math.sqrt(varA) * Math.sqrt(varB);
  return cov / denom;
}

/**
 * Align two series from the right (most-recent end) to the shorter length.
 * Used so that two tickers with slightly different history depths still get
 * a comparable overlap window.
 */
function alignTrailing(a: readonly number[], b: readonly number[]): [number[], number[]] {
  const n = Math.min(a.length, b.length);
  return [a.slice(a.length - n), b.slice(b.length - n)];
}

/**
 * Legacy sector-equality builder. Kept for backward compatibility with
 * call-sites that don't carry daily-return data.
 */
export function buildSectorCorrelationMatrix(
  candidates: readonly CorrelationInput[],
): CorrelationMatrix {
  const n = candidates.length;
  const matrix: CorrelationMatrix = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else if (candidates[i].sector === candidates[j].sector) {
        matrix[i][j] = 1;
      } else {
        matrix[i][j] = 0;
      }
    }
  }
  return matrix;
}

/**
 * Hybrid builder. For each pair: if both sides have ≥20 daily returns,
 * compute realized Pearson correlation over the trailing overlap; otherwise
 * fall back to sector equality. The diagonal is 1.0 with source 'realized'
 * (a series is perfectly correlated with itself by definition).
 */
export function buildHybridCorrelationMatrix(
  candidates: readonly CorrelationInput[],
): CorrelationBuildResult {
  const n = candidates.length;
  const matrix: CorrelationMatrix = Array.from({ length: n }, () => Array(n).fill(0));
  const sources: CorrelationSourceMatrix = Array.from({ length: n }, () =>
    Array<CorrelationSource>(n).fill("sector-fallback"),
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
        sources[i][j] = "realized";
        continue;
      }
      const ri = candidates[i].dailyReturns;
      const rj = candidates[j].dailyReturns;
      if (ri && rj && ri.length >= 20 && rj.length >= 20) {
        const [a, b] = alignTrailing(ri, rj);
        matrix[i][j] = pearsonCorrelation(a, b);
        sources[i][j] = "realized";
      } else {
        matrix[i][j] =
          candidates[i].sector === candidates[j].sector ? 1 : 0;
        sources[i][j] = "sector-fallback";
      }
    }
  }
  return { matrix, sources };
}

/**
 * Average pairwise correlation for a subset, excluding the diagonal.
 * Returns 0 for subsets of size <= 1.
 */
export function averagePairwiseCorrelation(
  matrix: CorrelationMatrix,
  indices: readonly number[],
): number {
  if (indices.length <= 1) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      total += matrix[indices[i]][indices[j]];
      pairs++;
    }
  }
  return total / pairs;
}

/**
 * For a subset, summarise whether the off-diagonal correlations were all
 * realized, all sector-fallback, or mixed.
 */
export function subsetCorrelationSource(
  sources: CorrelationSourceMatrix,
  indices: readonly number[],
): CorrelationSource | "mixed" {
  if (indices.length <= 1) return "realized";
  let sawRealized = false;
  let sawFallback = false;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      const s = sources[indices[i]][indices[j]];
      if (s === "realized") sawRealized = true;
      else sawFallback = true;
    }
  }
  if (sawRealized && sawFallback) return "mixed";
  return sawRealized ? "realized" : "sector-fallback";
}
