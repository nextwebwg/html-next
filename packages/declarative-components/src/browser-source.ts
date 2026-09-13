import { fail } from "./diagnostics.js";
import type { ParsedComponentResource } from "./graph.js";
import { parseComponentNodes } from "./parser.js";
import type { ComponentDefinition } from "./template.js";

const platforms = new WeakMap<Document, ReturnType<typeof browserPlatform>>();

function browserPlatform(root: Document) {
  const nativeElements: Record<string, boolean> = {};
  const properties: Record<string, string> = {};
  const isNativeElement = (name: string): boolean => {
    if (name.includes("-")) return false;
    if (Object.hasOwn(nativeElements, name)) return nativeElements[name]!;
    const element = root.createElement(name);
    const Unknown = root.defaultView?.HTMLUnknownElement;
    const native = Unknown === undefined
      ? element.constructor.name !== "HTMLUnknownElement"
      : !(element instanceof Unknown);
    nativeElements[name] = native;
    return native;
  };
  return {
    isNativeElement,
    resolveDomProperty(tagName: string, propertyName: string): string | undefined {
      if (!isNativeElement(tagName)) return undefined;
      const key = `${tagName}:${propertyName}`;
      if (key in properties) return properties[key] || undefined;
      let object: object | null = root.createElement(tagName);
      const lowerName = propertyName.toLowerCase();
      while (object !== null) {
        for (const name of Object.getOwnPropertyNames(object)) {
          if (name.toLowerCase() === lowerName) {
            properties[key] = name;
            return name;
          }
        }
        object = Object.getPrototypeOf(object) as object | null;
      }
      properties[key] = "";
      return undefined;
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
  const document = carrier.ownerDocument;
  let platform = platforms.get(document);
  if (platform === undefined) {
    platform = browserPlatform(document);
    platforms.set(document, platform);
  }
  return parseComponentNodes([carrier], source, platform);
}

/** Parses a fetched component resource with the browser's inert HTML fragment parser. */
export function parseBrowserComponentResource(
  sourceText: string,
  source: string,
  root: Document,
): ParsedComponentResource {
  const container = root.createElement("template");
  container.innerHTML = sourceText;
  let carrier: HTMLTemplateElement | undefined;
  for (const node of container.content.childNodes) {
    if (
      node.nodeType === 1 && (node as Element).localName === "template" &&
      (node as Element).hasAttribute("component")
    ) {
      if (carrier !== undefined) {
        fail("HS001", "A component resource must contain exactly one <template component>.", source);
      }
      carrier = node as HTMLTemplateElement;
    }
  }
  if (carrier === undefined) {
    fail("HS001", "A component resource must contain exactly one <template component>.", source);
  }
  const dependencies: string[] = [];
  for (const node of container.content.childNodes) {
    if (node === carrier || node.nodeType === 8 ||
      (node.nodeType === 3 && (node.nodeValue ?? "").trim() === "")) continue;
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
  return {
    definition: parseBrowserComponent(carrier, source),
    dependencies,
  };
}
