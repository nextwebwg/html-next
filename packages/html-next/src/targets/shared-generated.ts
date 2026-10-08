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
}

/** What the from-parameters send, as dataURL writes them: an equal key requests nothing new. */
function dataKey(values: readonly unknown[]): string {
  return JSON.stringify(values.map((value) => value == null ? null : Array.isArray(value) ? value.map(String) : String(value)));
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
export function acceptsBindingDestination(value: unknown, type: TypeNode | null): boolean {
  return value === undefined || type !== null && (value === null ? parse(value, type, "$").ok : acceptsDeclaredReference(value, type));
}
`;


/** Snapshot local refs before invoking listeners; Vue refs can hold public component instances. */
export const DISPATCH_TARGETS_SOURCE = `export function dispatchToTargets(recorded: unknown, send: (target: Element) => void): void {
  const refs = recorded instanceof Set ? [...recorded] : Array.isArray(recorded) ? [...recorded] : [recorded];
  const targets = refs.map((ref: any) => ref?.nodeType === 1 ? ref : ref?.$el)
    .filter((element): element is Element => element?.nodeType === 1 && element.isConnected)
    .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
  for (const target of targets) {
    if (target.isConnected) send(target);
  }
}`;

/**
 * One MutationObserver per document watches every bound select's option list, which no native event
 * reports; each select runs only its own check, once per batch of records.
 */
export const OPTION_WATCH_SOURCE = `const optionWatches = new WeakMap<Document, { readonly observer: MutationObserver; readonly checks: Map<HTMLSelectElement, () => void> }>();

function watchOptions(select: HTMLSelectElement, check: () => void): () => void {
  const document = select.ownerDocument;
  let watch = optionWatches.get(document);
  if (watch === undefined) {
    const checks = new Map<HTMLSelectElement, () => void>();
    const observer = new MutationObserver((records) => {
      const changed = new Set<HTMLSelectElement>();
      for (const record of records) {
        const select = (record.target.nodeType === 1 ? record.target as Element : record.target.parentElement)?.closest('select');
        if (select) changed.add(select);
      }
      for (const select of changed) checks.get(select)?.();
    });
    watch = { observer, checks };
    optionWatches.set(document, watch);
  }
  watch.observer.observe(select, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['value'] });
  watch.checks.set(select, check);
  const current = watch;
  return () => {
    if (current.checks.get(select) === check) current.checks.delete(select);
    if (current.checks.size === 0 && optionWatches.get(document) === current) {
      current.observer.disconnect();
      optionWatches.delete(document);
    }
  };
}
`;
