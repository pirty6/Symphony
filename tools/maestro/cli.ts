/**
 * cli.ts — Maestro engine CLI driver.
 *
 * The engine is pure. This file is the sole I/O boundary: it reads
 * a prompt + an optional resolution from stdin/argv, advances the
 * engine, and emits the next Pause as JSON on stdout. Exit codes
 * mirror the Symphony protocol:
 *
 *   0  = engine reached `done` (Performance available on stdout)
 *   1  = engine reached `failed` (protocol violation; error on stderr)
 *   2  = engine paused for a judgment (Pause emitted on stdout)
 *
 * Subcommands:
 *
 *   maestro start --prompt "<text>" [--state <file>]
 *     Initialize a new engine. Writes opaque state to --state, prints
 *     the first Pause on stdout, exits 2.
 *
 *   maestro resolve --state <file> --resolution <json>
 *     Apply one Resolution. Updates --state in place. Prints next Pause
 *     (exit 2) or final Performance (exit 0) or error (exit 1).
 *
 * State file format is engine-internal and opaque to the caller.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { listPatterns } from "../patterns";
import {
  advance,
  createEngine,
  type EngineState,
  type Resolution,
} from "./engine";
import { composerPromptFor, instrumentPromptFor } from "./prompts";

interface CliArgs {
  readonly command: string;
  readonly prompt?: string;
  readonly state?: string;
  readonly resolution?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const out: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.substring(2, eq)] = a.substring(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      out[a.substring(2)] = args[++i];
    }
  }
  return {
    command,
    prompt: out.prompt,
    state: out.state,
    resolution: out.resolution,
  };
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  maestro start    --prompt <text> --state <file>",
      "  maestro resolve  --state <file> --resolution <json>",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function emitPauseAndExit(state: EngineState): never {
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
      null,
      2,
    ) + "\n",
  );
  process.exit(2);
}

function emitDoneAndExit(state: EngineState): never {
  if (state.kind !== "done") {
    process.stderr.write(`expected done state; got ${state.kind}\n`);
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify(
      {
        status: "done",
        executableScore: state.result.executableScore,
        performance: state.result.performance,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

function writeState(file: string, state: EngineState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function readState(file: string): EngineState {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as EngineState;
}

function runStart(args: CliArgs): never {
  if (!args.prompt || !args.state) usage();
  const state = createEngine({
    prompt: args.prompt!,
    patterns: listPatterns(),
  });
  if (state.kind === "failed") {
    process.stderr.write(`ENGINE ERROR: ${state.error}\n`);
    process.exit(1);
  }
  writeState(args.state!, state);
  if (state.kind === "running") emitPauseAndExit(state);
  emitDoneAndExit(state);
}

function runResolve(args: CliArgs): never {
  if (!args.state || !args.resolution) usage();
  let resolution: Resolution;
  try {
    resolution = JSON.parse(args.resolution!) as Resolution;
  } catch (e) {
    process.stderr.write(
      `RESOLUTION PARSE ERROR: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }
  const prior = readState(args.state!);
  const next = advance(prior, resolution);
  writeState(args.state!, next);
  if (next.kind === "failed") {
    process.stderr.write(`ENGINE ERROR: ${next.error}\n`);
    process.exit(1);
  }
  if (next.kind === "done") emitDoneAndExit(next);
  emitPauseAndExit(next);
}

function main(): void {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "start":
      runStart(args);
      break;
    case "resolve":
      runResolve(args);
      break;
    default:
      usage();
  }
}

main();
