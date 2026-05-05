/**
 * cli.test.ts — Tests for tools/market-data/cli.ts
 *
 * All tests use a mock SpawnRunner. fetch.py is never invoked and yfinance
 * is never called.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ConfigurationError,
  FetchError,
  fetchWatchlist,
  main,
  type SpawnResult,
  type SpawnRunner,
} from "./cli";

function makeRunner(result: SpawnResult): SpawnRunner {
  return () => result;
}

describe("fetchWatchlist", () => {
  test("returns parsed JSON array on success", () => {
    const entry = {
      ticker: "AAPL",
      sector: "Technology",
      spot: 270.94,
      ivRank: 62.1,
      openInterest: 25000,
      catalyst: { kind: "EARNINGS", description: "Q2 2026 earnings", date: "2026-04-30" },
    };
    const runner = makeRunner({
      status: 0,
      stdout: JSON.stringify([entry]),
      stderr: "",
    });
    const result = fetchWatchlist(
      { tickers: ["AAPL"], weekOf: "2026-04-27" },
      runner,
    );
    expect(result).toEqual([entry]);
  });

  test("throws ConfigurationError when python3 is absent (ENOENT)", () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
      code: "ENOENT",
    });
    const runner = makeRunner({
      status: null,
      stdout: "",
      stderr: "",
      error: enoent,
    });
    expect(() =>
      fetchWatchlist({ tickers: ["AAPL"], weekOf: "2026-04-27" }, runner),
    ).toThrow(ConfigurationError);
  });

  test("throws ConfigurationError when yfinance import fails", () => {
    const runner = makeRunner({
      status: 1,
      stdout: "",
      stderr: "FETCH_ERROR: yfinance not installed (run: pip install yfinance)",
    });
    expect(() =>
      fetchWatchlist({ tickers: ["AAPL"], weekOf: "2026-04-27" }, runner),
    ).toThrow(/pip install yfinance/);
  });

  test("throws FetchError on non-zero exit unrelated to config", () => {
    const runner = makeRunner({
      status: 1,
      stdout: "[]",
      stderr: "FETCH_ERROR: all tickers failed",
    });
    expect(() =>
      fetchWatchlist({ tickers: ["NOPE"], weekOf: "2026-04-27" }, runner),
    ).toThrow(FetchError);
  });

  test("throws FetchError when stdout is not JSON", () => {
    const runner = makeRunner({
      status: 0,
      stdout: "not json",
      stderr: "",
    });
    expect(() =>
      fetchWatchlist({ tickers: ["AAPL"], weekOf: "2026-04-27" }, runner),
    ).toThrow(FetchError);
  });

  test("throws FetchError when stdout is JSON but not an array", () => {
    const runner = makeRunner({
      status: 0,
      stdout: '{"ticker":"AAPL"}',
      stderr: "",
    });
    expect(() =>
      fetchWatchlist({ tickers: ["AAPL"], weekOf: "2026-04-27" }, runner),
    ).toThrow(FetchError);
  });

  test("passes --tickers and --week-of to fetch.py", () => {
    let captured: { bin: string; args: string[] } | null = null;
    const runner: SpawnRunner = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: "[]", stderr: "" };
    };
    // status=0 + empty array would normally be valid; we just want to
    // capture the args. Wrap in try/catch in case the impl rejects [].
    try {
      fetchWatchlist({ tickers: ["AAPL", "PFE"], weekOf: "2026-04-27" }, runner);
    } catch {
      /* ignore — we only assert on captured args */
    }
    expect(captured).not.toBeNull();
    expect(captured!.bin).toBe("python3");
    expect(captured!.args).toContain("--tickers");
    expect(captured!.args).toContain("AAPL,PFE");
    expect(captured!.args).toContain("--week-of");
    expect(captured!.args).toContain("2026-04-27");
  });
});

