/**
 * cli.ts — Maestro engine CLI driver.
 *
 * The engine is pure. This file is the sole I/O boundary: it reads
 * a prompt + an optional resolution from argv, advances the engine,
 * and emits the next Pause as JSON on stdout. Exit codes mirror the
 * Symphony protocol:
 *
 *   0  = engine reached `done` (Performance available on stdout)
 *   1  = engine reached `failed` (protocol violation; error on stderr)
 *   2  = engine paused for a judgment (Pause emitted on stdout)
 *
 * Subcommands:
 *
 *   maestro start   --prompt <text> --state <file>
 *     Initialize a new engine. Writes opaque state to --state, prints
 *     the first Pause on stdout, exits 2.
 *
 *   maestro resolve --state <file> --resolution <json>
 *     Apply one Resolution. Updates --state in place. Prints next
 *     Pause (exit 2) or final Performance (exit 0) or error (exit 1).
 *
 * State file format is engine-internal and opaque to the caller.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { listPatterns } from "../patterns";
import { advance, createEngine } from "./engine";
import type { EngineState } from "./types/engine";
import type { Resolution } from "./types/resolution";
import { composerPromptFor, instrumentPromptFor } from "./prompts";

// ── IO helpers ─────────────────────────────────────────────────────

function emitPauseAndExit(state: EngineState): void {
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
      undefined,
      2,
    ) + "\n",
  );
  process.exit(2);
}

function emitDoneAndExit(state: EngineState): void {
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
      undefined,
      2,
    ) + "\n",
  );
  process.exit(0);
}

function writeState(file: string, state: EngineState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, undefined, 2) + "\n", "utf8");
}

function readState(file: string): EngineState {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as EngineState;
}

// ── Subcommand handlers ────────────────────────────────────────────

function runStart(prompt: string, stateFile: string): void {
  const state = createEngine({ prompt, patterns: listPatterns() });
  if (state.kind === "failed") {
    process.stderr.write(`ENGINE ERROR: ${state.error}\n`);
    process.exit(1);
  }
  writeState(stateFile, state);
  if (state.kind === "running") {
    emitPauseAndExit(state);
  }
  emitDoneAndExit(state);
}

function runResolve(stateFile: string, resolutionRaw: string): void {
  let resolution: Resolution;
  try {
    resolution = JSON.parse(resolutionRaw) as Resolution;
  } catch (e) {
    process.stderr.write(`RESOLUTION PARSE ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const prior = readState(stateFile);
  const next = advance(prior, resolution);
  writeState(stateFile, next);
  if (next.kind === "failed") {
    process.stderr.write(`ENGINE ERROR: ${next.error}\n`);
    process.exit(1);
  }
  if (next.kind === "done") {
    emitDoneAndExit(next);
  }
  emitPauseAndExit(next);
}

// ── CLI definition ─────────────────────────────────────────────────

function maestroCli(): void {
  yargs(hideBin(process.argv))
    .scriptName("maestro")
    .strict()
    .version(false)
    .command(
      "start",
      "Initialize a new engine run from a prompt and write opaque state to a file",
      (y) =>
        y
          .option("prompt", {
            describe: "User prompt to seed the engine with",
            type: "string",
            demandOption: true,
          })
          .option("state", {
            describe: "Path to write opaque engine state to (created if missing)",
            type: "string",
            demandOption: true,
          }),
      ({ prompt, state }) => {
        runStart(prompt, state);
      },
    )
    .command(
      "resolve",
      "Apply one Resolution to a paused engine state and emit the next Pause or final Performance",
      (y) =>
        y
          .option("state", {
            describe: "Path to the engine state file written by `start` or a prior `resolve`",
            type: "string",
            demandOption: true,
          })
          .option("resolution", {
            describe: "Resolution JSON; must echo the current Pause's pauseId",
            type: "string",
            demandOption: true,
          }),
      ({ state, resolution }) => {
        runResolve(state, resolution);
      },
    )
    .demandCommand(1, "Specify a subcommand: `start` or `resolve`.")
    .help()
    .parse();
}

maestroCli();
