/**
 * symphony-core.test.ts — Tier 1 (template/interpreter) + Tier 2 (protocol) tests.
 *
 * Tier 1: deterministic property tests over templates and schemas.
 * Tier 2: deterministic protocol tests with mockable verdicts and synthetic traces.
 */

import { Framework } from "./framework";
import {
  DispatchError,
  FrameworkError,
  LifecycleError,
  ProgressStallError,
  SchemaError,
  VerdictValidationError,
} from "./errors";
import { checkProgress, validateVerdict } from "./invariants";
import {
  generateEvalScaffold,
  requiredEvalCoverage,
  verifyCoverage,
} from "./eval-toolchain";
import type {
  CatalogEntry,
  CatalogMove,
  DomainInstance,
  IterationRecord,
  MoveVerdict,
  Phase,
  SchemaEnvironment,
  TemplateNode,
  ValidatorRegistry,
} from "./types";

// ── Test Helpers ───────────────────────────────────────────────────

function mockEnv(values: Record<string, string>): SchemaEnvironment {
  return {
    resolve(path: string): string {
      const v = values[path];
      if (v === undefined) throw new Error(`No value for ${path}`);
      return v;
    },
  };
}

function mockDomain(
  catalog: CatalogEntry[] = [],
  validators: Record<string, (v: unknown) => v is string> = {},
): DomainInstance {
  return {
    name: "test",
    template: [],
    registerValidators(registry: ValidatorRegistry): void {
      for (const [schema, validator] of Object.entries(validators)) {
        registry.register(schema, validator);
      }
    },
    loadCatalog(): CatalogEntry[] {
      return catalog;
    },
  };
}

const alwaysValid = (v: unknown): v is string => typeof v === "string";

function validVerdict(overrides: Partial<MoveVerdict> = {}): MoveVerdict {
  return {
    outcome: "success",
    confidence: 0.9,
    shouldTerminate: false,
    reason: "test reason",
    targetSite: "valid-site",
    ...overrides,
  };
}

function testMove(schema = "test-schema"): CatalogMove {
  return { moveType: "test-move", targetSiteSchema: schema, description: "test" };
}

function registryWith(schemas: Record<string, (v: unknown) => v is string>): ValidatorRegistry {
  const fw = new Framework();
  fw.initialize(mockDomain([], schemas));
  return fw.getRegistry();
}

// ════════════════════════════════════════════════════════════════════
// TIER 1: Template & Interpreter Tests
// ════════════════════════════════════════════════════════════════════

describe("Tier 1: Framework lifecycle", () => {
  test("starts in uninitialized state", () => {
    const fw = new Framework();
    expect(fw.getState()).toBe("uninitialized");
  });

  test("transitions to initialized after initialize()", () => {
    const fw = new Framework();
    fw.initialize(mockDomain());
    expect(fw.getState()).toBe("initialized");
  });

  test("interpret throws LifecycleError when uninitialized", () => {
    const fw = new Framework();
    expect(() => fw.interpret([], mockEnv({}))).toThrow(LifecycleError);
  });

  test("LifecycleError has correct fields", () => {
    const fw = new Framework();
    try {
      fw.interpret([], mockEnv({}));
      fail("Expected LifecycleError");
    } catch (e) {
      expect(e).toBeInstanceOf(LifecycleError);
      const le = e as LifecycleError;
      expect(le.method).toBe("interpret");
      expect(le.requiredState).toBe("initialized");
      expect(le.actualState).toBe("uninitialized");
      expect(le.tier).toBe("compile");
    }
  });
});

