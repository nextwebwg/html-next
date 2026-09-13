import { fail } from "./diagnostics.js";
import type { ParsedComponentResource } from "./graph.js";
import { parseComponentNodes } from "./parser.js";
import type { ComponentDefinition } from "./template.js";

function browserPlatform(root: Document) {
  const propertyCache = new Map<string, ReadonlyMap<string, string>>();
  const isNativeElement = (name: string): boolean => {
    if (name.includes("-")) return false;
    const element = root.createElement(name);
    const Unknown = root.defaultView?.HTMLUnknownElement;
    return Unknown === undefined
      ? element.constructor.name !== "HTMLUnknownElement"
      : !(element instanceof Unknown);
  };
  return {
    isNativeElement,
    resolveDomProperty(tagName: string, propertyName: string): string | undefined {
      if (!isNativeElement(tagName)) return undefined;
      let properties = propertyCache.get(tagName);
      if (properties === undefined) {
        const found = new Map<string, string>();
        let object: object | null = root.createElement(tagName);
        while (object !== null) {
          for (const name of Object.getOwnPropertyNames(object)) found.set(name.toLowerCase(), name);
          object = Object.getPrototypeOf(object) as object | null;
        }
        properties = found;
        propertyCache.set(tagName, properties);
      }
      return properties.get(propertyName.toLowerCase());
    },
  };
}

/**
 * Reads a browser-parsed inert carrier directly through the shared component parser. The browser
 * has already normalized names, values, entities, and template contents.
 */
export function parseBrowserComponent(
  carrier: Element,
  source = carrier.ownerDocument.URL,
): ComponentDefinition {
  if (carrier.localName !== "template" || !carrier.hasAttribute("component")) {
    fail("HS001", "A browser component carrier must be a <template component>.", source);
  }
  return parseComponentNodes([carrier], source, browserPlatform(carrier.ownerDocument));
}

function significant(nodes: readonly Node[]): Node[] {
  return nodes.filter((node) =>
    node.nodeType !== 8 && (node.nodeType !== 3 || (node.nodeValue ?? "").trim() !== "")
  );
}

/** Parses a fetched component resource with the browser's inert HTML fragment parser. */
export function parseBrowserComponentResource(
  sourceText: string,
  source: string,
  root: Document,
): ParsedComponentResource {
  const container = root.createElement("template");
  container.innerHTML = sourceText;
  const nodes = significant(Array.from(container.content.childNodes));
  const templates = nodes.filter((node): node is HTMLTemplateElement =>
    node.nodeType === 1 && (node as Element).localName === "template" &&
    (node as Element).hasAttribute("component")
  );
  if (templates.length !== 1) {
    fail("HS001", "A component resource must contain exactly one <template component>.", source);
  }
  const dependencies: string[] = [];
  for (const node of nodes) {
    if (node === templates[0]) continue;
    if (
      node.nodeType !== 1 || (node as Element).localName !== "link" ||
      (node as Element).getAttribute("rel") !== "component"
    ) {
      fail("HT009", "A component resource may contain only dependency links and one inert carrier.", source);
    }
    const href = (node as Element).getAttribute("href");
    if (href === null || href.trim() === "") {
      fail("HL006", "A component dependency link requires a non-empty `href`.", source);
    }
    dependencies.push(href);
  }
  return Object.freeze({
    definition: parseBrowserComponent(templates[0]!, source),
    dependencies: Object.freeze(dependencies),
  });
}
