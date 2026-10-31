import { fail, HtmlDiagnosticError, HtmlDiagnosticAggregateError, recoverDiagnostic, type HtmlDiagnostic } from "./diagnostics.js";
import type { ComponentResourceResolver, ResolvedResource } from "./resolve.js";
import { withoutPageWideEntries } from "./head-rules.js";
import type { ComponentDefinition } from "./template.js";

export interface FetchedComponent {
  readonly url: string;
  readonly source: string;
}

export type ComponentFetcher = (url: string) => Promise<FetchedComponent>;

export interface ControllerEdge {
  readonly specifier: string;
  readonly url: string;
}

export interface ComponentGraphNode {
  /** Unique definition identity; differs from the resource URL when it declares several components. */
  readonly id: string;
  /** The physical HTML resource, used for fetching, relative URLs, and source diagnostics. */
  readonly url: string;
  readonly trustRoot: string;
  readonly definition: ComponentDefinition;
  /** Linked definition IDs; siblings in the same resource share its declaration scope. */
  readonly dependencies: readonly string[];
  readonly controller?: ControllerEdge;
  readonly module?: ControllerEdge;
  readonly shadowedByCustomElement: boolean;
  /**
   * An imported component (components#page-wide-head-entries): reached through a bare specifier, from a
   * source the application does not list, or from another imported component. Its definition
   * leaves out the page-wide head entries only an application component contributes.
   */
  readonly imported?: true;
  /** A checked target implementation replaces this definition's web dependencies. */
  readonly implementationBoundary?: true;
}

export interface ComponentGraph {
  /** Definition IDs for every carrier in the requested resources. */
  readonly roots: readonly string[];
  readonly nodes: ReadonlyMap<string, ComponentGraphNode>;
  /** Component tags mapped to definition IDs. */
  readonly tags: ReadonlyMap<string, string>;
  /** Check mode only: non-fatal diagnostics from a graph that otherwise loaded. */
  readonly warnings?: readonly HtmlDiagnostic[];
}

export interface BuildGraphOptions {
  /** Collect independent resource failures, then reject with all diagnostics. */
  readonly collectDiagnostics?: boolean;
  readonly resolver: ComponentResourceResolver;
  readonly fetchComponent: ComponentFetcher;
  readonly parseComponentResource: ComponentResourceParser;
  readonly prepareStyles?: (definition: ComponentDefinition, resource: ResolvedResource) => Promise<ComponentDefinition>;
  /** Host-owned identity/interface checks select a replacement before web styles, modules or links load. */
  readonly isImplementationBoundary?: (definition: ComponentDefinition, id: string) => boolean;
  readonly isCustomElementRegistered?: (tag: string) => boolean;
  /** Whether a definition's final URL supplies application components; a bare specifier never does. */
  readonly isApplicationURL?: (url: string) => boolean;
  /** Receives warnings outside check mode, such as an imported component's ignored entries. */
  readonly warn?: (diagnostic: HtmlDiagnostic) => void;
  /** Warnings about the finished graph's definitions together, such as a build's style checks. */
  readonly inspectDefinitions?: (definitions: readonly ComponentDefinition[]) => readonly HtmlDiagnostic[];
}

export interface ParsedComponentResource {
  /** @deprecated Use `definitions`; this is the first carrier for older callers. */
  readonly definition: ComponentDefinition;
  readonly definitions: readonly ComponentDefinition[];
  readonly dependencies: readonly string[];
}

/** A check parser can retain dependency links while withholding invalid definitions. */
export interface DiagnosedComponentResource {
  readonly definitions: readonly ComponentDefinition[];
  readonly dependencies: readonly string[];
  readonly diagnostics: readonly HtmlDiagnostic[];
}

export type ComponentResourceParser = (
  sourceText: string,
  source: string,
) => ParsedComponentResource | DiagnosedComponentResource;

const URL_LIKE = /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/;

