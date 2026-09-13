export { defineContract, serializePropTarget } from "./contract-platform.js";
export { HtmlDiagnosticError } from "./diagnostics.js";
export {
  generateComponent,
  GENERATOR_VERSION,
  type GeneratedArtifact,
} from "./generate.js";
export { parseComponent } from "./source-parser.js";
export { parseSourceComponent } from "./source.js";
export { assembleComponentPackage } from "./package.js";
export type * from "./package-config.js";
export { buildComponentGraph, parseComponentResource } from "./source-graph.js";
export {
  loadBrowserComponents,
  loadDocumentComponents,
  documentComponentRoots,
  startBrowserComponents,
} from "./browser-loader.js";
export { loadNodeComponents } from "./node-loader.js";
export { ComponentRegistry } from "./registry.js";
export { ResourceResolver, isWithinTrustRoot } from "./resolve.js";
export {
  clearControllerCache,
  loadController,
  loadControllerModule,
  type Controller,
  type ControllerModule,
} from "./controller.js";
export { validateJsonSchema, type JsonSchema } from "./json-schema.js";
export { DataResource, DataValidationError } from "./data.js";
export { hasExecutableUrl, isUrlAttribute, sanitizeFragment } from "./sanitize.js";
export type * from "./graph.js";
export type * from "./resolve.js";
export { getDomInterface, resolveDomProperty } from "./platform.js";
export {
  getElementValidity,
  getElementValidityState,
  installValidityStyles,
  manageElementValidity,
  readValue,
  refreshElementValidity,
  setElementValidity,
  setExternalValidity,
  unmanageElementValidity,
  validateElement,
  validationMessage,
} from "./validity.js";
export { rewriteValiditySelectors } from "./validity-css.js";
export {
  COMPONENT_PROVENANCE_ATTRIBUTE,
  COMPONENT_ROOT_ATTRIBUTE,
  PROJECTED_ROOT_ATTRIBUTE,
  componentStyleMode,
  transformComponentStyles,
  transformGlobalStyles,
  transformValidityStyles,
} from "./style.js";
export type { ComponentStyleMode, ComponentStyleOptions } from "./style.js";
export {
  NATIVE_FLAG,
  validate,
  type Constraint,
  type Validity,
  type ValidityError,
  type ValidityReason,
} from "./validate.js";
export {
  formatType,
  isTypeNode,
  normalizeType,
  parseTypedValue,
  parseTypeExpression,
  serializeTypedValue,
  trustedContent,
  typeScriptType,
  TypeSyntaxError,
} from "./type-system.js";
export type * from "./type-system.js";
export type * from "./template.js";
export type * from "./types.js";
