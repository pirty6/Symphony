/**
 * build.ts — Hand-encoded SavedRun #01: log filename collision hardening.
 *
 * Real, concrete problem from the codebase: `fs.writeFileSync` in
 * `tools/meta-score/log.ts` does not pass the `wx` (exclusive create)
 * flag, so if two failures share a millisecond AND their 6-char base36
 * random suffixes collide, one log silently clobbers the other.
 *
 * The data below is hand-authored. The id is computed via the real
 * `computeScoreId` so the round-trip is honest and the example
 * exercises the persistence layer end-to-end.
 *
 * Run with:
 *   npx tsx tools/symphony/examples/01-log-collision/build.ts
 */

import * as path from "node:path";

import {
  computeScoreId,
  fingerprintProblem,
  saveRun,
} from "../../persistence";
import type {
  Beat,
  FrequencyMap,
  Level,
  Performance,
  PerformedBeat,
  Score,
  SavedRun,
  TempoConfig,
  Voice,
} from "../../types";

const PROBLEM_STATEMENT =
  "logFailure in tools/meta-score/log.ts uses fs.writeFileSync without the " +
  "exclusive-create (wx) flag. If two failures share a millisecond and " +
  "their 6-char base36 random suffixes collide, one log silently clobbers " +
  "the other. Add wx so the filesystem enforces uniqueness, with a brief " +
  "retry on EEXIST.";

const fingerprint = fingerprintProblem(PROBLEM_STATEMENT);

const frequencyMap: FrequencyMap = {
  levels: { 1: 0.9, 2: 0.6, 3: 0.0, 4: 0.4, 5: 0.0, 6: 0.0, 7: 0.0, 8: 0.0 },
  dominantLevels: [1, 2, 4] as readonly Level[],
  shape: "localized",
  key: "typescript/node-fs",
};

const tempo: TempoConfig = {
  conservatism: "conservative",
  beatsPerMeasure: 4,
};

const voice = (instrument: Voice["instrument"]): Voice => ({ instrument });

const beats: readonly Beat[] = [
  {
    level: 1,
    voices: [voice("strings")],
    directive: "Locate the fs.writeFileSync call in log.ts and document its current flags.",
  },
  {
    level: 2,
    voices: [voice("woodwinds")],
    directive: "Explore failure modes: what happens when the (timestamp, suffix) pair collides?",
  },
  {
    level: 4,
    voices: [voice("brass")],
    directive: "Assert the contract: log files are unique-by-creation, never overwritten.",
  },
  {
    level: 1,
    voices: [voice("brass")],
    directive: "Add { flag: 'wx' } to the writeFileSync options; wrap in retry-on-EEXIST loop.",
  },
  {
    level: 2,
    voices: [voice("brass")],
    directive: "Verify with a test that two simultaneous writes do not clobber.",
  },
];

const scoreNoIdNoTimestamp = {
  schemaVersion: 1 as const,
  frequencyMap,
  tempo,
  beats,
  generatedFrom: fingerprint,
};

const id = computeScoreId(scoreNoIdNoTimestamp);

const score: Score = {
  ...scoreNoIdNoTimestamp,
  id,
  generatedAt: "2026-04-29T00:00:00.000Z",
};

// ── Performance: synthetic but plausible ───────────────────────────
// stateHash values are placeholders representing file-content hashes
// of log.ts at each beat. They are stable across this static record.

const HASH_BEFORE = "sha256:logts-pre-fix-0000000000000000000000000000000000000000";
const HASH_AFTER = "sha256:logts-post-fix-000000000000000000000000000000000000000";

const performedBeats: readonly PerformedBeat[] = [
  {
    beatIndex: 0,
    voices: [
      {
        instrument: "strings",
        output:
          "writeFileSync at log.ts:117 is called with utf8 encoding and no flag option. Default flag is 'w' (truncate-and-write).",
        confidence: 0.95,
      },
    ],
    verdict: {
      outcome: "applied",
      confidence: 0.95,
      shouldTerminate: false,
      reason: "current-state mapped",
    },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 1,
    voices: [
      {
        instrument: "woodwinds",
        output:
          "Collision needs (a) same ISO ms, (b) same 6-char base36 suffix. Probability ~1/2^31 per-pair, but high under stress (concurrent test fixtures, retry storms).",
        confidence: 0.8,
      },
    ],
    verdict: {
      outcome: "applied",
      confidence: 0.8,
      shouldTerminate: false,
      reason: "failure mode characterized",
    },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 2,
    voices: [
      {
        instrument: "brass",
        output:
          "Contract: each invocation must produce a distinct log file. Filesystem-level enforcement is the only race-free option; userspace uniqueness can always lose to a check-then-act window.",
        confidence: 0.9,
      },
    ],
    verdict: {
      outcome: "applied",
      confidence: 0.9,
      shouldTerminate: false,
      reason: "contract asserted",
    },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 3,
    voices: [
      {
        instrument: "brass",
        output:
          "Patch: writeFileSync(filePath, body, { encoding: 'utf8', flag: 'wx' }). On EEXIST, regenerate suffix and retry up to N=5.",
        confidence: 0.9,
      },
    ],
    verdict: {
      outcome: "applied",
      confidence: 0.9,
      shouldTerminate: false,
      reason: "fix applied",
    },
    stateHash: HASH_AFTER,
  },
  {
    beatIndex: 4,
    voices: [
      {
        instrument: "brass",
        output:
          "Test added: two concurrent logFailure calls in same ms with stubbed Math.random produce two distinct files; without wx the test fails, with wx it passes.",
        confidence: 0.9,
      },
    ],
    verdict: {
      outcome: "applied",
      confidence: 0.9,
      shouldTerminate: true,
      reason: "fix verified",
    },
    stateHash: HASH_AFTER,
  },
];

const performance: Performance = {
  scoreId: id,
  beats: performedBeats,
  startedAt: "2026-04-29T00:00:01.000Z",
  completedAt: "2026-04-29T00:00:30.000Z",
  outcome: "success",
};

const run: SavedRun = { score, performance };

const outDir = path.resolve(__dirname);
saveRun(run, outDir);

process.stdout.write(`wrote example 01 → ${outDir}\n  scoreId=${id}\n`);
