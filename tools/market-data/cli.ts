/**
 * cli.ts — TypeScript wrapper around fetch.py.
 *
 * Setup (one-time):
 *     pip install yfinance
 *
 * yfinance is a Python dependency; it is intentionally NOT listed in
 * package.json. Add it to a Python venv or install with
 * `pip install --user yfinance`.
 *
 * Usage:
 *     npx tsx tools/market-data/cli.ts \
 *         --tickers AAPL,PFE,XLE,META \
 *         --week-of 2026-04-27 \
 *         --output /tmp/watchlist.json
 *
 * Exit codes: 0 = at least one ticker succeeded, 1 = configuration or
 * fetch error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetchOptions {
  tickers: string[];
  weekOf: string;
  /** Optional path to fetch.py; defaults to the sibling file. */
  scriptPath?: string;
  /** Optional override for `python3`. */
  pythonBin?: string;
}

/**
 * Minimal subset of `child_process.spawnSync`'s return that we depend on.
 * Tests substitute their own runner conforming to this shape.
 */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export type SpawnRunner = (bin: string, args: string[]) => SpawnResult;

const defaultRunner: SpawnRunner = (bin, args): SpawnResult => {
  const r: SpawnSyncReturns<string> = spawnSync(bin, args, { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error as NodeJS.ErrnoException | undefined,
  };
};

/**
 * Executes fetch.py and returns the parsed JSON watchlist array.
 *
 * Throws `ConfigurationError` for missing python3 or missing yfinance.
 * Throws `FetchError` for any other non-zero exit.
 */
export function fetchWatchlist(
  opts: FetchOptions,
  runner: SpawnRunner = defaultRunner,
): unknown[] {
  const pythonBin = opts.pythonBin ?? "python3";
  const scriptPath =
    opts.scriptPath ?? path.resolve(__dirname, "fetch.py");
  const args = [
    scriptPath,
    "--tickers",
    opts.tickers.join(","),
    "--week-of",
    opts.weekOf,
  ];

  const result = runner(pythonBin, args);

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new ConfigurationError(
      `Python 3 required (could not exec '${pythonBin}'). Install from python.org and ensure it is on PATH.`,
    );
  }
  if (result.error) {
    throw new ConfigurationError(
      `Failed to execute '${pythonBin}': ${result.error.message}`,
    );
  }

  // yfinance ImportError sentinel emitted by fetch.py
  if (result.stderr.includes("yfinance not installed")) {
    throw new ConfigurationError(
      "Python package 'yfinance' is not installed. Run: pip install yfinance",
    );
  }

  if (result.status !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-5).join("\n");
    throw new FetchError(
      `fetch.py exited with status ${result.status}: ${tail || "(no stderr)"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new FetchError(
      `fetch.py stdout is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FetchError("fetch.py stdout must be a JSON array");
  }
  return parsed;
}

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

export function main(argv: string[], runner: SpawnRunner = defaultRunner): number {
  const raw = parseArgs(argv);
  const tickersArg = raw["tickers"];
  const weekOf = raw["week-of"];
  const output = raw["output"];

  if (!tickersArg) {
    console.error("MARKET_DATA_ERROR: missing required flag --tickers");
    return 1;
  }
  if (!weekOf) {
    console.error("MARKET_DATA_ERROR: missing required flag --week-of");
    return 1;
  }
  const tickers = tickersArg
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tickers.length === 0) {
    console.error("MARKET_DATA_ERROR: --tickers must contain at least one symbol");
    return 1;
  }

  let entries: unknown[];
  try {
    entries = fetchWatchlist({ tickers, weekOf }, runner);
  } catch (err) {
    if (err instanceof ConfigurationError) {
      console.error(`MARKET_DATA_ERROR: ${err.message}`);
      return 1;
    }
    if (err instanceof FetchError) {
      console.error(`MARKET_DATA_ERROR: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const json = JSON.stringify(entries, null, 2);
  if (output) {
    try {
      fs.writeFileSync(output, json + "\n", "utf8");
    } catch (err) {
      console.error(
        `MARKET_DATA_ERROR: cannot write --output ${output}: ${(err as Error).message}`,
      );
      return 1;
    }
    console.error(`MARKET_DATA: wrote ${entries.length} entries to ${output}`);
  } else {
    console.log(json);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}
