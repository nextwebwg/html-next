import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

import { fail, HtmlDiagnosticError } from "./diagnostics.js";
import { parseComponent } from "./parser.js";
import {
  isWithinTrustRoot,
  type ComponentResourceResolver,
  type ResolvedResource,
} from "./resolve.js";
import type { ComponentDefinition } from "./template.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;

export interface FetchedComponent {
  readonly url: string;
  readonly source: string;
}

export type ComponentFetcher = (url: string) => Promise<FetchedComponent>;

export interface ControllerEdge {
  readonly specifier: string;
  readonly url: string;
}

export interface ResourceEdge {
  readonly kind: "schema";
  readonly specifier: string;
  readonly url: string;
}

export interface ComponentGraphNode {
  readonly url: string;
  readonly trustRoot: string;
  readonly definition: ComponentDefinition;
  readonly dependencies: readonly string[];
  readonly controller?: ControllerEdge;
  readonly resources: readonly ResourceEdge[];
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
  readonly isCustomElementRegistered?: (tag: string) => boolean;
}

interface ParsedResource {
  readonly definitionSource: string;
  readonly dependencies: readonly string[];
}

interface DraftNode {
  url: string;
  trustRoot: string;
  definition: ComponentDefinition;
  dependencies: string[];
  controller?: ControllerEdge;
  resources: ResourceEdge[];
  shadowedByCustomElement: boolean;
  complete: boolean;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
  }

  get size(): number { return this.#map.size; }
  get(key: K): V | undefined { return this.#map.get(key); }
  has(key: K): boolean { return this.#map.has(key); }
  entries(): MapIterator<[K, V]> { return this.#map.entries(); }
  keys(): MapIterator<K> { return this.#map.keys(); }
  values(): MapIterator<V> { return this.#map.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#map[Symbol.iterator](); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

function significant(nodes: readonly ChildNode[]): ChildNode[] {
  return nodes.filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (node.nodeName === "#text" && "value" in node) return node.value.trim() !== "";
    return true;
  });
}

/** Separates resource-level dependency links from the one inert component carrier. */
export function parseComponentResource(sourceText: string, source: string): ParsedResource {
  const parserErrors: ParserError[] = [];
  const fragment = parseFragment(sourceText, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parserErrors.push(error),
  });
  if (parserErrors.length > 0) {
    fail("HS005", `HTML parse error: ${parserErrors[0]!.code}.`, source);
  }
  const nodes = significant(fragment.childNodes);
  const templates = nodes.filter(
    (node): node is Template => isElement(node) && node.tagName === "template" && attr(node, "component") !== undefined,
  );
  if (templates.length !== 1) {
    fail("HS001", "A component resource must contain exactly one <template component>.", source);
  }
  const dependencies: string[] = [];
  for (const node of nodes) {
    if (node === templates[0]) continue;
    if (!isElement(node) || node.tagName !== "link" || attr(node, "rel") !== "component") {
      fail("HT009", "A component resource may contain only dependency links and one inert carrier.", source);
    }
    const href = attr(node, "href");
    if (href === undefined || href.trim() === "") {
      fail("HL006", "A component dependency link requires a non-empty `href`.", source);
    }
    dependencies.push(href);
  }
  const location = templates[0]!.sourceCodeLocation;
  if (location == null || !("startOffset" in location) || !("endOffset" in location)) {
    fail("HS005", "The component carrier has no stable source range.", source);
  }
  return Object.freeze({
    definitionSource: sourceText.slice(location.startOffset, location.endOffset),
    dependencies: Object.freeze(dependencies),
  });
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

    const parsed = parseComponentResource(response.source, finalURL);
    const definition = parseComponent(parsed.definitionSource, finalURL);
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
      resources: [],
      shadowedByCustomElement: options.isCustomElementRegistered?.(definition.contract.tag) ?? false,
      complete: false,
    };
    drafts.set(finalURL, draft);

    if (definition.controller !== undefined) {
      let controller: ResolvedResource;
      try {
        controller = options.resolver.resolveDependency(
          definition.controller,
          finalURL,
          resource.trustRoot,
        );
      } catch (error) {
        if (error instanceof HtmlDiagnosticError && error.diagnostic.code === "HL003") {
          fail(
            "HL005",
            `Controller \`${definition.controller}\` is outside the component's approved root.`,
            finalURL,
          );
        }
        throw error;
      }
      if (!isWithinTrustRoot(controller.url, resource.trustRoot)) {
        fail(
          "HL005",
          `Controller \`${definition.controller}\` is outside the component's approved root.`,
          finalURL,
        );
      }
      draft.controller = Object.freeze({ specifier: definition.controller, url: controller.url });
    }

    for (const declaration of definition.declarations ?? []) {
      if (
        declaration.kind !== "data" || declaration.schema === undefined ||
        !/^(?:\.?\.?\/|\/|[A-Za-z][A-Za-z+.-]*:)/.test(declaration.schema)
      ) continue;
      const schema = options.resolver.resolveDependency(
        declaration.schema,
        finalURL,
        resource.trustRoot,
      );
      draft.resources.push(Object.freeze({
        kind: "schema",
        specifier: declaration.schema,
        url: schema.url,
      }));
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
  for (const [url, draft] of [...drafts].sort(([left], [right]) => left.localeCompare(right))) {
    if (!draft.complete) fail("HL008", `Component graph did not finish loading \`${url}\`.`);
    nodeEntries.push([url, Object.freeze({
      url,
      trustRoot: draft.trustRoot,
      definition: draft.definition,
      dependencies: Object.freeze([...draft.dependencies]),
      resources: Object.freeze([...draft.resources].sort((left, right) => left.url.localeCompare(right.url))),
      ...(draft.controller === undefined ? {} : { controller: draft.controller }),
      shadowedByCustomElement: draft.shadowedByCustomElement,
    })]);
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    nodes: new ImmutableMap(nodeEntries),
    tags: new ImmutableMap([...tags].sort(([left], [right]) => left.localeCompare(right))),
  });
}
