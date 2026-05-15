/**
 * log.ts — Optional JSONL telemetry for Symphony CLIs.
 *
 * Shared by `maestro`, `symphony`, and `patterns`. Call `appendLog`
 * at the start and end of each stage (or whenever interesting). Each
 * call writes one JSON object per line (NDJSON / JSONL).
 *
 * Logging is opt-in via the `SYMPHONY_LOG` environment variable:
 *
 *   SYMPHONY_LOG=/tmp/symphony.log yarn tsx tools/maestro/cli.ts ...
 *
 * If `SYMPHONY_LOG` is unset or empty, `appendLog` is a no-op. There
 * is no CLI flag — telemetry is a session-level decision, set once.
 *
 * Event shape is intentionally loose (Record<string, unknown>) so we
 * can extend it without a schema migration. Stable fields:
 *   `ts`    — ISO-8601 timestamp
 *   `tool`  — "maestro" | "symphony" | "patterns"
 *   `cmd`   — the subcommand (e.g. "start", "resolve", "list")
 *   `phase` — "input" | "output"
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type CliTool = "maestro" | "symphony" | "patterns";

export interface CliLogEvent {
  readonly ts: string;
  readonly tool: CliTool;
  readonly cmd: string;
  readonly phase: "input" | "output";
  readonly data: Record<string, unknown>;
}

/**
 * Append a single event to the log file named by `SYMPHONY_LOG`.
 * No-op when the env var is unset or empty.
 *
 * Telemetry is best-effort: write failures are swallowed (with a
 * single stderr warning) so a broken log path can never break a CLI
 * invocation.
 */
export function appendLog(
  tool: CliTool,
  cmd: string,
  phase: "input" | "output",
  data: Record<string, unknown>,
): void {
  const logFile = process.env.SYMPHONY_LOG;
  if (typeof logFile !== "string" || logFile.length === 0) {
    return;
  }
  const event: CliLogEvent = {
    ts: new Date().toISOString(),
    tool,
    cmd,
    phase,
    data,
  };
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(event) + "\n", "utf8");
  } catch (e) {
    process.stderr.write(`SYMPHONY_LOG WRITE FAILED: ${(e as Error).message}\n`);
  }
}
