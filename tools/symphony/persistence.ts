/**
 * persistence.ts — Save, load, and replay-divergence detection for SavedRuns.
 *
 * The persistence layer is intentionally dumb: JSON in, JSON out, one
 * file per artifact. Schema drift is detected by reading
 * `Score.schemaVersion` on load and refusing anything other than 1.
 *
 * Replay semantics are encoded in `detectDivergence`. Two performances
 * of the same Score are considered to have *reproduced* if and only if:
 *   - the structural shape matches (same beat count and shape)
 *   - no semantic verdict deltas exist
 * Environmental drift (stateHash differs) is a soft warning — it usually
 * just means the codebase moved underneath the replay. Prose drift
 * (different voice outputs at otherwise-identical beats) is expected and
 * informational only.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  DivergenceReport,
  HashDelta,
  MoveVerdict,
  Performance,
  PerformedBeat,
  ProblemFingerprint,
  SavedRun,
  Score,
  VerdictDelta,
} from "./types";

// ── Hashing ────────────────────────────────────────────────────────

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Build a ProblemFingerprint from a raw problem statement.
 *
 * v1 canonicalizer is identity: rawHash === canonicalHash. The two-hash
 * shape is preserved so that future canonicalizer versions can diverge
 * from raw hashing without breaking the stored format.
 */
export function fingerprintProblem(statement: string): ProblemFingerprint {
  const raw = sha256(statement);
  return { rawHash: raw, canonicalHash: raw, schemaVersion: 1 };
}

/**
 * Compute a deterministic Score id from its content. Excludes
 * `id` and `generatedAt` so the id is stable across re-serializations.
 */
export function computeScoreId(
  score: Omit<Score, "id" | "generatedAt">,
): string {
  const payload = JSON.stringify({
    schemaVersion: score.schemaVersion,
    frequencyMap: score.frequencyMap,
    tempo: score.tempo,
    beats: score.beats,
    generatedFrom: score.generatedFrom,
  });
  return sha256(payload);
}

// ── IO ─────────────────────────────────────────────────────────────

const SCORE_FILE = "score.json";
const PERFORMANCE_FILE = "performance.json";

/**
 * Persist a SavedRun to a directory. Writes two files:
 *   <dir>/score.json
 *   <dir>/performance.json
 * The directory is created if it does not exist.
 */
export function saveRun(run: SavedRun, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, SCORE_FILE),
    JSON.stringify(run.score, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, PERFORMANCE_FILE),
    JSON.stringify(run.performance, null, 2) + "\n",
    "utf8",
  );
}

export function loadScore(filePath: string): Score {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Score;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported Score schemaVersion: ${parsed.schemaVersion} (expected 1) at ${filePath}`,
    );
  }
  return parsed;
}

export function loadPerformance(filePath: string): Performance {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as Performance;
}

export function loadRun(dir: string): SavedRun {
  const score = loadScore(path.join(dir, SCORE_FILE));
  const performance = loadPerformance(path.join(dir, PERFORMANCE_FILE));
  if (performance.scoreId !== score.id) {
    throw new Error(
      `Performance.scoreId ${performance.scoreId} does not match Score.id ${score.id}`,
    );
  }
  // Consistency: PerformedBeat[i].beatIndex must equal i. This catches
  // re-ordered or partially-reconstructed performances at load time
  // rather than letting the divergence detector silently compare beats
  // at mismatched positions.
  performance.beats.forEach((b, i) => {
    if (b.beatIndex !== i) {
      throw new Error(
        `Performance.beats[${i}].beatIndex=${b.beatIndex} (expected ${i})`,
      );
    }
  });
  return { score, performance };
}

// ── Divergence ─────────────────────────────────────────────────────

function verdictsEqual(
  a: MoveVerdict | null,
  b: MoveVerdict | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.outcome === b.outcome &&
    a.confidence === b.confidence &&
    a.shouldTerminate === b.shouldTerminate &&
    a.reason === b.reason
  );
}

function proseDiffersAtBeat(
  saved: PerformedBeat,
  fresh: PerformedBeat,
): boolean {
  if (saved.voices.length !== fresh.voices.length) return true;
  for (let i = 0; i < saved.voices.length; i++) {
    if (saved.voices[i].output !== fresh.voices[i].output) return true;
  }
  return false;
}

/**
 * Compare a saved Performance against a fresh one for the same Score.
 * Callers should treat `structural || semantic.length > 0` as the
 * canonical "did not reproduce" predicate. Environmental drift surfaces
 * as a warning; prose drift is informational only.
 */
export function detectDivergence(
  saved: Performance,
  fresh: Performance,
): DivergenceReport {
  if (saved.scoreId !== fresh.scoreId) {
    return {
      structural: true,
      semantic: [],
      environmental: [],
      prose: 0,
    };
  }

  if (saved.beats.length !== fresh.beats.length) {
    return {
      structural: true,
      semantic: [],
      environmental: [],
      prose: 0,
    };
  }

  const semantic: VerdictDelta[] = [];
  const environmental: HashDelta[] = [];
  let prose = 0;

  for (let i = 0; i < saved.beats.length; i++) {
    const s = saved.beats[i];
    const f = fresh.beats[i];

    if (s.beatIndex !== f.beatIndex) {
      // Structural shape mismatch even though counts agree.
      return {
        structural: true,
        semantic: [],
        environmental: [],
        prose: 0,
      };
    }

    if (!verdictsEqual(s.verdict, f.verdict)) {
      semantic.push({ beatIndex: i, saved: s.verdict, fresh: f.verdict });
    }

    if (s.stateHash !== f.stateHash) {
      environmental.push({
        beatIndex: i,
        saved: s.stateHash,
        fresh: f.stateHash,
      });
    }

    if (proseDiffersAtBeat(s, f)) prose += 1;
  }

  return { structural: false, semantic, environmental, prose };
}

/**
 * Convenience: did the fresh run reproduce the saved one?
 * True iff there is no structural or semantic divergence.
 */
export function reproduced(report: DivergenceReport): boolean {
  return !report.structural && report.semantic.length === 0;
}
