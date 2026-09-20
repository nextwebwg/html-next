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
  readonly url: string;
  readonly trustRoot: string;
  readonly definition: ComponentDefinition;
  readonly dependencies: readonly string[];
  readonly controller?: ControllerEdge;
  readonly shadowedByCustomElement: boolean;
}

export interface ComponentGraph {
  readonly roots: readonly string[];
  readonly nodes: ReadonlyMap<string, ComponentGraphNode>;
  readonly tags: ReadonlyMap<string, string>;
}

export interface BuildGraphOptions {
  readonly resolver: ComponentResourceResolver;
  readonly fetchComponent: ComponentFetcher;
  readonly parseComponentResource: ComponentResourceParser;
  readonly isCustomElementRegistered?: (tag: string) => boolean;
}

export interface ParsedComponentResource {
  readonly definition: ComponentDefinition;
  readonly dependencies: readonly string[];
}

export type ComponentResourceParser = (
  sourceText: string,
  source: string,
) => ParsedComponentResource;

interface DraftNode {
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

  const load = async (resource: ResolvedResource): Promise<string> => {
    const requestedURL = new URL(resource.url).href;
    const knownURL = aliases.get(requestedURL) ?? requestedURL;
    const known = drafts.get(knownURL);
    if (known !== undefined) return known.url;

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
    const redirected = drafts.get(finalURL);
    if (redirected !== undefined) return redirected.url;

    const parsed = options.parseComponentResource(response.source, finalURL);
    const definition = parsed.definition;
    const priorURL = tags.get(definition.contract.tag);
    if (priorURL !== undefined && priorURL !== finalURL) {
      fail(
        "HL007",
        `Both \`${priorURL}\` and \`${finalURL}\` declare <${definition.contract.tag}>.`,
        finalURL,
      );
    }
    tags.set(definition.contract.tag, finalURL);

    const draft: DraftNode = {
      url: finalURL,
      trustRoot: resource.trustRoot,
      definition,
      dependencies: [],
      shadowedByCustomElement: options.isCustomElementRegistered?.(definition.contract.tag) ?? false,
      complete: false,
    };
    drafts.set(finalURL, draft);

    if (definition.controller !== undefined) {
      const controller = options.resolver.resolveDependency(
        definition.controller,
        finalURL,
        resource.trustRoot,
      );
      draft.controller = Object.freeze({ specifier: definition.controller, url: controller.url });
    }

    for (const specifier of parsed.dependencies) {
      const dependency = options.resolver.resolveDependency(specifier, finalURL, resource.trustRoot);
      const dependencyURL = await load(dependency);
      if (!draft.dependencies.includes(dependencyURL)) draft.dependencies.push(dependencyURL);
    }
    draft.complete = true;
    return finalURL;
  };

  const roots: string[] = [];
  for (const specifier of rootSpecifiers) {
    roots.push(await load(options.resolver.resolveRoot(specifier)));
  }

  const nodeEntries: Array<readonly [string, ComponentGraphNode]> = [];
  for (const [url, draft] of Array.from(drafts).sort(([left], [right]) => left.localeCompare(right))) {
    if (!draft.complete) fail("HL008", `Component graph did not finish loading \`${url}\`.`);
    nodeEntries.push([url, Object.freeze({
      url,
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
    tags: new Map(Array.from(tags).sort(([left], [right]) => left.localeCompare(right))),
  });
}
