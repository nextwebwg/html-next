export { defineContract, serializePropTarget } from "./contract.js";
export { HtmlDiagnosticError } from "./diagnostics.js";
export {
  generateComponent,
  GENERATOR_VERSION,
  type GeneratedArtifact,
} from "./generate.js";
export { parseComponent } from "./parser.js";
export { parseSourceComponent } from "./source.js";
export { getDomInterface, resolveDomProperty } from "./platform.js";
export {
  getElementValidity,
  installValidityStyles,
  readValue,
  setElementValidity,
  validateElement,
  validationMessage,
} from "./validity.js";
export { rewriteValiditySelectors } from "./validity-css.js";
export {
  NATIVE_FLAG,
  validate,
  type Constraint,
  type Validity,
  type ValidityError,
  type ValidityReason,
} from "./validate.js";
export type * from "./template.js";
export type * from "./types.js";
