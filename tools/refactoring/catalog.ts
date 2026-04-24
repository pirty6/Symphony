/**
 * catalog.ts — Refactoring catalog: 15 Fowler smells as data structures.
 *
 * Each RefactoringShape declares: smell name, resolution model, moves
 * with targetSiteSchema, indicators, problem-level hooks, and gate position.
 *
 * Diagnostic extremes covered:
 *   1. Deterministic + single move (minimal): Long Method, Lazy Class, Message Chains, Middle Man
 *   2. Heuristic + discover fallback + 4+ moves (maximal): Inappropriate Intimacy
 *   3. Same moveType at multiple sites: Long Method (Extract Method at many sites)
 */

import type { CatalogEntry, CatalogMove, GatePosition, StrategyResolution } from "../symphony-core/types";
import type { RefactoringTargetSiteSchema } from "./validators";

// ── RefactoringShape (extends CatalogEntry with smell-specific fields) ──

export interface RefactoringShape extends CatalogEntry {
  readonly smell: string;
  readonly indicators: string[];
  readonly problemLevelHooks: string[];
  readonly gatePosition: GatePosition;
}

// ── Helper to enforce typed targetSiteSchema on moves ───────────────

function move(
  moveType: string,
  targetSiteSchema: RefactoringTargetSiteSchema,
  description: string,
): CatalogMove {
  return { moveType, targetSiteSchema, description };
}

function deterministic(): StrategyResolution {
  return { model: "lookup", confidence: "deterministic" };
}

function heuristic(): StrategyResolution {
  return { model: "lookup", confidence: "heuristic" };
}

function heuristicWithFallback(): StrategyResolution {
  return { model: "lookup", confidence: "heuristic", fallback: "discover" };
}

// ── Catalog ─────────────────────────────────────────────────────────