describe("main()", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  test("exits 1 when --tickers is missing", () => {
    const code = main(["node", "cli.ts", "--week-of", "2026-04-27"]);
    expect(code).toBe(1);
  });

  test("exits 1 when --week-of is missing", () => {
    const code = main(["node", "cli.ts", "--tickers", "AAPL"]);
    expect(code).toBe(1);
  });

  test("exits 1 with empty tickers list", () => {
    const code = main([
      "node",
      "cli.ts",
      "--tickers",
      ",,",
      "--week-of",
      "2026-04-27",
    ]);
    expect(code).toBe(1);
  });

  test("partial success (some tickers fail in fetch.py): exits 0 with valid JSON of survivors", () => {
    // fetch.py's contract: it prints WARNINGs to stderr for failed tickers
    // and exits 0 if at least one succeeded.
    const survivors = [
      {
        ticker: "AAPL",
        sector: "Technology",
        spot: 270.94,
        ivRank: 62.1,
        openInterest: 25000,
        catalyst: { kind: "EARNINGS", description: "Q2 2026 earnings", date: "2026-04-30" },
      },
    ];
    const runner = makeRunner({
      status: 0,
      stdout: JSON.stringify(survivors),
      stderr: "WARNING: BADTICKER: no regularMarketPrice/currentPrice\n",
    });
    const code = main(
      ["node", "cli.ts", "--tickers", "AAPL,BADTICKER", "--week-of", "2026-04-27"],
      runner,
    );
    expect(code).toBe(0);
    // Survivors JSON was printed to stdout
    const printed = consoleLogSpy.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(printed)).toEqual(survivors);
  });

  test("all-failure: exits 1 (fetch.py status 1)", () => {
    const runner = makeRunner({
      status: 1,
      stdout: "[]",
      stderr: "FETCH_ERROR: all tickers failed",
    });
    const code = main(
      ["node", "cli.ts", "--tickers", "BAD1,BAD2", "--week-of", "2026-04-27"],
      runner,
    );
    expect(code).toBe(1);
  });

  test("ConfigurationError (no python3) → exits 1 with helpful message", () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
      code: "ENOENT",
    });
    const runner = makeRunner({
      status: null,
      stdout: "",
      stderr: "",
      error: enoent,
    });
    const code = main(
      ["node", "cli.ts", "--tickers", "AAPL", "--week-of", "2026-04-27"],
      runner,
    );
    expect(code).toBe(1);
    const errMsg = consoleErrorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(errMsg).toMatch(/Python 3/);
  });

  test("ConfigurationError (no yfinance) → exits 1 with pip install hint", () => {
    const runner = makeRunner({
      status: 1,
      stdout: "",
      stderr: "FETCH_ERROR: yfinance not installed (run: pip install yfinance)",
    });
    const code = main(
      ["node", "cli.ts", "--tickers", "AAPL", "--week-of", "2026-04-27"],
      runner,
    );
    expect(code).toBe(1);
    const errMsg = consoleErrorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(errMsg).toMatch(/pip install yfinance/);
  });

  test("--output writes JSON to disk and prints status to stderr", () => {
    const tmp = path.join(os.tmpdir(), `market-data-${Date.now()}.json`);
    const survivors = [
      {
        ticker: "AAPL",
        sector: "Technology",
        spot: 270.94,
        ivRank: 62.1,
        openInterest: 25000,
        catalyst: { kind: "EARNINGS", description: "Q2 2026 earnings", date: "2026-04-30" },
      },
    ];
    const runner = makeRunner({
      status: 0,
      stdout: JSON.stringify(survivors),
      stderr: "",
    });
    const code = main(
      [
        "node",
        "cli.ts",
        "--tickers",
        "AAPL",
        "--week-of",
        "2026-04-27",
        "--output",
        tmp,
      ],
      runner,
    );
    expect(code).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
    const contents = JSON.parse(fs.readFileSync(tmp, "utf8"));
    expect(contents).toEqual(survivors);
    fs.unlinkSync(tmp);
  });
});
