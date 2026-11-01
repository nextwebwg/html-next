import { hoistStylesheetNamespaces } from "./stylesheet-namespaces.js";
import { generateDocs } from "./targets/docs.js";
import { generateVanilla } from "./targets/vanilla.js";
import { generateHostDeclaration } from "./targets/host-types.js";
import { TRANSITIONS_EXTENSION } from "./transition-syntax.js";
import { generateVue, type VueConversionOptions } from "./targets/vue.js";
import { generateReact, generateReactOutput, type ReactConversionOptions, type ReactConversionOutput } from "./targets/react.js";
import { generateSvelteOutput, type SvelteConversionOptions, type SvelteConversionOutput } from "./targets/svelte.js";
import { reactEventsArtifact as makeReactEventsArtifact } from "./targets/react-events.js";
import { reactControlArtifact as makeReactControlArtifact } from "./targets/react-control.js";
import { reactDataArtifact as makeReactDataArtifact } from "./targets/react-data.js";
import { reactHtmlArtifact as makeReactHtmlArtifact } from "./targets/react-html.js";
import { reactHostArtifact as makeReactHostArtifact } from "./targets/react-host.js";
import { reactContextArtifact as makeReactContextArtifact } from "./targets/react-context.js";
import { reactDepthArtifact as makeReactDepthArtifact } from "./targets/react-depth.js";
import { reactRenderArtifact as makeReactRenderArtifact } from "./targets/react-render.js";
import { reactPropsArtifact as makeReactPropsArtifact } from "./targets/react-props.js";
import { svelteDecorationsArtifact as makeSvelteDecorationsArtifact, svelteStyleArtifacts as makeSvelteStyleArtifacts } from "./targets/svelte-decorations.js";
import { svelteConnectionArtifact as makeSvelteConnectionArtifact } from "./targets/svelte-connection.js";
import { svelteHostArtifact as makeSvelteHostArtifact } from "./targets/svelte-host.js";
import { svelteReactivityArtifact as makeSvelteReactivityArtifact } from "./targets/svelte-reactivity.js";
import { svelteRenderArtifact as makeSvelteRenderArtifact } from "./targets/svelte-render.js";
import { svelteDataArtifact as makeSvelteDataArtifact } from "./targets/svelte-data.js";
import { sveltePropsArtifact as makeSveltePropsArtifact } from "./targets/svelte-props.js";
import { svelteControlArtifact as makeSvelteControlArtifact } from "./targets/svelte-control.js";
import { svelteEventsArtifact as makeSvelteEventsArtifact } from "./targets/svelte-events.js";
import { svelteHtmlArtifact as makeSvelteHtmlArtifact } from "./targets/svelte-html.js";
import { VUE_HOST_PATH, vueHostModule } from "./targets/vue-host.js";
import { VUE_HTML_PATH, vueHtmlModule } from "./targets/vue-html.js";
import { VUE_CONTROL_PATH, vueControlModule } from "./targets/vue-control.js";
import { VUE_PROPS_PATH, vuePropsModule } from "./targets/vue-props.js";
import { VUE_BINDINGS_PATH, vueBindingsModule } from "./targets/vue-bindings.js";
export { importsVueBindings } from "./targets/vue-bindings.js";
import { requestsArtifact as makeRequestsArtifact } from "./targets/request-host-source.js";
import { headHelperArtifact as makeHeadArtifact } from "./targets/head-target.js";
import { HtmlDiagnosticError } from "./diagnostics.js";
import type { ComponentDefinition } from "./template.js";
import { compileComponentStylesForBuild, compileComponentGraphStylesForBuild } from "./component-styles-build.js";
import { wrapStylesheetConditions } from "./stylesheet-resources.js";

export const GENERATOR_VERSION = "1.0.0-alpha.82";

export interface GeneratedArtifact {
  readonly path: string;
  readonly content: string;
}

