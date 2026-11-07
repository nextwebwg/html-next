import { hasExecutableUrl, isUrlAttribute } from "./sanitize.js";
import { NONCONFORMING } from "./expression-values.js";

export type NamespacedAttribute = readonly [namespace: string, name: string, localName: string, value: unknown, url?: boolean];

export function attributeNamespace(name: string): string | undefined {
  if (name.startsWith("xlink:")) return "http://www.w3.org/1999/xlink";
  if (name.startsWith("xml:")) return "http://www.w3.org/XML/1998/namespace";
  if (name === "xmlns" || name.startsWith("xmlns:")) return "http://www.w3.org/2000/xmlns/";
  return undefined;
}

export function writeNamespacedAttribute(element: Element, namespace: string, qualifiedName: string, localName: string, value: string | null): void {
  element.removeAttributeNS(null, qualifiedName);
  if (element.getAttributeNS(namespace, localName) === value) return;
  if (value === null) element.removeAttributeNS(namespace, localName);
  else element.setAttributeNS(namespace, qualifiedName, value);
}

export function applyNamespacedAttributes(element: Element, attributes: readonly NamespacedAttribute[], previous?: readonly NamespacedAttribute[]): void {
  for (let index = 0; index < attributes.length; index++) {
    const binding = attributes[index]!;
    const before = previous?.[index];
    if (binding[3] === NONCONFORMING || before !== undefined && binding[0] === before[0] && binding[1] === before[1] && Object.is(binding[3], before[3])) continue;
    const value = binding[3] == null ? null : String(binding[3]);
    (binding[4] ? writeNamespacedUrlAttribute : writeNamespacedAttribute)(element, binding[0], binding[1], binding[2], value);
  }
}

export function namespacedAttributeProps(attributes: readonly NamespacedAttribute[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const binding of attributes) {
    if (binding[3] === NONCONFORMING) continue;
    const value = binding[3] == null ? null : String(binding[3]);
    result[binding[1]] = binding[4] && value !== null && hasExecutableUrl(value) ? null : value;
  }
  return result;
}

export function writeNamespacedUrlAttribute(element: Element, namespace: string, qualifiedName: string, localName: string, value: string | null): void {
  writeNamespacedAttribute(element, namespace, qualifiedName, localName, value !== null && hasExecutableUrl(value) ? null : value);
}

const ROOT_METADATA = ["data-slotted", "data-html-next-bindings", "data-html-next-preparation"];

/** Renderer records belong to the component root, independently of authored forwarding. */
export function rootMetadata(input: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (!ROOT_METADATA.some(name => input[name] !== undefined)) return undefined;
  return Object.fromEntries(ROOT_METADATA.flatMap(name => input[name] === undefined ? [] : [[name, input[name]]]));
}

/** Remaining HTML inputs contain present attributes, so absent values contribute no write. */
export function forwardedAttributes(input: Readonly<Record<string, unknown>>, omit: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([name, value]) => !name.includes("\0") && !ROOT_METADATA.includes(name) && !omit.includes(name) && value != null && value !== NONCONFORMING &&
    !(isUrlAttribute(name) && hasExecutableUrl(String(value))) &&
    (value !== false || name.startsWith("aria-") || ["contenteditable", "contentEditable", "draggable", "spellcheck", "spellCheck"].includes(name))));
}

export type OrderedAttributeWrite = Readonly<Record<string, unknown>> | readonly [name: string, value: unknown, target?: "class" | "style", fallback?: string];
export interface AttributeWriteState { readonly values: unknown[]; readonly forwarded: string[][] }

function attributeText(name: string, value: unknown): string | null {
  const enumerated = name.startsWith("aria-") || ["contenteditable", "draggable", "spellcheck"].includes(name);
  const text = value == null || value === false && !enumerated ? null : typeof value === "boolean" ? enumerated ? String(value) : "" : String(value);
  return text !== null && isUrlAttribute(name) && hasExecutableUrl(text) ? null : text;
}

export type AttributeBinding = readonly [name: string, value: unknown, fallback?: string];

/** Initial native attributes for server rendering; client updates retain accepted values. */
export function attributeBindingProps(bindings: readonly AttributeBinding[]): Record<string, string | null> {
  const props: Record<string, string | null> = Object.create(null);
  for (const [name, candidate, fallback] of bindings) {
    if (candidate === NONCONFORMING && fallback === undefined) continue;
    props[name] = attributeText(name, candidate === NONCONFORMING ? fallback : candidate);
  }
  return props;
}

/** Replay authored writes at one destination while retaining each binding's accepted result. */
export function applyOrderedAttributes(element: Element, writes: readonly OrderedAttributeWrite[], state: AttributeWriteState): void {
  const put = (name: string, value: unknown): void => {
    const text = attributeText(name, value);
    const namespace = attributeNamespace(name);
    if (namespace !== undefined) writeNamespacedAttribute(element, namespace, name, name.slice(name.indexOf(":") + 1), text);
    else if (element.getAttribute(name) !== text) { if (text === null) element.removeAttribute(name); else element.setAttribute(name, text); }
  };
  for (let index = 0; index < writes.length; index += 1) {
    const write = writes[index]!;
    if (Array.isArray(write)) continue;
    const names = Object.keys(forwardedAttributes(write as Readonly<Record<string, unknown>>));
    for (const name of state.forwarded[index] ?? []) if (!names.includes(name)) put(name, null);
    state.forwarded[index] = names;
  }
  for (let index = 0; index < writes.length; index += 1) {
    const write = writes[index]!;
    if (!Array.isArray(write)) { for (const name of state.forwarded[index]!) put(name, (write as Readonly<Record<string, unknown>>)[name]); continue; }
    const [name, candidate, target, fallback] = write as Extract<OrderedAttributeWrite, readonly unknown[]>;
    const value = candidate === NONCONFORMING ? index in state.values ? state.values[index] : fallback : candidate;
    if (candidate === NONCONFORMING && !(index in state.values) && fallback === undefined) continue;
    if (candidate !== NONCONFORMING) state.values[index] = candidate;
    if (target === "class") element.classList.toggle(name, Boolean(value));
    else if (target === "style") (element as HTMLElement).style.setProperty(name, value == null ? "" : String(value));
    else put(name, value);
  }
}
