/**
 * cli.ts — CLI entry point for the options-optimizer Symphony Score.
 *
 * Usage:
 *   npx tsx tools/plugins/options-optimizer/cli.ts \
 *     --capital <number> --max-loss-pct <number> \
 *     [--seed <int>] [--iterations <int>] [--shape <name>]
 *
 * Exit codes:
 *   0 = winner found and emitted
 *   1 = fatal validation error (named)
 *   2 = judgment requested (e.g., no eligible winner — relax --max-loss-pct)
 */

import { runScore, type ScoreInputs } from "./score";

interface RawArgs {
  [key: string]: string;
}

function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const out: RawArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.substring(2, eq)] = arg.substring(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      out[arg.substring(2)] = args[++i];
    } else {
      out[arg.substring(2)] = "true";
    }
  }
  return out;
}

function requireNumber(raw: RawArgs, key: string, fallback?: number): number {
  const value = raw[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`SCORE_ERROR: missing required flag --${key}`);
    process.exit(1);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.error(`SCORE_ERROR: --${key} must be a number, got "${value}"`);
    process.exit(1);
  }
  return n;
}

export function buildInputs(argv: string[]): ScoreInputs {
  const raw = parseArgs(argv);
  return {
    capital: requireNumber(raw, "capital"),
    maxLossPct: requireNumber(raw, "max-loss-pct"),
    seed: Math.trunc(requireNumber(raw, "seed", 42)),
    iterations: Math.trunc(requireNumber(raw, "iterations", 50_000)),
    shapeName: raw["shape"],
  };
}

if (require.main === module) {
  const inputs = buildInputs(process.argv);
  const result = runScore(inputs);
  console.log(result.output);
  process.exit(result.exitCode);
}