export interface GenerationOptions {
  /** Integrate an existing bound module's prepare/adopt exports using this application source revision. */
  readonly modulePreparation?: { readonly source: string };
  /** A closed component graph proves no descendant reads this definition's state through <context>. */
  readonly noContextReaders?: boolean;
  /**
   * The components this definition's template invokes, by tag: the module exporting each one's
   * factory, and its definition. A compiled invocation calls that factory, as live lowering
   * renders the registered component; a tag not listed stays a plain custom element.
   */
  readonly invocations?: ReadonlyMap<string, Invoked>;
  /**
   * Optional language extensions the build enables, by name. A component that uses one the build
   * does not enable fails `HT024`.
   */
  readonly extensions?: readonly string[];
  /**
   * The Vanilla factory also adopts a server-rendered root, given as its third argument, binding that
   * DOM in place (see `docs/compiled-direct-path.md`, Hydration).
   */
  readonly hydrate?: boolean;
  /**
   * The Vanilla module also records what its template writes on its root, so that evaluating a
   * changed module carries over only the attributes each replaced root received from outside its
   * template. A development server enables it.
   */
  readonly hot?: boolean;
  /**
   * A bundler's module specifier for a declared script whose `src` is relative to the definition,
   * whose default export is the script's emitted or served URL, such as Vite's `?url` import.
   * Without one, a relative `src` resolves against the generated module's URL at runtime.
   */
  readonly scriptURL?: (src: string, definition: ComponentDefinition) => string | undefined;
  /**
   * The linked graph's definitions, by tag. Their slots and props type converted Vue invocations as
   * the converter's do, another component's `:state()` tests resolve against them, and the
   * component's root carries the states their styles test on it; `invocations`' definitions when
   * omitted.
   */
  readonly definitions?: ReadonlyMap<string, ComponentDefinition>;
}

/** A component another's template invokes: the module exporting its factory, and its definition. */
export interface Invoked {
  readonly module: string;
  readonly definition: ComponentDefinition;
}

export function generateComponent(
  definition: ComponentDefinition,
  options?: GenerationOptions,
): readonly GeneratedArtifact[] {
  const graph = new Map([
    ...options?.definitions ?? new Map([...options?.invocations ?? []].map(([tag, invoked]) => [tag, invoked.definition] as const)),
    [definition.contract.tag, definition] as const,
  ]);
  const vanilla = generateVanilla(definition, GENERATOR_VERSION, options?.noContextReaders === true, options?.invocations,
    options?.extensions?.includes(TRANSITIONS_EXTENSION) === true, options?.hydrate === true, options?.scriptURL, graph, options?.hot === true);
  const vue = convertedToVue(definition, {
    slotsByTag: new Map([...graph].map(([tag, invoked]) => [tag, invoked.slots ?? []] as const)),
    propContractsByTag: new Map([...graph].map(([tag, invoked]) => [tag, invoked.contract.props] as const)),
    componentGraph: graph,
    ...(options?.modulePreparation === undefined ? {} : { modulePreparation: options.modulePreparation }),
  });
  const docs = generateDocs(definition, GENERATOR_VERSION);
  const { name, tag } = definition.contract;
  const styles = (definition.stylesheets?.length ?? 0) > 0
    ? compileComponentGraphStylesForBuild([definition], graph) : compileComponentStylesForBuild(definition.css, definition, undefined, undefined, true, graph).css;

  return Object.freeze([
    Object.freeze({ path: `vanilla/${name}.js`, content: vanilla.module }),
    Object.freeze({ path: `vanilla/${name}.d.ts`, content: vanilla.declaration }),
    ...(vue === undefined ? [] : [Object.freeze({ path: `vue/${name}.vue`, content: vue })]),
    Object.freeze({
      path: `styles/${tag}.css`,
      content: `/* Generated by HTML Next ${GENERATOR_VERSION}. Do not edit. */\n${styles}${styles === "" ? "" : "\n"}`,
    }),
    Object.freeze({ path: `docs/${tag}.md`, content: docs }),
  ]);
}

