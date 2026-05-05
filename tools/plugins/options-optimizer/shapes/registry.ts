/**
 * Shape registry — module-level singleton.
 *
 * Shapes self-register on import. The Symphony Score's catalog phase
 * pulls registered shapes from here without knowing their identities,
 * so adding a new shape requires only:
 *   1. New file under tools/plugins/options-optimizer/shapes/
 *   2. Import the file from tools/plugins/options-optimizer/shapes/index.ts
 * The score's phase loop never changes.
 */

import type { Shape } from "./types";

export class DuplicateShapeError extends Error {
  constructor(name: string) {
    super(`Shape "${name}" is already registered`);
    this.name = "DuplicateShapeError";
  }
}

export class UnknownShapeError extends Error {
  constructor(name: string, available: readonly string[]) {
    super(
      `Unknown shape "${name}". Registered shapes: ${
        available.length === 0 ? "(none)" : available.join(", ")
      }`,
    );
    this.name = "UnknownShapeError";
  }
}

export class EmptyCatalogError extends Error {
  constructor(shapeName: string) {
    super(`Shape "${shapeName}" produced an empty catalog`);
    this.name = "EmptyCatalogError";
  }
}

const registry = new Map<string, Shape>();

export function registerShape(shape: Shape): void {
  if (registry.has(shape.name)) {
    throw new DuplicateShapeError(shape.name);
  }
  registry.set(shape.name, shape);
}

export function getShape(name: string): Shape {
  const shape = registry.get(name);
  if (!shape) {
    throw new UnknownShapeError(name, listShapes());
  }
  return shape;
}

export function hasShape(name: string): boolean {
  return registry.has(name);
}

export function listShapes(): string[] {
  return [...registry.keys()];
}

export function clearShapeRegistry(): void {
  registry.clear();
}