function byKey([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number {
  return left.localeCompare(right);
}

interface DraftNode {
  url: string;
  trustRoot: string;
  definition: ComponentDefinition;
  dependencies: string[];
  controller?: ControllerEdge;
  module?: ControllerEdge;
  shadowedByCustomElement: boolean;
  complete: boolean;
  implementationBoundary?: true;
}

export async function buildComponentGraph(
  rootSpecifiers: readonly string[],
  options: BuildGraphOptions,
): Promise<ComponentGraph> {
  const diagnostics: HtmlDiagnostic[] = [];
  const report = options.collectDiagnostics ? (diagnostic: HtmlDiagnostic): void => { diagnostics.push(diagnostic); } : undefined;
  const drafts = new Map<string, DraftNode>();
  const aliases = new Map<string, string>();
  const tags = new Map<string, string>();

  // Cache resources separately from definitions: one fetch can supply several graph nodes.
  const resources = new Map<string, readonly string[]>();
  // Definitions an import reached through a bare specifier or an unlisted source; a resource reached
  // both ways is imported, and so is everything reached from one.
  const imports = new Set<string>();
  const load = async (resource: ResolvedResource, specifier: string): Promise<readonly string[]> => {
    try {
      const ids = await loadResource(resource);
      if (!URL_LIKE.test(specifier)) for (const id of ids) imports.add(id);
      return ids;
    }
    catch (error) {
      recoverDiagnostic(error, report);
      // Cache failed resources as well, so shared invalid dependencies are checked once.
      resources.set(aliases.get(resource.url) ?? resource.url, []);
      return [];
    }
  };
  const loadResource = async (resource: ResolvedResource): Promise<readonly string[]> => {
    const requestedURL = new URL(resource.url).href;
    const knownURL = aliases.get(requestedURL) ?? requestedURL;
    const known = resources.get(knownURL);
    if (known !== undefined) return known;

    let response: FetchedComponent;
    try {
      response = await options.fetchComponent(requestedURL);
    } catch (error) {
      if (error instanceof HtmlDiagnosticError) throw error;
      fail(
        "HL009",
        `Component \`${requestedURL}\` failed to load: ${error instanceof Error ? error.message : String(error)}.`,
        requestedURL,
      );
    }
    const finalURL = options.resolver.assertFinalURL(resource, response.url, requestedURL);
    aliases.set(requestedURL, finalURL);
    const redirected = resources.get(finalURL);
    if (redirected !== undefined) return redirected;

    const parsed = options.parseComponentResource(response.source, finalURL);
    const listed = options.isApplicationURL?.(finalURL) ?? true;
    if ("diagnostics" in parsed && parsed.diagnostics.length > 0) {
      recoverDiagnostic(new HtmlDiagnosticAggregateError(parsed.diagnostics), report);
    }
    const ids = parsed.definitions.map((definition) => {
      const tag = definition.contract.tag;
      const prior = tags.get(tag);
      if (prior !== undefined) {
        fail("HL007", `Both \`${drafts.get(prior)!.url}\` and \`${finalURL}\` declare <${tag}>.`, finalURL);
      }
      const id = parsed.definitions.length === 1 ? finalURL : `${finalURL}#${tag}`;
      const implementationBoundary = options.isImplementationBoundary?.(definition, id) ?? false;
      tags.set(tag, id);
      if (!listed) imports.add(id);
      drafts.set(id, {
        url: finalURL, trustRoot: resource.trustRoot, definition, dependencies: [],
        shadowedByCustomElement: options.isCustomElementRegistered?.(tag) ?? false,
        ...(implementationBoundary ? { implementationBoundary: true as const } : {}),
        complete: false,
      });
      return id;
    });
    // Publish the whole resource before traversing its links, so cycles never fetch it again.
    resources.set(finalURL, Object.freeze(ids));
    if (options.prepareStyles !== undefined) {
      for (const id of ids) {
        const draft = drafts.get(id)!;
        if (draft.implementationBoundary) continue;
        draft.definition = await options.prepareStyles(draft.definition, { url: finalURL, trustRoot: resource.trustRoot });
      }
    }
    const dependencies = new Set<string>();
    const replaced = ids.length > 0 && ids.every(id => drafts.get(id)!.implementationBoundary);
    for (const specifier of replaced ? [] : parsed.dependencies) {
      try {
        const dependency = options.resolver.resolveDependency(specifier, finalURL, resource.trustRoot);
        for (const id of await load(dependency, specifier)) dependencies.add(id);
      } catch (error) { recoverDiagnostic(error, report); }
    }
    for (const id of ids) {
      const draft = drafts.get(id)!;
      const definition = draft.definition;
      if (draft.implementationBoundary) { draft.complete = true; continue; }
      const specifier = definition.module ?? definition.controller;
      if (specifier !== undefined) {
        let controller: ResolvedResource;
        try {
          controller = options.resolver.resolveDependency(specifier, finalURL, resource.trustRoot);
        } catch (error) {
          if (error instanceof HtmlDiagnosticError && error.diagnostic.code === "HL003") {
            fail("HL005", `Component module \`${specifier}\` is outside the component's approved root.`, finalURL);
          }
          throw error;
        }
        draft[definition.module === undefined ? "controller" : "module"] = { specifier, url: controller.url };
      }
      draft.dependencies = [...dependencies];
      draft.complete = true;
    }
    return ids;
  };

  const roots: string[] = [];
  for (const specifier of rootSpecifiers) {
    try {
      for (const id of await load(options.resolver.resolveRoot(specifier), specifier)) {
        if (!roots.includes(id)) roots.push(id);
      }
    } catch (error) { recoverDiagnostic(error, report); }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity !== "warning")) throw new HtmlDiagnosticAggregateError(diagnostics);

  const imported = new Set<string>();
  const reach = (id: string): void => {
    if (imported.has(id)) return;
    imported.add(id);
    for (const dependency of drafts.get(id)?.dependencies ?? []) reach(dependency);
  };
  for (const id of imports) reach(id);
  const warn = report ?? options.warn ?? ((diagnostic: HtmlDiagnostic) => console.warn(`${diagnostic.source}: ${diagnostic.code}: ${diagnostic.message}`));
  const nodeEntries: Array<readonly [string, ComponentGraphNode]> = [];
  for (const [id, draft] of Array.from(drafts).sort(byKey)) {
    if (!draft.complete) fail("HL008", `Component graph did not finish loading \`${id}\`.`);
    let definition = draft.definition;
    if (imported.has(id)) {
      const { definition: kept, ignored } = withoutPageWideEntries(definition);
      definition = kept;
      for (const entry of ignored) {
        warn({ code: "HL011", message: `<${definition.contract.tag}> is an imported component, so its ${entry} is ignored: it is a page-wide head entry, which only an application component sets.`,
          source: draft.url, severity: "warning" });
      }
    }
    nodeEntries.push([id, Object.freeze({
      id,
      url: draft.url,
      trustRoot: draft.trustRoot,
      definition,
      ...(imported.has(id) ? { imported: true as const } : {}),
      dependencies: Object.freeze(Array.from(draft.dependencies)),
      ...(draft.controller === undefined ? {} : { controller: draft.controller }),
      ...(draft.module === undefined ? {} : { module: draft.module }),
      shadowedByCustomElement: draft.shadowedByCustomElement,
      ...(draft.implementationBoundary ? { implementationBoundary: true as const } : {}),
    })]);
  }
  for (const warning of options.inspectDefinitions?.(nodeEntries.filter(([, node]) => !node.implementationBoundary).map(([, node]) => node.definition)) ?? []) warn(warning);
  return Object.freeze({
    roots: Object.freeze(roots),
    nodes: new Map(nodeEntries),
    tags: new Map(Array.from(tags).sort(byKey)),
    ...(diagnostics.length === 0 ? {} : { warnings: Object.freeze(diagnostics) }),
  });
}
