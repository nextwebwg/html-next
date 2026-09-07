import type { TemplateAttribute } from "../template.js";
import type { PropContract, PropType } from "../types.js";
import { resolveDomProperty } from "../platform.js";

const NATIVE_BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

export function typeSource(type: PropType): string {
  return typeof type === "object" ? type.enum.map(quote).join(" | ") : type;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");
}

export function literalAttribute(value: string): string {
  return `"${escapeHtml(value)}"`;
}

function isBooleanAttributeBinding(
  attribute: TemplateAttribute,
  props: Readonly<Record<string, PropContract>>,
): boolean {
  return attribute.kind === "attribute" && props[attribute.expression]?.type === "boolean";
}

export function frameworkBindingExpression(
  attribute: TemplateAttribute,
  props: Readonly<Record<string, PropContract>>,
  nativeElement: string,
  value: string,
  emptyStringLiteral: string,
): string {
  if (!isBooleanAttributeBinding(attribute, props)) return value;
  if (
    NATIVE_BOOLEAN_ATTRIBUTES.has(attribute.name) &&
    resolveDomProperty(nativeElement, attribute.name) !== undefined
  ) {
    return value;
  }
  return `${value} ? ${emptyStringLiteral} : undefined`;
}
