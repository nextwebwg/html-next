import type { ComponentDefinition, TemplateAttribute, TemplateNode } from "../template.js";
import type { PropContract, PropType } from "../types.js";
import { kebabCase } from "../names.js";
import { resolveDomProperty } from "../platform.js";
import { typeScriptType } from "../type-system.js";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
]);

export function isVoidElement(name: string): boolean {
  return VOID_ELEMENTS.has(name);
}

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
  return typeScriptType(type);
}

export function generatedPropDescriptor(
  name: string,
  prop: PropContract,
  value: string,
): string | undefined {
  const type = prop.type === "string" || prop.type === "boolean" || prop.type === "number"
    ? quote(prop.type)
    : "enum" in prop.type ? JSON.stringify(prop.type.enum) : undefined;
  if (type === undefined) return undefined;
  return `{ name: ${quote(name)}, attribute: ${quote(`data-${kebabCase(name)}`)}, value: ${value}, type: ${type}, required: ${String(prop.required)} }`;
}

export function hasUnsupportedPropertyBindings(node: TemplateNode): boolean {
  if (node.kind === "text") return false;
  if (node.kind === "slot") {
    return node.fallback?.some(hasUnsupportedPropertyBindings) ?? false;
  }
  return node.attributes.some((attribute) =>
    attribute.kind === "property" && resolveDomProperty(node.name, attribute.name) === undefined
  ) || node.children.some(hasUnsupportedPropertyBindings);
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

export function provenanceAttributes(tag: string, root = false): readonly string[] {
  return [
    `data-component=${literalAttribute(tag)}`,
    ...(root ? [`data-component-root=${literalAttribute(tag)}`] : []),
  ];
}

export function serializedDefinition(definition: ComponentDefinition): string {
  const props = Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) => [
    name,
    {
      type: prop.type,
      required: prop.required,
      ...("default" in prop ? { default: prop.default } : {}),
    },
  ]));
  const runtime = {
    contract: { tag: definition.contract.tag, props },
    template: definition.template,
    ...(definition.declarations === undefined ? {} : { declarations: definition.declarations }),
    ...(definition.root === undefined ? {} : { root: definition.root }),
  };
  return `{...${JSON.stringify(runtime)},source:{file:import.meta.url},css:""}`;
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