describe("Tier 1: Catalog completeness validation", () => {
  test("throws SchemaError when catalog uses unregistered targetSiteSchema", () => {
    const fw = new Framework();
    const catalog: CatalogEntry[] = [{
      name: "test-entry",
      resolution: { model: "lookup", confidence: "deterministic" },
      moves: [{ moveType: "test", targetSiteSchema: "unknown-schema", description: "test" }],
    }];
    expect(() => fw.initialize(mockDomain(catalog))).toThrow(SchemaError);
  });

  test("passes when all targetSiteSchemas have validators", () => {
    const fw = new Framework();
    const catalog: CatalogEntry[] = [{
      name: "test-entry",
      resolution: { model: "lookup", confidence: "deterministic" },
      moves: [{ moveType: "test", targetSiteSchema: "test-schema", description: "test" }],
    }];
    expect(() => fw.initialize(mockDomain(catalog, { "test-schema": alwaysValid }))).not.toThrow();
  });

  test("SchemaError message includes entry name and schema", () => {
    const fw = new Framework();
    const catalog: CatalogEntry[] = [{
      name: "my-entry",
      resolution: { model: "lookup", confidence: "deterministic" },
      moves: [{ moveType: "test", targetSiteSchema: "missing", description: "test" }],
    }];
    try {
      fw.initialize(mockDomain(catalog));
      fail("Expected SchemaError");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
      expect((e as SchemaError).message).toContain("my-entry");
      expect((e as SchemaError).message).toContain("missing");
    }
  });
});

describe("Tier 1: Interpreter — phase nodes", () => {
  let fw: Framework;

  beforeEach(() => {
    fw = new Framework();
    fw.initialize(mockDomain());
  });

  test("interprets empty template to empty plan", () => {
    expect(fw.interpret([], mockEnv({}))).toEqual([]);
  });

  test("interprets phase node", () => {
    const template: TemplateNode[] = [{ type: "phase", name: "classify" }];
    const plan = fw.interpret(template, mockEnv({}));
    expect(plan).toEqual([{ type: "phase", name: "classify" }]);
  });

  test("interprets gate node", () => {
    const template: TemplateNode[] = [{ type: "gate", requires: "approval" }];
    const plan = fw.interpret(template, mockEnv({}));
    expect(plan).toEqual([{ type: "gate", requires: "approval" }]);
  });

  test("interprets loop markers", () => {
    const template: TemplateNode[] = [
      { type: "loop_start" },
      { type: "phase", name: "execute" },
      { type: "loop_end" },
    ];
    const plan = fw.interpret(template, mockEnv({}));
    expect(plan).toEqual([
      { type: "loop_start" },
      { type: "phase", name: "execute" },
      { type: "loop_end" },
    ]);
  });

  test("interprets mixed template preserving order", () => {
    const template: TemplateNode[] = [
      { type: "phase", name: "a" },
      { type: "gate", requires: "x" },
      { type: "loop_start" },
      { type: "phase", name: "b" },
      { type: "loop_end" },
      { type: "phase", name: "c" },
    ];
    const plan = fw.interpret(template, mockEnv({}));
    expect(plan).toHaveLength(6);
    expect(plan[0]).toEqual({ type: "phase", name: "a" });
    expect(plan[5]).toEqual({ type: "phase", name: "c" });
  });
});

