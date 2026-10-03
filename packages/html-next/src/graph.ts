import { fail, HtmlDiagnosticError } from "./diagnostics.js";
import type { ComponentResourceResolver, ResolvedResource } from "./resolve.js";
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
  readonly shadowedByCustomElement: boolean;
}

export interface ComponentGraph {
  /** Definition IDs for every carrier in the requested resources. */
  readonly roots: readonly string[];
  readonly nodes: ReadonlyMap<string, ComponentGraphNode>;
  /** Component tags mapped to definition IDs. */
  readonly tags: ReadonlyMap<string, string>;
}

export interface BuildGraphOptions {
  readonly resolver: ComponentResourceResolver;
  readonly fetchComponent: ComponentFetcher;
  readonly parseComponentResource: ComponentResourceParser;
  readonly isCustomElementRegistered?: (tag: string) => boolean;
}

export interface ParsedComponentResource {
  readonly definitions: readonly ComponentDefinition[];
  readonly dependencies: readonly string[];
}

export type ComponentResourceParser = (
  sourceText: string,
  source: string,
) => ParsedComponentResource;

function byKey([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number {
  return left.localeCompare(right);
}

interface DraftNode {
  id: string;
  url: string;
  trustRoot: string;
  definition: ComponentDefinition;
  dependencies: string[];
  controller?: ControllerEdge;
  shadowedByCustomElement: boolean;
  complete: boolean;
}

export async function buildComponentGraph(
  rootSpecifiers: readonly string[],
  options: BuildGraphOptions,
): Promise<ComponentGraph> {
  const drafts = new Map<string, DraftNode>();
  const aliases = new Map<string, string>();
  const tags = new Map<string, string>();

  // Cache resources separately from definitions: one fetch can supply several graph nodes.
  const resources = new Map<string, readonly string[]>();
  const load = async (resource: ResolvedResource): Promise<readonly string[]> => {
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
    const ids = parsed.definitions.map((definition) => {
      const tag = definition.contract.tag;
      const prior = tags.get(tag);
      if (prior !== undefined) {
        fail("HL007", `Both \`${drafts.get(prior)!.url}\` and \`${finalURL}\` declare <${tag}>.`, finalURL);
      }
      const id = parsed.definitions.length === 1 ? finalURL : `${finalURL}#${tag}`;
      tags.set(tag, id);
      drafts.set(id, {
        id, url: finalURL, trustRoot: resource.trustRoot, definition, dependencies: [],
        shadowedByCustomElement: options.isCustomElementRegistered?.(tag) ?? false,
        complete: false,
      });
      return id;
    });
    // Publish the whole resource before traversing its links, so cycles never fetch it again.
    resources.set(finalURL, Object.freeze(ids));
    const dependencies = new Set<string>();
    for (const specifier of parsed.dependencies) {
      const dependency = options.resolver.resolveDependency(specifier, finalURL, resource.trustRoot);
      for (const id of await load(dependency)) dependencies.add(id);
    }
    for (const id of ids) {
      const draft = drafts.get(id)!;
      const definition = draft.definition;
      if (definition.controller !== undefined) {
        let controller: ResolvedResource;
        try {
          controller = options.resolver.resolveDependency(definition.controller, finalURL, resource.trustRoot);
        } catch (error) {
          if (error instanceof HtmlDiagnosticError && error.diagnostic.code === "HL003") {
            fail("HL005", `Controller \`${definition.controller}\` is outside the component's approved root.`, finalURL);
          }
          throw error;
        }
        draft.controller = Object.freeze({ specifier: definition.controller, url: controller.url });
      }
      draft.dependencies = [...dependencies];
      draft.complete = true;
    }
    return ids;
  };

  const roots: string[] = [];
  for (const specifier of rootSpecifiers) {
    for (const id of await load(options.resolver.resolveRoot(specifier))) {
      if (!roots.includes(id)) roots.push(id);
    }
  }

  const nodeEntries: Array<readonly [string, ComponentGraphNode]> = [];
  for (const [url, draft] of Array.from(drafts).sort(byKey)) {
    if (!draft.complete) fail("HL008", `Component graph did not finish loading \`${url}\`.`);
    nodeEntries.push([url, Object.freeze({
      id: draft.id,
      url: draft.url,
      trustRoot: draft.trustRoot,
      definition: draft.definition,
      dependencies: Object.freeze(Array.from(draft.dependencies)),
      ...(draft.controller === undefined ? {} : { controller: draft.controller }),
      shadowedByCustomElement: draft.shadowedByCustomElement,
    })]);
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    nodes: new Map(nodeEntries),
    tags: new Map(Array.from(tags).sort(byKey)),
  });
}
