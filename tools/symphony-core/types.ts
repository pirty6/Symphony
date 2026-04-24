/**
 * types.ts — Framework-level types for the Symphony decision-schema.
 *
 * These types define the domain-agnostic contracts:
 * template ADT, execution environment, verdicts, traces, eval coverage.
 */

// ── Target Site Schema ─────────────────────────────────────────────
// Open string type — domains register validators via the registry.
// Refactoring uses 'ast-node', 'symbol-fqn', 'file-line-range', 'class-pair'.

export type TargetSiteSchema = string;

// ── Strategy Resolution ────────────────────────────────────────────

export interface StrategyResolution {
  model: "lookup" | "discover";
  confidence: "deterministic" | "heuristic";
  fallback?: "discover";
}

// ── Execution & Gate Models ────────────────────────────────────────

export type ExecutionModel = "linear" | "looping" | "per-step";
export type GatePosition = "before" | "after" | "per-step";

// ── Template ADT ───────────────────────────────────────────────────
// The interpreter walks this tree and produces a linear Phase[].

export type TemplateNode =
  | PhaseNode
  | GateNode
  | LoopStartNode
  | LoopEndNode
  | DispatchNode;

export interface PhaseNode {
  readonly type: "phase";
  readonly name: string;
}

export interface GateNode {
  readonly type: "gate";
  readonly requires: string;
}

export interface LoopStartNode {
  readonly type: "loop_start";
}

export interface LoopEndNode {
  readonly type: "loop_end";
}

export interface DispatchNode {
  readonly type: "dispatch";
  readonly on: string;
  readonly branches: Record<string, TemplateNode[]>;
}

// ── Linearized Phase (interpreter output) ──────────────────────────
// Dispatch nodes are resolved and removed; only these remain.

export type Phase =
  | { readonly type: "phase"; readonly name: string }
  | { readonly type: "gate"; readonly requires: string }
  | { readonly type: "loop_start" }
  | { readonly type: "loop_end" };

// ── Catalog Move ───────────────────────────────────────────────────

export interface CatalogMove {
  readonly moveType: string;
  readonly targetSiteSchema: TargetSiteSchema;
  readonly description: string;
}

// ── Move Verdict (assessor → Composer boundary) ────────────────────

export interface MoveVerdict {
  readonly outcome: "success" | "partial" | "failed";
  readonly confidence: number;
  readonly shouldTerminate: boolean;
  readonly reason: string;
  readonly targetSite: string;
}

// ── Move Result (runtime execution output) ─────────────────────────

export interface MoveResult {
  readonly applied: boolean;
  readonly description: string;
}

// ── Execution Trace ────────────────────────────────────────────────

export interface IterationRecord {
  readonly step: number;
  readonly moveType: string;
  readonly targetSite: string;
  readonly outcome: "applied" | "skipped" | "failed";
  readonly stateHash: string;
}

// ── Execution Environment (static/dynamic split) ───────────────────
// Interpreter only touches schema. Composer only touches runtime.

export interface SchemaEnvironment {
  resolve(path: string): string;
}

export interface RuntimeEnvironment {
  stateHash(scope: string): string;
  applyMove(move: CatalogMove, site: string): MoveResult;
}

export interface ExecutionEnvironment {
  readonly schema: SchemaEnvironment;
  readonly runtime: RuntimeEnvironment;
}

// ── Catalog Entry ──────────────────────────────────────────────────

export interface CatalogEntry {
  readonly name: string;
  readonly resolution: StrategyResolution;
  readonly moves: CatalogMove[];
}

// ── Validator Registry ─────────────────────────────────────────────

export type TargetSiteValidator = (value: unknown) => value is string;

export interface ValidatorRegistry {
  register(schema: string, validator: TargetSiteValidator): void;
  get(schema: string): TargetSiteValidator | undefined;
  has(schema: string): boolean;
  schemas(): string[];
}

// ── Domain Instance ────────────────────────────────────────────────

export interface DomainInstance {
  readonly name: string;
  readonly template: TemplateNode[];
  registerValidators(registry: ValidatorRegistry): void;
  loadCatalog(): CatalogEntry[];
}

// ── Eval Types ─────────────────────────────────────────────────────

export type CoveragePoint =
  | "existence"
  | "assessor-invoked"
  | "terminates-success"
  | "terminates-exhaustion";

export interface EvalRequirement {
  readonly type: CoveragePoint;
  readonly min: number;
}

export type TODO = undefined;

export interface EvalCase {
  readonly catalogEntry: string;
  readonly coverage: CoveragePoint[];
  readonly assessorMode: "deterministic" | "heuristic" | "discover";
  readonly expectedTermination: "success" | "exhaustion";
  readonly input: string | TODO;
  readonly expectedVerdict: MoveVerdict | TODO;
}

export interface CoverageReport {
  readonly passed: boolean;
  readonly missing: CoveragePoint[];
}

// ── Framework State ────────────────────────────────────────────────

export type FrameworkState = "uninitialized" | "initialized" | "executing";