describe("Tier 1: Interpreter — dispatch nodes", () => {
  let fw: Framework;

  beforeEach(() => {
    fw = new Framework();
    fw.initialize(mockDomain());
  });

  test("resolves dispatch to matching branch", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "strategyResolution.confidence",
      branches: {
        deterministic: [{ type: "phase", name: "catalog-lookup" }],
        heuristic: [{ type: "phase", name: "assessor-evaluate" }],
      },
    }];
    const env = mockEnv({ "strategyResolution.confidence": "deterministic" });
    const plan = fw.interpret(template, env);
    expect(plan).toEqual([{ type: "phase", name: "catalog-lookup" }]);
  });

  test("resolves dispatch to heuristic branch", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "strategyResolution.confidence",
      branches: {
        deterministic: [{ type: "phase", name: "catalog-lookup" }],
        heuristic: [{ type: "phase", name: "assessor-evaluate" }],
      },
    }];
    const env = mockEnv({ "strategyResolution.confidence": "heuristic" });
    const plan = fw.interpret(template, env);
    expect(plan).toEqual([{ type: "phase", name: "assessor-evaluate" }]);
  });

  test("throws DispatchError for unknown branch value", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "mode",
      branches: {
        a: [{ type: "phase", name: "alpha" }],
        b: [{ type: "phase", name: "beta" }],
      },
    }];
    const env = mockEnv({ mode: "c" });
    expect(() => fw.interpret(template, env)).toThrow(DispatchError);
  });

  test("DispatchError has correct fields", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "x.y",
      branches: { a: [], b: [] },
    }];
    const env = mockEnv({ "x.y": "z" });
    try {
      fw.interpret(template, env);
      fail("Expected DispatchError");
    } catch (e) {
      expect(e).toBeInstanceOf(DispatchError);
      const de = e as DispatchError;
      expect(de.dispatchOn).toBe("x.y");
      expect(de.resolvedValue).toBe("z");
      expect(de.availableBranches).toEqual(["a", "b"]);
      expect(de.tier).toBe("compile");
    }
  });

  test("dispatch branch can contain multiple nodes", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "mode",
      branches: {
        full: [
          { type: "phase", name: "step1" },
          { type: "gate", requires: "check" },
          { type: "phase", name: "step2" },
        ],
      },
    }];
    const env = mockEnv({ mode: "full" });
    const plan = fw.interpret(template, env);
    expect(plan).toHaveLength(3);
    expect(plan[1]).toEqual({ type: "gate", requires: "check" });
  });

  test("dispatch branch can be empty", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "mode",
      branches: { skip: [] },
    }];
    const env = mockEnv({ mode: "skip" });
    const plan = fw.interpret(template, env);
    expect(plan).toEqual([]);
  });

  test("nested dispatch resolves correctly", () => {
    const template: TemplateNode[] = [{
      type: "dispatch",
      on: "outer",
      branches: {
        a: [{
          type: "dispatch",
          on: "inner",
          branches: {
            x: [{ type: "phase", name: "a-x" }],
            y: [{ type: "phase", name: "a-y" }],
          },
        }],
      },
    }];
    const env = mockEnv({ outer: "a", inner: "y" });
    const plan = fw.interpret(template, env);
    expect(plan).toEqual([{ type: "phase", name: "a-y" }]);
  });
});

describe("Tier 1: Interpreter — full refactoring template shape", () => {
  let fw: Framework;

  beforeEach(() => {
    fw = new Framework();
    fw.initialize(mockDomain());
  });

  const refactoringTemplate: TemplateNode[] = [
    { type: "phase", name: "classify" },
    {
      type: "dispatch",
      on: "strategyResolution.confidence",
      branches: {
        deterministic: [{ type: "phase", name: "catalog-lookup" }],
        heuristic: [{ type: "phase", name: "assessor-evaluate" }],
      },
    },
    { type: "gate", requires: "strategy-confirmed" },
    { type: "loop_start" },
    { type: "phase", name: "execute-move" },
    { type: "phase", name: "verify-move" },
    { type: "gate", requires: "move-success" },
    { type: "loop_end" },
    { type: "phase", name: "verify-problem" },
  ];

  test("deterministic path produces correct linear plan", () => {
    const env = mockEnv({ "strategyResolution.confidence": "deterministic" });
    const plan = fw.interpret(refactoringTemplate, env);
    const names = plan.map((p) => ("name" in p ? p.name : `requires` in p ? `gate:${p.requires}` : p.type));
    expect(names).toEqual([
      "classify",
      "catalog-lookup",
      "gate:strategy-confirmed",
      "loop_start",
      "execute-move",
      "verify-move",
      "gate:move-success",
      "loop_end",
      "verify-problem",
    ]);
  });

  test("heuristic path swaps lookup for assessor", () => {
    const env = mockEnv({ "strategyResolution.confidence": "heuristic" });
    const plan = fw.interpret(refactoringTemplate, env);
    expect(plan[1]).toEqual({ type: "phase", name: "assessor-evaluate" });
  });

  test("deterministic path has no assessor phase", () => {
    const env = mockEnv({ "strategyResolution.confidence": "deterministic" });
    const plan = fw.interpret(refactoringTemplate, env);
    const phaseNames = plan.filter((p): p is Phase & { type: "phase" } => p.type === "phase").map((p) => p.name);
    expect(phaseNames).not.toContain("assessor-evaluate");
  });

  test("both paths have loop_start before loop_end", () => {
    for (const confidence of ["deterministic", "heuristic"] as const) {
      const env = mockEnv({ "strategyResolution.confidence": confidence });
      const plan = fw.interpret(refactoringTemplate, env);
      const loopStartIdx = plan.findIndex((p) => p.type === "loop_start");
      const loopEndIdx = plan.findIndex((p) => p.type === "loop_end");
      expect(loopStartIdx).toBeLessThan(loopEndIdx);
    }
  });

  test("every execute phase is followed by verify within the loop", () => {
    for (const confidence of ["deterministic", "heuristic"] as const) {
      const env = mockEnv({ "strategyResolution.confidence": confidence });
      const plan = fw.interpret(refactoringTemplate, env);
      const loopStartIdx = plan.findIndex((p) => p.type === "loop_start");
      const loopEndIdx = plan.findIndex((p) => p.type === "loop_end");
      const loopBody = plan.slice(loopStartIdx + 1, loopEndIdx);
      const execIdx = loopBody.findIndex((p) => p.type === "phase" && p.name === "execute-move");
      expect(loopBody[execIdx + 1]).toEqual({ type: "phase", name: "verify-move" });
    }
  });
});

