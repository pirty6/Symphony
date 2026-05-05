/**
 * build.ts — Hand-encoded SavedRun #02: dual source of truth for phase order.
 *
 * Real problem: `inferPhase` in `tools/meta-score/log.ts` encodes the
 * 8-phase ordering as a hard-coded if/else chain over MetaScoreInput
 * fields. The same ordering also lives in `MetaScorePhase` enum in
 * `tools/meta-score/meta-score.ts`. Nothing enforces the two stay in
 * sync — adding a phase requires editing both files in lockstep.
 *
 * This is a system-contract problem (one ordering, two encodings), with
 * a module-behavior dimension (inferPhase's responsibility) and a
 * concrete fix (extract a single phase-order table).
 *
 * Run with:
 *   npx tsx tools/symphony/examples/02-phase-order-dup/build.ts
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
  "The 8-phase ordering of meta-score is encoded twice: once as the " +
  "MetaScorePhase enum in meta-score.ts and once as the if-chain in " +
  "inferPhase() in log.ts. Adding or reordering a phase requires editing " +
  "both. The contract — phase order — should have one canonical source, " +
  "with both consumers deriving from it.";

const fingerprint = fingerprintProblem(PROBLEM_STATEMENT);

const frequencyMap: FrequencyMap = {
  levels: { 1: 0.3, 2: 0.5, 3: 0.9, 4: 0.8, 5: 0.2, 6: 0.0, 7: 0.0, 8: 0.0 },
  dominantLevels: [2, 3, 4] as readonly Level[],
  shape: "layered",
  key: "typescript/internal-api",
};

const tempo: TempoConfig = {} as TempoConfig;

const voice = (instrument: Voice["instrument"]): Voice => ({ instrument });

const beats: readonly Beat[] = [
  {
    level: 3,
    voices: [voice("strings")],
    directive: "Map both encodings: list the phase order as expressed in MetaScorePhase enum and in inferPhase's if-chain.",
  },
  {
    level: 4,
    voices: [voice("brass")],
    directive: "State the contract: there is one canonical phase order; all consumers must derive from it.",
  },
  {
    level: 4,
    voices: [voice("woodwinds")],
    directive: "Explore extraction shapes: array of {phase, requiredField}? class? const tuple? Which preserves narrowing best?",
  },
  {
    level: 3,
    voices: [voice("piano")],
    directive: "Integrate: a single PHASE_ORDER table satisfies both consumers — enum.values() and inferPhase iteration.",
  },
  {
    level: 2,
    voices: [voice("brass")],
    directive: "Apply: replace MetaScorePhase enum and inferPhase if-chain with PHASE_ORDER lookup. Adjust call sites.",
  },
  {
    level: 1,
    voices: [voice("brass")],
    directive: "Verify: run existing tests; add a test that adding a synthetic phase to PHASE_ORDER changes both consumers' behavior.",
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

const HASH_BEFORE = "sha256:phaseorder-pre-0000000000000000000000000000000000000000";
const HASH_MID = "sha256:phaseorder-mid-0000000000000000000000000000000000000000";
const HASH_AFTER = "sha256:phaseorder-post-000000000000000000000000000000000000000";

const performedBeats: readonly PerformedBeat[] = [
  {
    beatIndex: 0,
    voices: [
      {
        instrument: "strings",
        output:
          "MetaScorePhase enum order: GoalDefinition, ConstraintMapping, ProblemClassification, StrategyDiscovery, StrategyOrdering, VerifyHook, ScoreEmission, ScoreExecution. inferPhase if-chain order matches but uses input-field names: goalConfirmed, constraintsConfirmed, problemClass, strategiesRaw, strategiesOrdered, verifyHookConfirmed, specApproved, executionApproved.",
        confidence: 0.95,
      },
    ],
    verdict: { outcome: "applied", confidence: 0.95, shouldTerminate: false, reason: "duality mapped" },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 1,
    voices: [
      {
        instrument: "brass",
        output:
          "Contract: a single ordered list of (phase, requiredInputField) pairs is the only authority. MetaScorePhase becomes a derived type; inferPhase becomes a derived function.",
        confidence: 0.9,
      },
    ],
    verdict: { outcome: "applied", confidence: 0.9, shouldTerminate: false, reason: "contract stated" },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 2,
    voices: [
      {
        instrument: "woodwinds",
        output:
          "Options: (a) const tuple `as const` — preserves literal types, both consumers get narrowing for free. (b) class with static methods — heavier, no real benefit. (c) Map — loses ordering. Pick (a).",
        confidence: 0.8,
      },
    ],
    verdict: { outcome: "applied", confidence: 0.8, shouldTerminate: false, reason: "shape chosen" },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 3,
    voices: [
      {
        instrument: "piano",
        output:
          "Synthesis: `const PHASE_ORDER = [{phase:'goal-definition',field:'goalConfirmed'}, ...] as const`. MetaScorePhase = typeof PHASE_ORDER[number]['phase']. inferPhase = (input) => PHASE_ORDER.find(p => !input[p.field])?.phase ?? 'complete'.",
        confidence: 0.9,
      },
    ],
    verdict: { outcome: "applied", confidence: 0.9, shouldTerminate: false, reason: "design integrated" },
    stateHash: HASH_BEFORE,
  },
  {
    beatIndex: 4,
    voices: [
      {
        instrument: "brass",
        output:
          "Edit applied: PHASE_ORDER added in shared module, MetaScorePhase enum replaced with derived type, inferPhase rewritten as 5-line lookup. Call sites compile-checked.",
        confidence: 0.9,
      },
    ],
    verdict: { outcome: "applied", confidence: 0.9, shouldTerminate: false, reason: "fix applied" },
    stateHash: HASH_MID,
  },
  {
    beatIndex: 5,
    voices: [
      {
        instrument: "brass",
        output:
          "Tests pass. Added regression test: temporarily appending a 9th phase to PHASE_ORDER causes inferPhase to return that phase when its field is missing. Confirms single-source-of-truth.",
        confidence: 0.9,
      },
    ],
    verdict: { outcome: "applied", confidence: 0.9, shouldTerminate: true, reason: "verified" },
    stateHash: HASH_AFTER,
  },
];

const performance: Performance = {
  scoreId: id,
  beats: performedBeats,
  startedAt: "2026-04-29T02:00:00.000Z",
  completedAt: "2026-04-29T02:18:00.000Z",
  outcome: "success",
};

const run: SavedRun = { score, performance };

const outDir = path.resolve(__dirname);
saveRun(run, outDir);

process.stdout.write(`wrote example 02 → ${outDir}\n  scoreId=${id}\n`);
