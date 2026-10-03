import { SAFE_DEFAULT_ELEMENTS, SAFE_GLOBAL_ATTRIBUTES } from "../sanitizer-default.js";

/** Source embedded in each framework's feature-specific data helper. */
export const DATA_URL_SOURCE = String.raw`function dataURL(source: string, baseURL: string, parameters: Readonly<Record<string, unknown>>): string {
  const used = new Set<string>();
  const expanded = source.replace(/\{([A-Za-z_$][A-Za-z0-9_$-]*)\}/g, (_match, name: string) => {
    used.add(name);
    const value = parameters[name];
    return value == null ? "" : encodeURIComponent(String(value));
  });
  const url = new URL(expanded, baseURL);
  for (const [name, value] of Object.entries(parameters)) {
    if (used.has(name) || value == null) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, String(item));
    else url.searchParams.set(name, String(value));
  }
  return url.href;
}`;

/** One sanitizer policy for both generated frameworks; node projection stays target-owned. */
export const SAFE_HTML_SANITIZER_SOURCE = `const GLOBAL_ATTRIBUTES = new Set(${JSON.stringify([...SAFE_GLOBAL_ATTRIBUTES])});
const ELEMENTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = ${JSON.stringify(SAFE_DEFAULT_ELEMENTS)};
const HTML_NAMESPACE = parse5Html.NS.HTML;
const NAMESPACES: Readonly<Record<string, string>> = {
  [HTML_NAMESPACE]: "html",
  "http://www.w3.org/2000/svg": "svg",
  "http://www.w3.org/1998/Math/MathML": "mathml",
};

function safeAttribute(name: string, value: string): boolean {
  if (name !== "href" && name !== "cite") return true;
  try { return new URL(value, "https://example.invalid/").protocol !== "javascript:"; }
  catch { return true; }
}

function sanitizeBrowser(parent: ParentNode): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 8) { child.parentNode?.removeChild(child); continue; }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const namespace = NAMESPACES[element.namespaceURI ?? ""];
    const elements = namespace === undefined ? undefined : ELEMENTS[namespace];
    if (elements === undefined || !Object.hasOwn(elements, element.localName)) {
      element.remove();
      continue;
    }
    const local = elements[element.localName] ?? [];
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI !== null ||
        (!GLOBAL_ATTRIBUTES.has(attribute.localName) && !local.includes(attribute.localName)) ||
        !safeAttribute(attribute.localName, attribute.value)) element.removeAttributeNode(attribute);
    }
    sanitizeBrowser(element);
  }
}

function sanitizeServer(parent: DefaultTreeAdapterTypes.ParentNode): void {
  parent.childNodes = parent.childNodes.filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (!("tagName" in node)) return true;
    const namespace = NAMESPACES[node.namespaceURI];
    const elements = namespace === undefined ? undefined : ELEMENTS[namespace];
    if (elements === undefined || !Object.hasOwn(elements, node.tagName)) return false;
    const local = elements[node.tagName] ?? [];
    node.attrs = node.attrs.filter((attribute) =>
      attribute.namespace === undefined &&
      (GLOBAL_ATTRIBUTES.has(attribute.name) || local.includes(attribute.name)) &&
      safeAttribute(attribute.name, attribute.value));
    sanitizeServer(node);
    return true;
  });
}`;

/** Declared event details share the typed-prop module's strict value parser. */
export const DECLARED_EVENT_TYPE_SOURCE = `/** Declared event details use the same nested type and constraint check as typed values. */
export function acceptsDeclaredEvent(value: unknown, type: Parameters<typeof parse>[1]): boolean {
  return parse(value, type, "$").ok;
}
`;

/** Immediate declared-read checks retain raw containers; their fields are checked when read. */
export const DECLARED_REFERENCE_TYPE_SOURCE = `export function acceptsDeclaredReference(value: unknown, type: TypeNode): boolean {
  if (value == null) return true;
  switch (type.kind) {
    case "list": return Array.isArray(value);
    case "record":
    case "object": return typeof value === "object" && !Array.isArray(value);
    case "union": return type.members.some((member) => acceptsDeclaredReference(value, member));
    case "constrained": return acceptsDeclaredReference(value, type.base);
    default: return parse(value, type, "$").ok;
  }
}

/** Missing input cannot erase a child's accepted prop unless its type explicitly accepts null. */
export function acceptsBindingDestination(value: unknown, type: TypeNode): boolean {
  return value === undefined || (value === null ? parse(value, type, "$").ok : acceptsDeclaredReference(value, type));
}
`;