export const refactoringCatalog: RefactoringShape[] = [
  // 1. Long Method — deterministic, single move (MINIMAL PATH)
  // Same moveType (Extract Method) can apply at multiple sites in the same function.
  {
    name: "long-method",
    smell: "Long Method",
    resolution: deterministic(),
    moves: [
      move("extract-method", "ast-node", "Extract a cohesive block into a named method"),
    ],
    indicators: [
      "Method body exceeds cohesion threshold",
      "Multiple levels of nesting",
      "Comments separating logical sections",
    ],
    problemLevelHooks: ["Method length reduced below threshold", "All extracted methods have single responsibility"],
    gatePosition: "per-step",
  },

  // 2. Feature Envy — heuristic, single move
  {
    name: "feature-envy",
    smell: "Feature Envy",
    resolution: heuristic(),
    moves: [
      move("move-method", "symbol-fqn", "Move method to the class it uses most"),
    ],
    indicators: [
      "Method accesses another object's data more than its own",
      "High coupling to foreign class, low coupling to host class",
    ],
    problemLevelHooks: ["Moved method accesses only local data"],
    gatePosition: "before",
  },

  // 3. Data Clumps — deterministic, single move
  {
    name: "data-clumps",
    smell: "Data Clumps",
    resolution: deterministic(),
    moves: [
      move("extract-class", "class-pair", "Extract clumped fields into a new value object"),
    ],
    indicators: [
      "Same group of fields appears in multiple classes",
      "Same group of parameters appears in multiple method signatures",
    ],
    problemLevelHooks: ["Clumped fields consolidated into single object"],
    gatePosition: "before",
  },

  // 4. Divergent Change — heuristic, 2 moves
  {
    name: "divergent-change",
    smell: "Divergent Change",
    resolution: heuristic(),
    moves: [
      move("extract-class", "file-line-range", "Extract responsibility into a separate class"),
      move("move-method", "symbol-fqn", "Move methods to their new owning class"),
    ],
    indicators: [
      "One class modified for multiple unrelated reasons",
      "Different change types touch different subsets of the same class",
    ],
    problemLevelHooks: ["Each class has a single reason to change"],
    gatePosition: "per-step",
  },

  // 5. Shotgun Surgery — heuristic, 2 moves
  {
    name: "shotgun-surgery",
    smell: "Shotgun Surgery",
    resolution: heuristic(),
    moves: [
      move("move-method", "symbol-fqn", "Consolidate scattered logic into one class"),
      move("inline-class", "symbol-fqn", "Inline the now-empty source class"),
    ],
    indicators: [
      "Single logical change requires editing many classes",
      "Related behavior scattered across the codebase",
    ],
    problemLevelHooks: ["Logical change touches only one class"],
    gatePosition: "per-step",
  },

  // 6. Primitive Obsession — deterministic, 2 moves
  {
    name: "primitive-obsession",
    smell: "Primitive Obsession",
    resolution: deterministic(),
    moves: [
      move("replace-primitive-with-object", "symbol-fqn", "Wrap primitive in a domain value type"),
      move("introduce-parameter-object", "symbol-fqn", "Group related primitives into a parameter object"),
    ],
    indicators: [
      "Primitives used to represent domain concepts (money, dates, ranges)",
      "Validation logic repeated wherever the primitive is used",
    ],
    problemLevelHooks: ["No raw primitives for the identified domain concept"],
    gatePosition: "before",
  },

  // 7. Switch Statements — deterministic, single move
  {
    name: "switch-statements",
    smell: "Switch Statements",
    resolution: deterministic(),
    moves: [
      move("replace-conditional-with-polymorphism", "ast-node", "Replace type-code switch with polymorphic dispatch"),
    ],
    indicators: [
      "Switch/if-else chain dispatching on a type code",
      "Same switch structure duplicated in multiple methods",
    ],
    problemLevelHooks: ["No switch on type code remains"],
    gatePosition: "before",
  },

  // 8. Lazy Class — deterministic, single move (MINIMAL PATH)
  {
    name: "lazy-class",
    smell: "Lazy Class",
    resolution: deterministic(),
    moves: [
      move("inline-class", "symbol-fqn", "Inline the lazy class into its consumer"),
    ],
    indicators: [
      "Class does too little to justify its existence",
      "Class is a thin wrapper with no behavior",
    ],
    problemLevelHooks: ["Inlined class no longer exists", "Consumer class remains cohesive"],
    gatePosition: "before",
  },

  // 9. Speculative Generality — deterministic, 3 moves
  {
    name: "speculative-generality",
    smell: "Speculative Generality",
    resolution: deterministic(),
    moves: [
      move("collapse-hierarchy", "class-pair", "Merge unnecessary abstract class with its only subclass"),
      move("remove-parameter", "symbol-fqn", "Remove unused parameters added for future flexibility"),
      move("rename-method", "symbol-fqn", "Rename overly abstract method names to concrete ones"),
    ],
    indicators: [
      "Abstract class with only one subclass",
      "Parameters or methods that are never used",
      "Unnecessary delegation or indirection",
    ],
    problemLevelHooks: ["No unused abstractions remain"],
    gatePosition: "before",
  },

  // 10. Temporary Field — heuristic, 2 moves
  {
    name: "temporary-field",
    smell: "Temporary Field",
    resolution: heuristic(),
    moves: [
      move("extract-class", "file-line-range", "Extract temporary fields and their logic into a dedicated class"),
      move("introduce-null-object", "symbol-fqn", "Replace null checks on the temporary field with a null object"),
    ],
    indicators: [
      "Instance field only set and used in certain circumstances",
      "Null checks on a field that should always have a value",
    ],
    problemLevelHooks: ["No conditionally-set instance fields"],
    gatePosition: "before",
  },

  // 11. Message Chains — deterministic, single move (MINIMAL PATH)
  {
    name: "message-chains",
    smell: "Message Chains",
    resolution: deterministic(),
    moves: [
      move("hide-delegate", "ast-node", "Introduce a wrapper method to hide the chain"),
    ],
    indicators: [
      "Client navigates a.b().c().d() to reach a distant object",
      "Changes to intermediate objects break the chain",
    ],
    problemLevelHooks: ["No navigation chain longer than 2 calls"],
    gatePosition: "before",
  },

  // 12. Middle Man — deterministic, single move (MINIMAL PATH)
  {
    name: "middle-man",
    smell: "Middle Man",
    resolution: deterministic(),
    moves: [
      move("remove-middle-man", "symbol-fqn", "Let the client call the delegate directly"),
    ],
    indicators: [
      "Class delegates most of its methods to another class",
      "Class adds no value over direct access to the delegate",
    ],
    problemLevelHooks: ["No pure-delegation methods remain"],
    gatePosition: "before",
  },

  // 13. Inappropriate Intimacy — heuristic + discover fallback, 4 moves (MAXIMAL PATH)
  {
    name: "inappropriate-intimacy",
    smell: "Inappropriate Intimacy",
    resolution: heuristicWithFallback(),
    moves: [
      move("move-method", "symbol-fqn", "Move methods to reduce cross-class coupling"),
      move("extract-class", "class-pair", "Extract shared behavior into a mediator class"),
      move("hide-delegate", "ast-node", "Introduce delegation to reduce direct field access"),
      move("replace-inheritance-with-delegation", "class-pair", "Break inheritance coupling with delegation"),
    ],
    indicators: [
      "Two classes access each other's private internals",
      "Bidirectional dependency between classes",
      "Subclass accesses parent's private fields directly",
    ],
    problemLevelHooks: ["No bidirectional class dependencies", "No private field access across class boundaries"],
    gatePosition: "per-step",
  },

  // 14. Refused Bequest — heuristic, 3 moves
  {
    name: "refused-bequest",
    smell: "Refused Bequest",
    resolution: heuristic(),
    moves: [
      move("replace-inheritance-with-delegation", "class-pair", "Replace inheritance with composition"),
      move("push-down-method", "symbol-fqn", "Push unused inherited methods down to siblings that need them"),
      move("extract-subclass", "class-pair", "Extract a proper subclass for the shared behavior"),
    ],
    indicators: [
      "Subclass overrides parent methods to no-op",
      "Subclass uses only a fraction of inherited interface",
      "Liskov substitution principle violated",
    ],
    problemLevelHooks: ["Subclass uses all of its inherited interface"],
    gatePosition: "before",
  },

  // 15. Large Class — heuristic, 3 moves
  {
    name: "large-class",
    smell: "Large Class",
    resolution: heuristic(),
    moves: [
      move("extract-class", "file-line-range", "Extract a cohesive subset of fields and methods"),
      move("extract-subclass", "class-pair", "Extract a subclass for a behavioral variant"),
      move("extract-interface", "symbol-fqn", "Extract an interface for a subset of the public API"),
    ],
    indicators: [
      "Class has too many fields and methods",
      "Class has multiple groups of fields used together",
      "Class name requires qualifiers (OrderProcessorAndValidator)",
    ],
    problemLevelHooks: ["Each resulting class has a single cohesive responsibility"],
    gatePosition: "per-step",
  },
];
