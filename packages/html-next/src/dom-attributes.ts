import { hasExecutableUrl } from "./sanitize.js";
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
