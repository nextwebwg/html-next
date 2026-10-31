export { defineContract, serializePropTarget, selectedPropType } from "./contract-platform.js";
export { add, divide, multiply, subtract } from "./decimal.js";
export { getDiagnosticLocation, HtmlDiagnosticAggregateError, HtmlDiagnosticError, recoverDiagnostic, withDiagnosticLocation, type DiagnosticLocation, type HtmlDiagnostic } from "./diagnostics.js";
export {
  generateComponent,
  generateHostTypes,
  generateVueComponent,
  generateReactComponent,
  generateReactConversion,
  generateSvelteConversion,
  GENERATOR_VERSION,
  importsVueHost,
  importsVueBindings,
  importsVueHtml,
  importsVueControl,
  importsVueProps,
  importsVueRequests,
  importsVueHead,
  headHelperArtifact,
  requestsHelperArtifact,
  vueHostArtifact,
  vueBindingsArtifact,
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
  svelteRenderArtifact,
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
  reactRenderArtifact,
  type GeneratedArtifact,
} from "./generate.js";
export { LANGUAGE_EXTENSIONS, TRANSITIONS_EXTENSION, transitionElements } from "./transition-syntax.js";
export { publishedStates } from "./targets/state-roots.js";
export { addControllerGraph } from "./controller-files.js";
export { writeHostDeclarations } from "./host-declarations.js";
export { parseComponent } from "./source-parser.js";
export { parseSourceComponent } from "./source.js";
export { preparedModuleRevision } from "./module-preparation.js";
export { assembleComponentPackage } from "./package.js";
export type * from "./package-config.js";
export { buildComponentGraph, parseComponentResource } from "./source-graph.js";
export { expandComponentEntries, loadNodeComponents } from "./node-loader.js";
export { ComponentGraphRegistry } from "./registry.js";
export { ComponentRegistry, componentRegistry, type ComponentInit } from "./component-registry.js";
export { ResourceResolver, isWithinTrustRoot } from "./resolve.js";
export {
  clearControllerCache,
  loadController,
  loadControllerModule,
  loadComponentModule,
  activateModule,
  type ComponentModule,
  type Connect,
  type ConnectionContext,
  type Controller,
  type ControllerModule,
} from "./controller.js";
export { DataResource } from "./data.js";
export { componentInputs, type ComponentInputs, type InputSource, type InputSnapshot, type InputStatus, type InputFailure, type InputEvaluation } from "./inputs.js";
export { RequestEvent, type RequestEventInit, type RequestOptions, type Responder, type ResponderInit } from "./requests.js";
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
export { compileComponentStylesForConversion, compileComponentGraphStylesForConversion, compileComponentStylesForBuild, compileSharedComponentStylesForBuild, compileComponentGraphStylesForBuild, compileComponentStylesForSvelte, compileComponentStylesForVue } from "./component-styles-build.js";
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

export { generateAngularConversion, angularArtifacts, type AngularOptions, type AngularConversion } from "./targets/angular.js";
