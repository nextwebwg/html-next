export { defineContract, serializePropTarget } from "./contract-platform.js";
export { getDiagnosticLocation, HtmlDiagnosticAggregateError, HtmlDiagnosticError, recoverDiagnostic, withDiagnosticLocation, type DiagnosticLocation, type HtmlDiagnostic } from "./diagnostics.js";
export {
  generateComponent,
  generateVueComponent,
  generateReactComponent,
  generateReactConversion,
  generateSvelteConversion,
  GENERATOR_VERSION,
  importsVueHost,
  importsVueHtml,
  importsVueControl,
  importsVueProps,
  vueHostArtifact,
  vueHtmlArtifact,
  vueControlArtifact,
  vuePropsArtifact,
  reactPropsArtifact,
  sveltePropsArtifact,
  svelteHtmlArtifact,
  svelteEventsArtifact,
  svelteControlArtifact,
  svelteDataArtifact,
  svelteReactivityArtifact,
  svelteHostArtifact,
  svelteConnectionArtifact,
  svelteDecorationsArtifact,
  svelteStyleArtifacts,
  reactEventsArtifact,
  reactControlArtifact,
  reactDataArtifact,
  reactHtmlArtifact,
  reactHostArtifact,
  reactContextArtifact,
  reactDepthArtifact,
  type GeneratedArtifact,
} from "./generate.js";
export { LANGUAGE_EXTENSIONS, TRANSITIONS_EXTENSION, transitionElements } from "./transition-syntax.js";
export { addControllerGraph } from "./controller-files.js";
export { parseComponent } from "./source-parser.js";
export { parseSourceComponent } from "./source.js";
export { assembleComponentPackage } from "./package.js";
export type * from "./package-config.js";
export { buildComponentGraph, parseComponentResource } from "./source-graph.js";
export { expandComponentEntries, loadNodeComponents } from "./node-loader.js";
export { ComponentRegistry } from "./registry.js";
export { ResourceResolver, isWithinTrustRoot } from "./resolve.js";
export {
  clearControllerCache,
  loadController,
  loadControllerModule,
  type Controller,
  type ControllerModule,
} from "./controller.js";
export { DataResource } from "./data.js";
export { hasExecutableUrl, isUrlAttribute, sanitizeFragment } from "./sanitize.js";
export type * from "./graph.js";
export type * from "./resolve.js";
export { getDomInterface, resolveDomProperty } from "./platform.js";
export {
  getElementValidity,
  getElementValidityState,
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
  COMPONENT_ATTRIBUTE,
  compileComponentStyles,
  type CompiledComponentStyles,
  PROJECTED_ATTRIBUTE,
  stateAttribute,
} from "./component-styles.js";
export { compileComponentStylesForBuild, compileSharedComponentStylesForBuild, compileComponentGraphStylesForBuild, compileComponentStylesForSvelte, compileComponentStylesForVue } from "./component-styles-build.js";
export { collectSharedStylesheets, wrapStylesheetConditions } from "./stylesheet-resources.js";
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
