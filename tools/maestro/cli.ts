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
 *   maestro start   --prompt <text> --pattern <name|new> --state <file>
 *     Initialize a new engine. Writes opaque state to --state, prints
 *     the first Pause on stdout, exits 2.
 *     `--pattern` is required: pass a registered pattern name (see
 *     `symphony list-patterns`) or "new" to draft a fresh one.
 *
 *   maestro resolve --state <file> (--resolution <json> | --resolution-file <path>)
 *     Apply one Resolution. Updates --state in place. Prints next
 *     Pause (exit 2) or final Performance (exit 0) or error (exit 1).
 *     Exactly one of --resolution / --resolution-file must be given.
 *     Prefer --resolution-file: it sidesteps shell-quoting hazards
 *     and the related env-var pitfall (a missing pauseId gets dropped
 *     by JSON.stringify and then rejected by the engine).
 *
 * State file format is engine-internal and opaque to the caller.
 */
import * as fs from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runStart, runResolve } from "./engine";

// ── CLI definition ─────────────────────────────────────────────────

function maestroCli(): void {
  yargs(hideBin(process.argv))
    .scriptName("maestro")
    .strict()
    .version(false)
    .command(
      "start",
      "Initialize a new engine run from a prompt + chosen pattern and write opaque state to a file",
      (y) =>
        y
          .option("prompt", {
            describe: "User prompt to seed the engine with",
            type: "string",
            demandOption: true,
          })
          .option("pattern", {
            describe:
              "Registered pattern name (see `symphony list-patterns`) or 'new' to draft a fresh pattern",
            type: "string",
            demandOption: true,
          })
          .option("state", {
            describe: "Path to write opaque engine state to (created if missing)",
            type: "string",
            demandOption: true,
          }),
      ({ prompt, pattern, state }) => {
        runStart(prompt, pattern, state);
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
            describe: "Resolution JSON inline; must echo the current Pause's pauseId",
            type: "string",
          })
          .option("resolution-file", {
            describe:
              "Path to a JSON file with the Resolution; preferred over --resolution to avoid shell-quoting hazards",
            type: "string",
          })
          .check((a) => {
            const inline = typeof a.resolution === "string" && a.resolution.length > 0;
            const file =
              typeof a["resolution-file"] === "string" &&
              (a["resolution-file"] as string).length > 0;
            if (inline === file) {
              throw new Error("Provide exactly one of --resolution or --resolution-file");
            }
            return true;
          }),
      ({ state, resolution, "resolution-file": resolutionFile }) => {
        const raw =
          typeof resolutionFile === "string"
            ? fs.readFileSync(resolutionFile, "utf8")
            : (resolution as string);
        runResolve(state, raw);
      },
    )
    .demandCommand(1, "Specify a subcommand: `start` or `resolve`.")
    .help()
    .parse();
}

maestroCli();