/**
 * The typed controller host for a component, as `<tag>.host.d.ts` content: `Host` and `Controller`,
 * typed from its `<defs>`. `definitions` are the linked graph's components by tag.
 */
export function generateHostTypes(definition: ComponentDefinition, definitions?: ReadonlyMap<string, ComponentDefinition>): string {
  return generateHostDeclaration(definition, GENERATOR_VERSION, definitions);
}

/** The one module the converted Vue components share; every package that emits Vue ships it once. */
export function vueHostArtifact(): GeneratedArtifact {
  return Object.freeze({ path: VUE_HOST_PATH, content: vueHostModule(GENERATOR_VERSION) });
}

/** Feature-specific producer preparation and hydration for converted Vue binding modules. */
export function vueBindingsArtifact(): GeneratedArtifact {
  return Object.freeze({ path: VUE_BINDINGS_PATH, content: vueBindingsModule(GENERATOR_VERSION) });
}

/** Feature-specific safe-markup helper for Vue components that author `$html`. */
export function vueHtmlArtifact(): GeneratedArtifact {
  return Object.freeze({ path: VUE_HTML_PATH, content: vueHtmlModule(GENERATOR_VERSION) });
}

/** Feature-specific native-control binding and hydration preservation for Vue. */
export function vueControlArtifact(): GeneratedArtifact {
  return Object.freeze({ path: VUE_CONTROL_PATH, content: vueControlModule(GENERATOR_VERSION) });
}

/** Feature-specific typed-prop boundary for Vue components that declare props. */
export function vuePropsArtifact(): GeneratedArtifact {
  return Object.freeze({ path: VUE_PROPS_PATH, content: vuePropsModule(GENERATOR_VERSION) });
}

/** The head manager and framework adapter converted components that declare head content import. */
export function headHelperArtifact(target: "vue" | "react" | "svelte"): GeneratedArtifact {
  return makeHeadArtifact(target, GENERATOR_VERSION);
}

/** The request steps converted components that declare requests import, for one framework target. */
export function requestsHelperArtifact(target: "vue" | "react" | "svelte"): GeneratedArtifact {
  return makeRequestsArtifact(target, GENERATOR_VERSION);
}

/** Target-independent typed invocation rules, copied into React output only when props are used. */
export function reactPropsArtifact(): GeneratedArtifact {
  return makeReactPropsArtifact(GENERATOR_VERSION);
}

export function svelteDecorationsArtifact(): GeneratedArtifact {
  return makeSvelteDecorationsArtifact(GENERATOR_VERSION);
}

export function svelteStyleArtifacts(): readonly GeneratedArtifact[] {
  return makeSvelteStyleArtifacts(GENERATOR_VERSION);
}

export function svelteConnectionArtifact(): GeneratedArtifact {
  return makeSvelteConnectionArtifact(GENERATOR_VERSION);
}

export function svelteHostArtifact(): GeneratedArtifact {
  return makeSvelteHostArtifact(GENERATOR_VERSION);
}

export function svelteReactivityArtifact(): GeneratedArtifact {
  return makeSvelteReactivityArtifact(GENERATOR_VERSION);
}

export function svelteDataArtifact(): GeneratedArtifact {
  return makeSvelteDataArtifact(GENERATOR_VERSION);
}

/** The rendering helpers converted Svelte components share; every package that emits Svelte ships it once. */
export function svelteRenderArtifact(): GeneratedArtifact {
  return makeSvelteRenderArtifact(GENERATOR_VERSION);
}

export function sveltePropsArtifact(): GeneratedArtifact {
  return makeSveltePropsArtifact(GENERATOR_VERSION);
}

export function svelteHtmlArtifact(): GeneratedArtifact {
  return makeSvelteHtmlArtifact(GENERATOR_VERSION);
}

