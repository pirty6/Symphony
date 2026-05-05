/**
 * log.ts — Failure logger for the meta-score state machine.
 *
 * Writes one JSON file per failed invocation to a logs directory. Used to
 * forensically debug why a meta-score run exited with code 1 (max invocations,
 * missing input, or thrown FrameworkError).
 *
 * Configuration:
 *   - `META_SCORE_LOG_DIR=<path>` overrides the log destination.
 *   - `META_SCORE_LOG_DIR=off`   disables logging entirely.
 *   - Unset (default): logs go to `<this-file's-dir>/logs/`.
 *
 * The directory is created lazily on first write. Each entry lives in its
 * own file (`run-<ISO timestamp>.log`) so concurrent runs do not race on a
 * single file and so individual failures can be inspected/deleted in isolation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MetaScoreInput, ScoreResult } from "./meta-score";

export interface LogEntry {
  /** ISO 8601 timestamp at the moment of failure. */
  timestamp: string;
  /** Exit code that triggered the log write (always 1 for now). */
  exitCode: number;
  /** Verbatim `output` field from the ScoreResult (e.g. META_SCORE_ERROR line). */
  output: string;
  /** Inferred phase name based on which input vars were already confirmed. */
  phase: string;
  /** Sorted list of input keys whose values were defined (truthy or not). */
  inputKeysPresent: string[];
  /** Stack trace if a FrameworkError or other exception was caught. */
  stack?: string;
  /** Error name (e.g. `MaxInvocationsError`, `LifecycleError`). */
  errorName?: string;
}

export const LOG_DIR_DISABLED_SENTINEL = "off";
const DEFAULT_LOG_DIR = path.resolve(__dirname, "logs");

/**
 * Returns the directory where logs should be written, or `null` if logging
 * is disabled. Reads the `META_SCORE_LOG_DIR` env var on every call so tests
 * can swap the destination per-test without restarting the process.
 */
export function resolveLogDir(): string | null {
  const env = process.env.META_SCORE_LOG_DIR;
  if (env === undefined) return DEFAULT_LOG_DIR;
  if (env === "" || env.toLowerCase() === LOG_DIR_DISABLED_SENTINEL) return null;
  return env;
}

/**
 * Walks the input fields in phase order and returns the name of the first
 * phase whose required confirmation flag is missing. This is the phase the
 * run was either *about to enter* or *paused at* when failure occurred.
 */
export function inferPhase(input: MetaScoreInput): string {
  if (!input.goalConfirmed) return "goal-definition";
  if (!input.constraintsConfirmed) return "constraint-mapping";
  if (!input.problemClass) return "problem-classification";
  if (!input.strategiesRaw) return "strategy-discovery";
  if (!input.strategiesOrdered) return "strategy-ordering";
  if (!input.verifyHookConfirmed) return "verify-hook";
  if (!input.specApproved) return "score-emission";
  if (!input.executionApproved) return "score-execution";
  return "complete";
}

function inputKeysPresent(input: MetaScoreInput): string[] {
  const out: string[] = [];
  for (const key of Object.keys(input) as Array<keyof MetaScoreInput>) {
    if (input[key] !== undefined) out.push(String(key));
  }
  return out.sort();
}

/**
 * Writes a single failure log entry. Returns the path of the written file,
 * or `null` if logging is disabled. Errors during write are swallowed and
 * surfaced on stderr so a logging failure cannot mask the original error
 * from the caller.
 */
export function logFailure(
  input: MetaScoreInput,
  result: ScoreResult,
  caughtError?: Error,
): string | null {
  const dir = resolveLogDir();
  if (dir === null) return null;

  const now = new Date();
  const entry: LogEntry = {
    timestamp: now.toISOString(),
    exitCode: result.exitCode,
    output: result.output,
    phase: inferPhase(input),
    inputKeysPresent: inputKeysPresent(input),
  };
  if (caughtError) {
    entry.errorName = caughtError.name;
    if (caughtError.stack) entry.stack = caughtError.stack;
  }

  // Filename: run-<ts>-<rand>.log. Random suffix prevents collisions when
  // two failures occur within the same millisecond (test fixtures, retries).
  const tsSlug = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `run-${tsSlug}-${rand}.log`;
  const filePath = path.join(dir, filename);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch (err) {
    // Logging must never crash the caller. Surface to stderr only.
    process.stderr.write(
      `META_SCORE_LOG_WARNING: failed to write ${filePath}: ${(err as Error).message}\n`,
    );
    return null;
  }
  return filePath;
}