describe("Tier 1: Error hierarchy", () => {
  test("all errors extend FrameworkError", () => {
    expect(new SchemaError("x")).toBeInstanceOf(FrameworkError);
    expect(new DispatchError("a", "b", ["c"])).toBeInstanceOf(FrameworkError);
    expect(new LifecycleError("m", "r", "a")).toBeInstanceOf(FrameworkError);
    expect(new VerdictValidationError("f", "e", "r", "m")).toBeInstanceOf(FrameworkError);
    expect(new ProgressStallError("m", "t", "h", 1)).toBeInstanceOf(FrameworkError);
  });

  test("compile-time errors have tier=compile", () => {
    expect(new SchemaError("x").tier).toBe("compile");
    expect(new DispatchError("a", "b", []).tier).toBe("compile");
    expect(new LifecycleError("m", "r", "a").tier).toBe("compile");
  });

  test("runtime errors have tier=runtime", () => {
    expect(new VerdictValidationError("f", "e", "r", "m").tier).toBe("runtime");
    expect(new ProgressStallError("m", "t", "h", 1).tier).toBe("runtime");
  });

  test("error names match class names", () => {
    expect(new SchemaError("x").name).toBe("SchemaError");
    expect(new DispatchError("a", "b", []).name).toBe("DispatchError");
    expect(new VerdictValidationError("f", "e", "r", "m").name).toBe("VerdictValidationError");
    expect(new ProgressStallError("m", "t", "h", 1).name).toBe("ProgressStallError");
    expect(new LifecycleError("m", "r", "a").name).toBe("LifecycleError");
  });
});

// ════════════════════════════════════════════════════════════════════
// TIER 2: Protocol Tests (mockable verdicts, synthetic traces)
// ════════════════════════════════════════════════════════════════════

describe("Tier 2: checkProgress — stall detection", () => {
  test("empty trace passes", () => {
    expect(checkProgress([])).toBe(true);
  });

  test("distinct moves pass", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "applied", stateHash: "h1" },
      { step: 2, moveType: "extract-method", targetSite: "b.ts:Func:bar", outcome: "applied", stateHash: "h2" },
    ];
    expect(checkProgress(trace)).toBe(true);
  });

  test("same move+site with different stateHash passes", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "applied", stateHash: "h1" },
      { step: 2, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "applied", stateHash: "h2" },
    ];
    expect(checkProgress(trace)).toBe(true);
  });

  test("same move+site+hash detects stall", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "applied", stateHash: "h1" },
      { step: 2, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "applied", stateHash: "h1" },
    ];
    expect(checkProgress(trace)).toBe(false);
  });

  test("failed move at same site+hash detects stall", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "move-method", targetSite: "X.foo", outcome: "failed", stateHash: "h1" },
      { step: 2, moveType: "move-method", targetSite: "X.foo", outcome: "failed", stateHash: "h1" },
    ];
    expect(checkProgress(trace)).toBe(false);
  });

  test("skipped moves are excluded from stall detection", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "skipped", stateHash: "h1" },
      { step: 2, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "skipped", stateHash: "h1" },
    ];
    expect(checkProgress(trace)).toBe(true);
  });

  test("skipped then applied at same hash is not a stall", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "skipped", stateHash: "h1" },
      { step: 2, moveType: "extract-method", targetSite: "a.ts:Func:foo", outcome: "applied", stateHash: "h1" },
    ];
    expect(checkProgress(trace)).toBe(true);
  });

  test("applied then failed at different hash passes", () => {
    const trace: IterationRecord[] = [
      { step: 1, moveType: "move-method", targetSite: "X.foo", outcome: "applied", stateHash: "h1" },
      { step: 2, moveType: "move-method", targetSite: "X.foo", outcome: "failed", stateHash: "h2" },
    ];
    expect(checkProgress(trace)).toBe(true);
  });
});