export function svelteControlArtifact(): GeneratedArtifact {
  return makeSvelteControlArtifact(GENERATOR_VERSION);
}

export function svelteEventsArtifact(declared = false): GeneratedArtifact {
  return makeSvelteEventsArtifact(GENERATOR_VERSION, declared);
}

export function reactEventsArtifact(declared = false): GeneratedArtifact {
  return makeReactEventsArtifact(GENERATOR_VERSION, declared);
}

export function reactControlArtifact(): GeneratedArtifact {
  return makeReactControlArtifact(GENERATOR_VERSION);
}

export function reactDataArtifact(): GeneratedArtifact {
  return makeReactDataArtifact(GENERATOR_VERSION);
}

export function reactHtmlArtifact(): GeneratedArtifact {
  return makeReactHtmlArtifact(GENERATOR_VERSION);
}

export function reactHostArtifact(): GeneratedArtifact {
  return makeReactHostArtifact(GENERATOR_VERSION);
}

export function reactContextArtifact(): GeneratedArtifact {
  return makeReactContextArtifact(GENERATOR_VERSION);
}

export function reactDepthArtifact(): GeneratedArtifact {
  return makeReactDepthArtifact(GENERATOR_VERSION);
}

/** The rendering helpers converted React components share; every package that emits React ships it once. */
export function reactRenderArtifact(target: "react" | "preact" = "react"): GeneratedArtifact {
  return makeReactRenderArtifact(GENERATOR_VERSION, target);
}

export { importsVueHost } from "./targets/vue-host.js";
export { importsVueHtml } from "./targets/vue-html.js";
export { importsVueControl } from "./targets/vue-control.js";
export { importsVueProps } from "./targets/vue-props.js";
export { importsVueHead, importsVueRequests } from "./targets/vue.js";

export type { ComponentDefinition } from "./template.js";

/**
 * The Vue conversion, or nothing when the definition uses a construct Vue conversion does not map
 * yet. HTML Next's own outputs do not depend on it; `generateVueComponent` reports the reason.
 */
function convertedToVue(definition: ComponentDefinition, options: VueConversionOptions): string | undefined {
  try {
    return generateVue(inlineStylesheetSources(definition), GENERATOR_VERSION, options);
  } catch (error) {
    if (error instanceof HtmlDiagnosticError && /^HT03\d$/.test(error.diagnostic.code)) return undefined;
    throw error;
  }
}

/** Converts one definition to a Vue single-file component, failing with a diagnostic if it cannot. */
export function generateVueComponent(definition: ComponentDefinition, options?: VueConversionOptions): string {
  return generateVue(inlineStylesheetSources(definition), GENERATOR_VERSION, options);
}

/** Converts one definition to a React component, failing when a construct is not yet mapped. */
export function generateReactComponent(definition: ComponentDefinition, options?: ReactConversionOptions): string {
  return generateReact(inlineStylesheetSources(definition), GENERATOR_VERSION, options);
}

/** Converts one definition with CSS and helper usage for package-level output. */
export function generateReactConversion(definition: ComponentDefinition, options?: ReactConversionOptions): ReactConversionOutput {
  return generateReactOutput(inlineStylesheetSources(definition), GENERATOR_VERSION, options);
}

export function generateSvelteConversion(definition: ComponentDefinition, options?: SvelteConversionOptions): SvelteConversionOutput {
  return generateSvelteOutput(inlineStylesheetSources(definition), GENERATOR_VERSION, options);
}

function inlineStylesheetSources(definition: ComponentDefinition): ComponentDefinition {
  if ((definition.stylesheets?.length ?? 0) === 0) return definition;
  return { ...definition, stylesheets: [], css: hoistStylesheetNamespaces(definition.stylesheets!.map(sheet =>
    wrapStylesheetConditions(sheet.css, sheet.conditions)).join("\n") + "\n" + definition.css) };
}
