/**
 * Shape catalog entry point.
 *
 * Importing this module triggers self-registration of every shape.
 * Adding a new shape = add a new file here AND nothing in score.ts.
 */

import "./put-spread-hedge";
import "./straddle";

export {
  registerShape,
  getShape,
  hasShape,
  listShapes,
  clearShapeRegistry,
  DuplicateShapeError,
  UnknownShapeError,
  EmptyCatalogError,
} from "./registry";
export type { Shape, ShapeEvaluateOptions } from "./types";