describe("Tier 2: validateVerdict — boundary enforcement", () => {
  const registry = registryWith({ "test-schema": alwaysValid });

  test("accepts valid verdict", () => {
    expect(() => validateVerdict(validVerdict(), testMove(), registry)).not.toThrow();
  });

  test("rejects null verdict", () => {
    expect(() => validateVerdict(null, testMove(), registry)).toThrow(VerdictValidationError);
  });

  test("rejects undefined verdict", () => {
    expect(() => validateVerdict(undefined, testMove(), registry)).toThrow(VerdictValidationError);
  });

  test("rejects non-object verdict", () => {
    expect(() => validateVerdict("string", testMove(), registry)).toThrow(VerdictValidationError);
  });

  test("rejects invalid outcome", () => {
    expect(() => validateVerdict(
      { ...validVerdict(), outcome: "sucess" }, // typo
      testMove(),
      registry,
    )).toThrow(VerdictValidationError);
  });

  test("rejects missing outcome", () => {
    const v = { ...validVerdict() } as Record<string, unknown>;
    delete v.outcome;
    expect(() => validateVerdict(v, testMove(), registry)).toThrow(VerdictValidationError);
  });

  test("rejects confidence out of range (> 1)", () => {
    expect(() => validateVerdict(
      { ...validVerdict(), confidence: 1.5 },
      testMove(),
      registry,
    )).toThrow(VerdictValidationError);
  });

  test("rejects confidence out of range (< 0)", () => {
    expect(() => validateVerdict(
      { ...validVerdict(), confidence: -0.1 },
      testMove(),
      registry,
    )).toThrow(VerdictValidationError);
  });

  test("rejects non-number confidence", () => {
    expect(() => validateVerdict(
      { ...validVerdict(), confidence: "high" },
      testMove(),
      registry,
    )).toThrow(VerdictValidationError);
  });

  test("accepts confidence at boundaries (0 and 1)", () => {
    expect(() => validateVerdict({ ...validVerdict(), confidence: 0 }, testMove(), registry)).not.toThrow();
    expect(() => validateVerdict({ ...validVerdict(), confidence: 1 }, testMove(), registry)).not.toThrow();
  });

  test("rejects non-boolean shouldTerminate", () => {
    expect(() => validateVerdict(
      { ...validVerdict(), shouldTerminate: "yes" },
      testMove(),
      registry,
    )).toThrow(VerdictValidationError);
  });

  test("rejects non-string reason", () => {
    expect(() => validateVerdict(
      { ...validVerdict(), reason: 42 },
      testMove(),
      registry,
    )).toThrow(VerdictValidationError);
  });

  test("rejects invalid targetSite per schema", () => {
    const strictRegistry = registryWith({
      strict: ((v: unknown): v is string => v === "only-this") as (v: unknown) => v is string,
    });
    expect(() => validateVerdict(
      { ...validVerdict(), targetSite: "wrong" },
      testMove("strict"),
      strictRegistry,
    )).toThrow(VerdictValidationError);
  });

  test("throws SchemaError for unregistered targetSiteSchema", () => {
    expect(() => validateVerdict(
      validVerdict(),
      testMove("unregistered"),
      registry,
    )).toThrow(SchemaError);
  });

  test("VerdictValidationError includes field and moveType", () => {
    try {
      validateVerdict({ ...validVerdict(), outcome: "bad" }, testMove(), registry);
      fail("Expected VerdictValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(VerdictValidationError);
      const ve = e as VerdictValidationError;
      expect(ve.field).toBe("outcome");
      expect(ve.moveType).toBe("test-move");
      expect(ve.tier).toBe("runtime");
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// TIER 1: Eval Toolchain Tests
// ════════════════════════════════════════════════════════════════════

describe("Tier 1: requiredEvalCoverage", () => {
  test("deterministic entry requires existence + both termination paths", () => {
    const entry: CatalogEntry = {
      name: "test",
      resolution: { model: "lookup", confidence: "deterministic" },
      moves: [],
    };
    const reqs = requiredEvalCoverage(entry);
    const types = reqs.map((r) => r.type);
    expect(types).toContain("existence");
    expect(types).toContain("terminates-success");
    expect(types).toContain("terminates-exhaustion");
    expect(types).not.toContain("assessor-invoked");
  });

  test("heuristic entry additionally requires assessor-invoked", () => {
    const entry: CatalogEntry = {
      name: "test",
      resolution: { model: "lookup", confidence: "heuristic" },
      moves: [],
    };
    const reqs = requiredEvalCoverage(entry);
    const types = reqs.map((r) => r.type);
    expect(types).toContain("assessor-invoked");
  });

  test("entry with fallback requires assessor-invoked", () => {
    const entry: CatalogEntry = {
      name: "test",
      resolution: { model: "lookup", confidence: "deterministic", fallback: "discover" },
      moves: [],
    };
    const reqs = requiredEvalCoverage(entry);
    const types = reqs.map((r) => r.type);
    expect(types).toContain("assessor-invoked");
  });
});

describe("Tier 1: verifyCoverage", () => {
  test("passes when all requirements met", () => {
    const reqs = [
      { type: "existence" as const, min: 1 },
      { type: "terminates-success" as const, min: 1 },
    ];
    const decls = ["existence" as const, "terminates-success" as const];
    const report = verifyCoverage(reqs, decls);
    expect(report.passed).toBe(true);
    expect(report.missing).toEqual([]);
  });

  test("fails with correct gaps", () => {
    const reqs = [
      { type: "existence" as const, min: 1 },
      { type: "terminates-success" as const, min: 1 },
      { type: "assessor-invoked" as const, min: 1 },
    ];
    const decls = ["existence" as const];
    const report = verifyCoverage(reqs, decls);
    expect(report.passed).toBe(false);
    expect(report.missing).toContain("terminates-success");
    expect(report.missing).toContain("assessor-invoked");
    expect(report.missing).not.toContain("existence");
  });

  test("empty declarations fail all requirements", () => {
    const reqs = [{ type: "existence" as const, min: 1 }];
    const report = verifyCoverage(reqs, []);
    expect(report.passed).toBe(false);
    expect(report.missing).toEqual(["existence"]);
  });
});

describe("Tier 1: generateEvalScaffold", () => {
  test("generates one case per gap", () => {
    const cases = generateEvalScaffold("feature-envy", ["assessor-invoked", "terminates-exhaustion"]);
    expect(cases).toHaveLength(2);
  });

  test("scaffold has correct catalogEntry", () => {
    const cases = generateEvalScaffold("long-method", ["existence"]);
    expect(cases[0].catalogEntry).toBe("long-method");
  });

  test("scaffold has TODO fields (undefined)", () => {
    const cases = generateEvalScaffold("test", ["existence"]);
    expect(cases[0].input).toBeUndefined();
    expect(cases[0].expectedVerdict).toBeUndefined();
  });

  test("assessor-invoked gap produces heuristic mode", () => {
    const cases = generateEvalScaffold("test", ["assessor-invoked"]);
    expect(cases[0].assessorMode).toBe("heuristic");
  });

  test("terminates-exhaustion gap produces exhaustion termination", () => {
    const cases = generateEvalScaffold("test", ["terminates-exhaustion"]);
    expect(cases[0].expectedTermination).toBe("exhaustion");
  });

  test("coverage field matches the gap", () => {
    const cases = generateEvalScaffold("test", ["terminates-success"]);
    expect(cases[0].coverage).toEqual(["terminates-success"]);
  });
});
