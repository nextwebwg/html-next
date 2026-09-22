import type { ComponentDefinition, ElementNode, TemplateAttribute, TemplateNode } from "../template.js";
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

function includesNull(type: PropType): boolean {
  if (typeof type === "string" || "enum" in type) return false;
  if (type.kind === "terminal") return type.name === "null";
  return type.kind === "union" && type.members.some(includesNull);
}

/** Optional component inputs accept an explicit null unless their declared type already does. */
export function propTypeSource(prop: PropContract): string {
  const source = typeSource(prop.type);
  return prop.required || includesNull(prop.type) ? source : `${source} | null`;
}

export function generatedPropDescriptor(
  name: string,
  prop: PropContract,
  value: string,
  root?: ElementNode,
): string | undefined {
  const type = prop.type === "string" || prop.type === "boolean" || prop.type === "number"
    ? quote(prop.type)
    : "enum" in prop.type ? JSON.stringify(prop.type.enum) : undefined;
  if (type === undefined) return undefined;
  const attribute = `data-${kebabCase(name)}`;
  const defaultValue = "default" in prop ? `, default: ${JSON.stringify(prop.default)}` : "";
  const bound = root?.attributes.some((binding) => binding.kind === "attribute" && binding.name === attribute)
    ? ", bound: true"
    : "";
  return `{ name: ${quote(name)}, attribute: ${quote(attribute)}, value: ${value}${defaultValue}${bound}, type: ${type}, required: ${String(prop.required)} }`;
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

export function serializedDefinition(definition: ComponentDefinition): string {
  const props = Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) => [
    name,
    {
      type: prop.type,
      required: prop.required,
      target: prop.target,
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
