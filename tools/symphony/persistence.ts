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
  ExecutableScore,
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
 *
 * Optional fields (`pattern`, `context`) are hashed only when present, so
 * pre-pattern saved runs retain their original ids.
 */
export function computeExecutableScoreId(
  score: Omit<ExecutableScore, "id" | "generatedAt">,
): string {
  const base: Record<string, unknown> = {
    schemaVersion: score.schemaVersion,
    frequencyMap: score.frequencyMap,
    beats: score.beats,
    generatedFrom: score.generatedFrom,
  };
  if (score.pattern !== undefined) {
    base["pattern"] = score.pattern;
  }
  if (score.context !== undefined) {
    base["context"] = score.context;
  }
  return sha256(JSON.stringify(base));
}

// ── IO ─────────────────────────────────────────────────────────────
//
// Storage layout (append-only):
//   tools/scores/store/<patternName>/<problemFingerprint>-<timestamp>.json
//
// One JSON file per execution. Filename encodes the two natural keys
// (problem + when), folder encodes the third (pattern). The full
// SavedRun JSON wraps a snapshot of the PatternScore, the compiled
// ExecutableScore, and the Performance — making each file
// self-describing even after the pattern's TS module is later edited.

const STORE_DIR = path.join("tools", "scores", "store");

function safeFingerprintSlice(fingerprint: string): string {
  return fingerprint.slice(0, 16);
}

function safeTimestampSlug(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

/**
 * Build the canonical store path for a SavedRun. The pattern subfolder
 * is created if it does not exist. Filename format:
 *   <fp16>-<ts-with-dashes>.json
 * fp16 is the first 16 hex chars of the problem fingerprint — enough
 * to disambiguate manually-listed files without bloating the path.
 */
export function savedRunPath(run: SavedRun, root: string = STORE_DIR): string {
  const patternName = run.patternScore.pattern;
  const fp = safeFingerprintSlice(run.problemFingerprint);
  const ts = safeTimestampSlug(run.timestamp);
  return path.join(root, patternName, `${fp}-${ts}.json`);
}

/**
 * Persist a SavedRun under tools/scores/store/<pattern>/. The whole
 * SavedRun (snapshot + executable + performance) is written as a
 * single JSON file; there are no separate score.json / performance.json
 * files anymore.
 */
export function saveRun(run: SavedRun, root: string = STORE_DIR): string {
  const file = savedRunPath(run, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(run, undefined, 2) + "\n", "utf8");
  return file;
}

export function loadExecutableScore(filePath: string): ExecutableScore {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as ExecutableScore;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported ExecutableScore schemaVersion: ${parsed.schemaVersion} (expected 1) at ${filePath}`,
    );
  }
  return parsed;
}

export function loadPerformance(filePath: string): Performance {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as Performance;
}

/**
 * Load a SavedRun JSON file from the store. Validates the inner
 * (executableScore.id, performance.scoreId, beatIndex) consistency
 * the same way as before.
 */
export function loadRun(filePath: string): SavedRun {
  const raw = fs.readFileSync(filePath, "utf8");
  const run = JSON.parse(raw) as SavedRun;
  if (run.schemaVersion !== 1) {
    throw new Error(
      `unsupported SavedRun schemaVersion: ${run.schemaVersion} (expected 1) at ${filePath}`,
    );
  }
  if (run.executableScore.schemaVersion !== 1) {
    throw new Error(
      `unsupported ExecutableScore schemaVersion: ${run.executableScore.schemaVersion} at ${filePath}`,
    );
  }
  if (run.performance.scoreId !== run.executableScore.id) {
    throw new Error(
      `Performance.scoreId ${run.performance.scoreId} does not match ExecutableScore.id ${run.executableScore.id}`,
    );
  }
  run.performance.beats.forEach((b, i) => {
    if (b.beatIndex !== i) {
      throw new Error(`Performance.beats[${i}].beatIndex=${b.beatIndex} (expected ${i})`);
    }
  });
  return run;
}

// ── Divergence ─────────────────────────────────────────────────────

function verdictsEqual(a: MoveVerdict | undefined, b: MoveVerdict | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return (
    a.outcome === b.outcome &&
    a.confidence === b.confidence &&
    a.shouldTerminate === b.shouldTerminate &&
    a.reason === b.reason
  );
}

function proseDiffersAtBeat(saved: PerformedBeat, fresh: PerformedBeat): boolean {
  if (saved.voices.length !== fresh.voices.length) {
    return true;
  }
  for (let i = 0; i < saved.voices.length; i += 1) {
    if (saved.voices[i].output !== fresh.voices[i].output) {
      return true;
    }
  }
  return false;
}

/**
 * Compare a saved Performance against a fresh one for the same Score.
 * Callers should treat `structural || semantic.length > 0` as the
 * canonical "did not reproduce" predicate. Environmental drift surfaces
 * as a warning; prose drift is informational only.
 */
export function detectDivergence(saved: Performance, fresh: Performance): DivergenceReport {
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

  for (let i = 0; i < saved.beats.length; i += 1) {
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

    if (proseDiffersAtBeat(s, f)) {
      prose += 1;
    }
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
