/**
 * refactoring.test.ts — Tests for the refactoring domain instance.
 *
 * Validates: catalog structure, validator correctness, framework integration,
 * eval coverage requirements, and diagnostic extremes.
 */

import { Framework } from "../symphony-core/framework";
import { DispatchError } from "../symphony-core/errors";
import { requiredEvalCoverage } from "../symphony-core/eval-toolchain";
import { validateVerdict } from "../symphony-core/invariants";
import type { Phase, SchemaEnvironment } from "../symphony-core/types";
import { refactoringCatalog, type RefactoringShape } from "./catalog";
import { refactoringDomain, refactoringTemplate } from "./domain";
import {
  isAstNode,
  isClassPair,
  isFileLineRange,
  isSymbolFqn,
} from "./validators";

// ── Helpers ────────────────────────────────────────────────────────

function mockEnv(values: Record<string, string>): SchemaEnvironment {
  return { resolve: (path: string) => values[path] ?? "" };
}

function initFramework(): Framework {
  const fw = new Framework();
  fw.initialize(refactoringDomain);
  return fw;
}

// ════════════════════════════════════════════════════════════════════
// Catalog Structure Tests
// ════════════════════════════════════════════════════════════════════

describe("Catalog: structural integrity", () => {
  test("catalog has exactly 15 entries", () => {
    expect(refactoringCatalog).toHaveLength(15);
  });

  test("all entries have unique names", () => {
    const names = refactoringCatalog.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all entries have at least one move", () => {
    for (const shape of refactoringCatalog) {
      expect(shape.moves.length).toBeGreaterThan(0);
    }
  });

  test("all entries have at least one indicator", () => {
    for (const shape of refactoringCatalog) {
      expect(shape.indicators.length).toBeGreaterThan(0);
    }
  });

  test("all entries have at least one problem-level hook", () => {
    for (const shape of refactoringCatalog) {
      expect(shape.problemLevelHooks.length).toBeGreaterThan(0);
    }
  });

  test("all entries have a valid gatePosition", () => {
    const valid = ["before", "after", "per-step"];
    for (const shape of refactoringCatalog) {
      expect(valid).toContain(shape.gatePosition);
    }
  });

  test("all entries have a valid resolution model", () => {
    for (const shape of refactoringCatalog) {
      expect(["lookup", "discover"]).toContain(shape.resolution.model);
      expect(["deterministic", "heuristic"]).toContain(shape.resolution.confidence);
    }
  });

  test("all move targetSiteSchemas are refactoring schemas", () => {
    const validSchemas = ["ast-node", "symbol-fqn", "file-line-range", "class-pair"];
    for (const shape of refactoringCatalog) {
      for (const m of shape.moves) {
        expect(validSchemas).toContain(m.targetSiteSchema);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Validator Tests
// ════════════════════════════════════════════════════════════════════

describe("Validators: ast-node", () => {
  test("accepts valid ast-node", () => {
    expect(isAstNode("src/utils.ts:FunctionDeclaration:processData")).toBe(true);
  });

  test("accepts multi-colon paths", () => {
    expect(isAstNode("C:\\src\\utils.ts:Method:foo")).toBe(true);
  });

  test("rejects missing parts", () => {
    expect(isAstNode("file.ts:Node")).toBe(false);
    expect(isAstNode("file.ts")).toBe(false);
  });

  test("rejects empty parts", () => {
    expect(isAstNode(":Node:name")).toBe(false);
    expect(isAstNode("file::name")).toBe(false);
    expect(isAstNode("file:Node:")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isAstNode(42)).toBe(false);
    expect(isAstNode(null)).toBe(false);
  });
});

describe("Validators: symbol-fqn", () => {
  test("accepts simple name", () => {
    expect(isSymbolFqn("MyClass")).toBe(true);
  });

  test("accepts dotted path", () => {
    expect(isSymbolFqn("OrderService.processOrder")).toBe(true);
  });

  test("accepts underscores and dollars", () => {
    expect(isSymbolFqn("_private.$field")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isSymbolFqn("")).toBe(false);
  });

  test("rejects leading digit", () => {
    expect(isSymbolFqn("3foo")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(isSymbolFqn("My Class")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isSymbolFqn(undefined)).toBe(false);
  });
});

describe("Validators: file-line-range", () => {
  test("accepts valid range", () => {
    expect(isFileLineRange("src/utils.ts:10-25")).toBe(true);
  });

  test("accepts single-line range", () => {
    expect(isFileLineRange("file.ts:5-5")).toBe(true);
  });

  test("rejects inverted range", () => {
    expect(isFileLineRange("file.ts:25-10")).toBe(false);
  });

  test("rejects missing end line", () => {
    expect(isFileLineRange("file.ts:10")).toBe(false);
  });

  test("rejects non-numeric lines", () => {
    expect(isFileLineRange("file.ts:a-b")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isFileLineRange(123)).toBe(false);
  });
});

describe("Validators: class-pair", () => {
  test("accepts valid pair", () => {
    expect(isClassPair("OrderProcessor->OrderValidator")).toBe(true);
  });

  test("rejects single class", () => {
    expect(isClassPair("OrderProcessor")).toBe(false);
  });

  test("rejects empty sides", () => {
    expect(isClassPair("->Target")).toBe(false);
    expect(isClassPair("Source->")).toBe(false);
  });

  test("rejects triple arrow", () => {
    expect(isClassPair("A->B->C")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isClassPair(null)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Framework Integration Tests
// ════════════════════════════════════════════════════════════════════

describe("Integration: framework initialization with refactoring domain", () => {
  test("initializes successfully", () => {
    const fw = initFramework();
    expect(fw.getState()).toBe("initialized");
  });

  test("all 15 catalog entries loaded", () => {
    const fw = initFramework();
    expect(fw.getCatalog()).toHaveLength(15);
  });

  test("all 4 targetSiteSchema validators registered", () => {
    const fw = initFramework();
    const reg = fw.getRegistry();
    expect(reg.has("ast-node")).toBe(true);
    expect(reg.has("symbol-fqn")).toBe(true);
    expect(reg.has("file-line-range")).toBe(true);
    expect(reg.has("class-pair")).toBe(true);
  });
});

describe("Integration: template interpretation", () => {
  test("deterministic path — minimal (Long Method)", () => {
    const fw = initFramework();
    const env = mockEnv({ "strategyResolution.confidence": "deterministic" });
    const plan = fw.interpret(refactoringTemplate, env);

    const phaseNames = plan
      .filter((p): p is Phase & { type: "phase" } => p.type === "phase")
      .map((p) => p.name);
    expect(phaseNames).toContain("catalog-lookup");
    expect(phaseNames).not.toContain("assessor-evaluate");
  });

  test("heuristic path — maximal (Inappropriate Intimacy)", () => {
    const fw = initFramework();
    const env = mockEnv({ "strategyResolution.confidence": "heuristic" });
    const plan = fw.interpret(refactoringTemplate, env);

    const phaseNames = plan
      .filter((p): p is Phase & { type: "phase" } => p.type === "phase")
      .map((p) => p.name);
    expect(phaseNames).toContain("assessor-evaluate");
    expect(phaseNames).not.toContain("catalog-lookup");
  });

  test("unknown confidence throws DispatchError", () => {
    const fw = initFramework();
    const env = mockEnv({ "strategyResolution.confidence": "unknown" });
    expect(() => fw.interpret(refactoringTemplate, env)).toThrow(DispatchError);
  });
});

describe("Integration: verdict validation with refactoring validators", () => {
  test("accepts valid ast-node verdict", () => {
    const fw = initFramework();
    const registry = fw.getRegistry();
    const move = refactoringCatalog[0].moves[0]; // long-method: extract-method, ast-node
    const verdict = {
      outcome: "success" as const,
      confidence: 0.95,
      shouldTerminate: true,
      reason: "Method extracted successfully",
      targetSite: "src/service.ts:FunctionDeclaration:processOrder",
    };
    expect(() => validateVerdict(verdict, move, registry)).not.toThrow();
  });

  test("rejects invalid ast-node targetSite", () => {
    const fw = initFramework();
    const registry = fw.getRegistry();
    const move = refactoringCatalog[0].moves[0]; // ast-node
    const verdict = {
      outcome: "success" as const,
      confidence: 0.9,
      shouldTerminate: false,
      reason: "test",
      targetSite: "not-an-ast-node",
    };
    expect(() => validateVerdict(verdict, move, registry)).toThrow();
  });

  test("accepts valid symbol-fqn verdict", () => {
    const fw = initFramework();
    const registry = fw.getRegistry();
    const move = refactoringCatalog[1].moves[0]; // feature-envy: move-method, symbol-fqn
    const verdict = {
      outcome: "partial" as const,
      confidence: 0.7,
      shouldTerminate: false,
      reason: "Partial move",
      targetSite: "OrderService.calculateTotal",
    };
    expect(() => validateVerdict(verdict, move, registry)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// Eval Coverage Tests
// ════════════════════════════════════════════════════════════════════

describe("Eval coverage: schema-derived requirements", () => {
  test("deterministic entry does not require assessor-invoked", () => {
    const longMethod = refactoringCatalog.find((s) => s.name === "long-method")!;
    const reqs = requiredEvalCoverage(longMethod);
    expect(reqs.map((r) => r.type)).not.toContain("assessor-invoked");
  });

  test("heuristic entry requires assessor-invoked", () => {
    const featureEnvy = refactoringCatalog.find((s) => s.name === "feature-envy")!;
    const reqs = requiredEvalCoverage(featureEnvy);
    expect(reqs.map((r) => r.type)).toContain("assessor-invoked");
  });

  test("heuristic+fallback entry requires assessor-invoked", () => {
    const intimacy = refactoringCatalog.find((s) => s.name === "inappropriate-intimacy")!;
    const reqs = requiredEvalCoverage(intimacy);
    expect(reqs.map((r) => r.type)).toContain("assessor-invoked");
  });

  test("all entries require existence and both termination paths", () => {
    for (const shape of refactoringCatalog) {
      const reqs = requiredEvalCoverage(shape);
      const types = reqs.map((r) => r.type);
      expect(types).toContain("existence");
      expect(types).toContain("terminates-success");
      expect(types).toContain("terminates-exhaustion");
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Diagnostic Extreme Tests
// ════════════════════════════════════════════════════════════════════

describe("Diagnostic extremes", () => {
  test("extreme 1: deterministic + single move (Long Method)", () => {
    const longMethod = refactoringCatalog.find((s) => s.name === "long-method")!;
    expect(longMethod.resolution.confidence).toBe("deterministic");
    expect(longMethod.moves).toHaveLength(1);
    expect(longMethod.moves[0].moveType).toBe("extract-method");
  });

  test("extreme 2: heuristic + discover fallback + 4 moves (Inappropriate Intimacy)", () => {
    const intimacy = refactoringCatalog.find((s) => s.name === "inappropriate-intimacy")!;
    expect(intimacy.resolution.confidence).toBe("heuristic");
    expect(intimacy.resolution.fallback).toBe("discover");
    expect(intimacy.moves.length).toBeGreaterThanOrEqual(4);
  });

  test("extreme 3: same moveType at multiple sites (extract-method appears in Long Method)", () => {
    const longMethod = refactoringCatalog.find((s) => s.name === "long-method")!;
    // Long Method's single move type (extract-method) can apply at multiple AST sites
    expect(longMethod.moves[0].targetSiteSchema).toBe("ast-node");
    expect(longMethod.gatePosition).toBe("per-step"); // per-step gate for multi-site application
  });

  test("extreme 3b: same moveType (extract-class) appears across multiple smells", () => {
    const shapesWithExtractClass = refactoringCatalog.filter((s) =>
      s.moves.some((m) => m.moveType === "extract-class"),
    );
    expect(shapesWithExtractClass.length).toBeGreaterThanOrEqual(2);
  });

  test("minimal entries have deterministic resolution", () => {
    const minimals = ["long-method", "lazy-class", "message-chains", "middle-man"];
    for (const name of minimals) {
      const shape = refactoringCatalog.find((s) => s.name === name)!;
      expect(shape.resolution.confidence).toBe("deterministic");
      expect(shape.moves).toHaveLength(1);
    }
  });
});
