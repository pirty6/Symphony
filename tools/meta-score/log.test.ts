/**
 * log.test.ts — Tests for the meta-score failure logger.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  inferPhase,
  logFailure,
  resolveLogDir,
  type LogEntry,
} from "./log";
import type { MetaScoreInput, ScoreResult } from "./meta-score";

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meta-score-log-"));
}

describe("resolveLogDir", () => {
  const ORIGINAL = process.env.META_SCORE_LOG_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.META_SCORE_LOG_DIR;
    else process.env.META_SCORE_LOG_DIR = ORIGINAL;
  });

  test("returns null when env var is set to 'off'", () => {
    process.env.META_SCORE_LOG_DIR = "off";
    expect(resolveLogDir()).toBeNull();
  });

  test("returns null when env var is set to empty string", () => {
    process.env.META_SCORE_LOG_DIR = "";
    expect(resolveLogDir()).toBeNull();
  });

  test("returns the env var path when set to a real path", () => {
    process.env.META_SCORE_LOG_DIR = "/tmp/some-log-dir";
    expect(resolveLogDir()).toBe("/tmp/some-log-dir");
  });

  test("returns the default path when env var is unset", () => {
    delete process.env.META_SCORE_LOG_DIR;
    const dir = resolveLogDir();
    expect(dir).not.toBeNull();
    expect(dir).toMatch(/tools\/meta-score\/logs$/);
  });
});

describe("inferPhase", () => {
  test("returns goal-definition when nothing is confirmed", () => {
    expect(inferPhase({ goal: "x" })).toBe("goal-definition");
  });

  test("advances to constraint-mapping after goalConfirmed", () => {
    expect(
      inferPhase({ goal: "x", goalConfirmed: "x" }),
    ).toBe("constraint-mapping");
  });

  test("advances through every phase in order", () => {
    const stages: Array<[Partial<MetaScoreInput>, string]> = [
      [{ goalConfirmed: "x" }, "constraint-mapping"],
      [
        { goalConfirmed: "x", constraintsConfirmed: "true" },
        "problem-classification",
      ],
      [
        {
          goalConfirmed: "x",
          constraintsConfirmed: "true",
          problemClass: "STRUCTURAL:LOCALIZED:NOVEL",
        },
        "strategy-discovery",
      ],
      [
        {
          goalConfirmed: "x",
          constraintsConfirmed: "true",
          problemClass: "x",
          strategiesRaw: "a|b",
        },
        "strategy-ordering",
      ],
      [
        {
          goalConfirmed: "x",
          constraintsConfirmed: "true",
          problemClass: "x",
          strategiesRaw: "a|b",
          strategiesOrdered: "a|b",
        },
        "verify-hook",
      ],
      [
        {
          goalConfirmed: "x",
          constraintsConfirmed: "true",
          problemClass: "x",
          strategiesRaw: "a|b",
          strategiesOrdered: "a|b",
          verifyHookConfirmed: "yes",
        },
        "score-emission",
      ],
      [
        {
          goalConfirmed: "x",
          constraintsConfirmed: "true",
          problemClass: "x",
          strategiesRaw: "a|b",
          strategiesOrdered: "a|b",
          verifyHookConfirmed: "yes",
          specApproved: "true",
        },
        "score-execution",
      ],
      [
        {
          goalConfirmed: "x",
          constraintsConfirmed: "true",
          problemClass: "x",
          strategiesRaw: "a|b",
          strategiesOrdered: "a|b",
          verifyHookConfirmed: "yes",
          specApproved: "true",
          executionApproved: "true",
        },
        "complete",
      ],
    ];
    for (const [partial, expected] of stages) {
      expect(inferPhase({ goal: "x", ...partial })).toBe(expected);
    }
  });
});

describe("logFailure", () => {
  const ORIGINAL = process.env.META_SCORE_LOG_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.META_SCORE_LOG_DIR;
    else process.env.META_SCORE_LOG_DIR = ORIGINAL;
  });

  test("writes a JSON file when given a real log dir", () => {
    const dir = freshTmpDir();
    process.env.META_SCORE_LOG_DIR = dir;

    const input: MetaScoreInput = { goal: "test goal" };
    const result: ScoreResult = {
      exitCode: 1,
      output: "META_SCORE_ERROR: GOAL is required.",
    };

    const filePath = logFailure(input, result);
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath as string)).toBe(true);

    const entry = JSON.parse(fs.readFileSync(filePath as string, "utf8")) as LogEntry;
    expect(entry.exitCode).toBe(1);
    expect(entry.output).toBe("META_SCORE_ERROR: GOAL is required.");
    expect(entry.phase).toBe("goal-definition");
    expect(entry.inputKeysPresent).toContain("goal");
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns null and writes nothing when META_SCORE_LOG_DIR=off", () => {
    process.env.META_SCORE_LOG_DIR = "off";
    const result = logFailure(
      { goal: "x" },
      { exitCode: 1, output: "META_SCORE_ERROR: x" },
    );
    expect(result).toBeNull();
  });

  test("includes errorName and stack when a caught error is provided", () => {
    const dir = freshTmpDir();
    process.env.META_SCORE_LOG_DIR = dir;

    const err = new Error("boom");
    err.name = "FakeError";
    const filePath = logFailure(
      { goal: "x" },
      { exitCode: 1, output: "META_SCORE_ERROR: FakeError: boom" },
      err,
    );
    expect(filePath).not.toBeNull();
    const entry = JSON.parse(fs.readFileSync(filePath as string, "utf8")) as LogEntry;
    expect(entry.errorName).toBe("FakeError");
    expect(typeof entry.stack).toBe("string");
    expect(entry.stack).toContain("boom");
  });

  test("creates the log directory if it does not exist", () => {
    const dir = path.join(freshTmpDir(), "nested", "subdir");
    expect(fs.existsSync(dir)).toBe(false);
    process.env.META_SCORE_LOG_DIR = dir;

    const filePath = logFailure(
      { goal: "x" },
      { exitCode: 1, output: "META_SCORE_ERROR: x" },
    );
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("emits unique filenames for back-to-back failures", () => {
    const dir = freshTmpDir();
    process.env.META_SCORE_LOG_DIR = dir;

    const a = logFailure(
      { goal: "x" },
      { exitCode: 1, output: "META_SCORE_ERROR: a" },
    );
    const b = logFailure(
      { goal: "x" },
      { exitCode: 1, output: "META_SCORE_ERROR: b" },
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  test("inputKeysPresent is sorted and only includes defined fields", () => {
    const dir = freshTmpDir();
    process.env.META_SCORE_LOG_DIR = dir;

    const input: MetaScoreInput = {
      goal: "x",
      goalConfirmed: "x",
      successCondition: "y",
    };
    const filePath = logFailure(input, {
      exitCode: 1,
      output: "META_SCORE_ERROR: synthetic",
    });
    const entry = JSON.parse(fs.readFileSync(filePath as string, "utf8")) as LogEntry;
    expect(entry.inputKeysPresent).toEqual([
      "goal",
      "goalConfirmed",
      "successCondition",
    ]);
  });
});
