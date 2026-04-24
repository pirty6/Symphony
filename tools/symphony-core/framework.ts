/**
 * framework.ts — Framework class with interpreter, validator registry, and lifecycle.
 *
 * The interpreter is a compile-time function: schema → linear plan.
 * The Framework enforces initialization order via FrameworkState.
 */

import type {
  CatalogEntry,
  DomainInstance,
  FrameworkState,
  Phase,
  SchemaEnvironment,
  TargetSiteValidator,
  TemplateNode,
  ValidatorRegistry,
} from "./types";
import { DispatchError, LifecycleError, SchemaError } from "./errors";

// ── Validator Registry Implementation ──────────────────────────────

class ValidatorRegistryImpl implements ValidatorRegistry {
  private validators = new Map<string, TargetSiteValidator>();

  register(schema: string, validator: TargetSiteValidator): void {
    this.validators.set(schema, validator);
  }

  get(schema: string): TargetSiteValidator | undefined {
    return this.validators.get(schema);
  }

  has(schema: string): boolean {
    return this.validators.has(schema);
  }

  schemas(): string[] {
    return [...this.validators.keys()];
  }
}

// ── Framework ──────────────────────────────────────────────────────

export class Framework {
  private state: FrameworkState = "uninitialized";
  private registry: ValidatorRegistryImpl = new ValidatorRegistryImpl();
  private catalog: CatalogEntry[] = [];

  /**
   * Runs the initialization lifecycle:
   * 1. Register targetSite validators (domain setup)
   * 2. Load catalog (domain setup)
   * 3. Validate catalog completeness against registry
   */
  initialize(domain: DomainInstance): void {
    if (this.state === "executing") {
      throw new LifecycleError("initialize", "uninitialized", this.state);
    }
    this.registry = new ValidatorRegistryImpl();
    domain.registerValidators(this.registry);
    this.catalog = domain.loadCatalog();
    this.validateCatalogCompleteness();
    this.state = "initialized";
  }

  /**
   * Interpret a template into a linear phase list.
   * Resolves all dispatch nodes using env.resolve().
   * Throws DispatchError if a dispatch value has no matching branch.
   */
  interpret(template: TemplateNode[], env: SchemaEnvironment): Phase[] {
    if (this.state === "uninitialized") {
      throw new LifecycleError("interpret", "initialized", this.state);
    }
    return template.flatMap((node) => this.interpretNode(node, env));
  }

  getRegistry(): ValidatorRegistry {
    return this.registry;
  }

  getCatalog(): readonly CatalogEntry[] {
    return this.catalog;
  }

  getState(): FrameworkState {
    return this.state;
  }

  // ── Private ────────────────────────────────────────────────────

  private interpretNode(node: TemplateNode, env: SchemaEnvironment): Phase[] {
    switch (node.type) {
      case "phase":
        return [{ type: "phase", name: node.name }];
      case "gate":
        return [{ type: "gate", requires: node.requires }];
      case "loop_start":
        return [{ type: "loop_start" }];
      case "loop_end":
        return [{ type: "loop_end" }];
      case "dispatch": {
        const value = env.resolve(node.on);
        const branch = node.branches[value];
        if (!branch) {
          throw new DispatchError(
            node.on,
            value,
            Object.keys(node.branches),
          );
        }
        return branch.flatMap((n) => this.interpretNode(n, env));
      }
    }
  }

  /**
   * Validates that every targetSiteSchema declared in the catalog
   * has a registered validator. Throws SchemaError on first gap.
   */
  private validateCatalogCompleteness(): void {
    for (const entry of this.catalog) {
      for (const move of entry.moves) {
        if (!this.registry.has(move.targetSiteSchema)) {
          throw new SchemaError(
            `Catalog entry '${entry.name}' declares targetSiteSchema '${move.targetSiteSchema}' ` +
              `but no validator is registered for it`,
          );
        }
      }
    }
  }
}
