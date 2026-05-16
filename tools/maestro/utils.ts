import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { composerPromptFor, instrumentPromptFor } from "./prompts";
import type { EngineState } from "./types/engine";
import { saveRun } from "../symphony/persistence";
import type { SavedRun } from "../symphony/types";
import { getPattern } from "../patterns";

/**
 * Returns the current wall-clock time as an ISO-8601 string.
 *
 * Used as the default `clock` injected into the engine so timestamps in
 * emitted state are deterministic in tests (which override this) and
 * real-time in production.
 */
export function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Generates a fresh RFC-4122 v4 UUID for a new pause.
 *
 * Pause IDs gate idempotent resolutions: the engine rejects a resolution
 * whose `pauseId` does not match the currently active pause. Tests inject
 * a deterministic factory; production uses this.
 */
export function defaultPauseIdFactory(): string {
  return crypto.randomUUID();
}

/**
 * Serializes the engine's active pause to stdout and exits the process
 * with code `2` (the agent-continue signal in the maestro CLI protocol).
 *
 * Emits a JSON envelope containing the pause kind, ID, payload, and the
 * rendered composer/instrument prompts the calling agent should consume.
 * Exits with code `1` if `state.kind !== "running"` — callers must only
 * invoke this on a running state.
 */
export function emitPauseAndExit(state: EngineState): void {
  if (state.kind !== "running") {
    process.stderr.write(`expected running state; got ${state.kind}\n`);
    process.exit(1);
  }
  const pause = state.pause;
  process.stdout.write(
    JSON.stringify(
      {
        status: "pause",
        kind: pause.kind,
        pauseId: pause.pauseId,
        payload: pause.payload,
        composerPrompt: composerPromptFor(pause),
        instrumentPrompt: instrumentPromptFor(pause),
      },
      undefined, // replacer: serialize all own enumerable properties
      2, // space: indent nested levels by 2 spaces (pretty-print)
    ) + "\n",
  );
  process.exit(2);
}

/**
 * Serializes a completed engine result to stdout and exits with code `0`
 * (the maestro CLI "done" signal).
 *
 * Emits the final `executableScore` and `performance` payload. Exits with
 * code `1` if `state.kind !== "done"` — this must only be called once the
 * engine has reached a terminal state.
 */
export function emitDoneAndExit(state: EngineState): void {
  if (state.kind !== "done") {
    process.stderr.write(`expected done state; got ${state.kind}\n`);
    process.exit(1);
  }

  // Auto-save the completed run to the score store
  const { executableScore, performance, patternScore } = state.result;
  const resolvedPatternScore = patternScore ??
    (executableScore.pattern ? getPattern(executableScore.pattern)?.score : undefined) ?? {
      pattern: executableScore.pattern,
      domain: executableScore.frequencyMap.key,
      beats: [],
    };
  const run: SavedRun = {
    schemaVersion: 1,
    patternScore: resolvedPatternScore,
    executableScore,
    performance,
    problemFingerprint: executableScore.generatedFrom.canonicalHash,
    timestamp: executableScore.generatedAt,
  };
  try {
    const file = saveRun(run);
    process.stderr.write(`saved: ${file}\n`);
  } catch (err) {
    process.stderr.write(`warning: could not auto-save run: ${(err as Error).message}\n`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: "done",
        executableScore: state.result.executableScore,
        performance: state.result.performance,
      },
      undefined, // replacer: serialize all own enumerable properties
      2, // space: indent nested levels by 2 spaces (pretty-print)
    ) + "\n",
  );
  process.exit(0);
}

/**
 * Writes the planned `AlgorithmInput` to `outPath` and emits a JSON
 * envelope on stdout, then exits with code `0`. Used by `maestro plan`
 * when the engine reached its plan-only terminal state at the go-gate.
 *
 * Exits with code `1` if `state.kind !== "planned"` — this must only be
 * called on the matching terminal state.
 */
export function emitPlannedAndExit(state: EngineState, outPath: string): void {
  if (state.kind !== "planned") {
    process.stderr.write(`expected planned state; got ${state.kind}\n`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(state.algorithm, undefined, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        status: "planned",
        out: outPath,
        steps: state.algorithm.steps.length,
        provenance: state.algorithm.provenance,
      },
      undefined,
      2,
    ) + "\n",
  );
  process.exit(0);
}

/**
 * Persists the engine state to disk as pretty-printed JSON, creating
 * parent directories as needed.
 *
 * The state file is the sole handoff between `start` and `resolve`
 * invocations: each CLI call reads the prior state, applies one
 * resolution, and writes the new state back.
 */
export function writeState(file: string, state: EngineState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Strip transient `events` array (present on AdvanceResult, not part of durable state).
  const { events: _events, ...persistent } = state as EngineState & { events?: unknown };
  // JSON.stringify(value, replacer=undefined → all keys, space=2 → pretty-print)
  fs.writeFileSync(file, JSON.stringify(persistent, undefined, 2) + "\n", "utf8");
}

/**
 * Reads and parses an engine state file previously written by
 * `writeState`. The result is trusted to match `EngineState`'s shape; no
 * runtime validation is performed.
 */
export function readState(file: string): EngineState {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as EngineState;
}
