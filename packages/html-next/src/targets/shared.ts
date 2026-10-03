import { parseFragment } from "parse5";

import type { ComponentDefinition, ElementNode, TemplateAttribute, TemplateNode } from "../template.js";
import type { PropContract, PropType } from "../types.js";
import { kebabCase } from "../names.js";
import { resolveDomProperty } from "../platform.js";
import { typeScriptType } from "../type-system.js";

/** Reflected native properties with an HTML representation during server rendering. */
export const SSR_BOOLEAN_PROPERTIES = new Set(["disabled", "hidden", "required", "readOnly", "multiple", "open", "controls"]);
export const SSR_STRING_PROPERTIES = new Set(["formAction", "title", "id", "name", "placeholder", "alt"]);

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
]);

export function isVoidElement(name: string): boolean {
  return VOID_ELEMENTS.has(name);
}

// Bound names are lowercased by the HTML parser. Recover SVG's adjusted attribute spelling.
const adjustedSvgAttributes = new Map<string, string>();
export function svgAttributeName(name: string): string {
  let adjusted = adjustedSvgAttributes.get(name);
  if (adjusted === undefined) {
    const fragment = parseFragment(`<svg ${name}></svg>`);
    const svg = fragment.childNodes[0] as { attrs?: readonly { name: string }[] } | undefined;
    adjusted = svg?.attrs?.[0]?.name ?? name;
    adjustedSvgAttributes.set(name, adjusted);
  }
  return adjusted;
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

export function isNativeBooleanAttribute(name: string): boolean {
  return NATIVE_BOOLEAN_ATTRIBUTES.has(name);
}

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
  if (typeof type === "string") return false;
  if (type.kind === "terminal") return type.name === "null";
  return type.kind === "union" && type.members.some(includesNull);
}

/** Optional component inputs accept an explicit null unless their declared type already does. */
export function propTypeSource(prop: PropContract): string {
  const source = prop.values === undefined ? typeSource(prop.type)
    : prop.values.map((value) => JSON.stringify(value)).join(" | ");
  return prop.required || includesNull(prop.type) ? source : `${source} | null`;
}

/** One generic parameter per selecting prop keeps generated call-site types correlated. */
export function selectorGenerics(props: Readonly<Record<string, PropContract>>): readonly {
  readonly from: string;
  readonly parameter: string;
  readonly declaration: string;
}[] {
  const selectors = [...new Set(Object.values(props).flatMap((prop) =>
    prop.select === undefined || props[prop.select.from] === undefined ? [] : [prop.select.from]))];
  return selectors.map((from, index) => {
    const prop = props[from]!;
    const parameter = `T${index}`;
    const bound = propTypeSource(prop);
    const fallback = "default" in prop ? JSON.stringify(prop.default) : bound;
    return { from, parameter, declaration: `${parameter} extends ${bound} = ${fallback}` };
  });
}

export function dependentPropTypeSource(
  prop: PropContract,
  parameters: ReadonlyMap<string, string>,
): string {
  if (prop.select === undefined) return propTypeSource(prop);
  const parameter = parameters.get(prop.select.from);
  if (parameter === undefined) return propTypeSource(prop);
  const cases = prop.select.options.map((option) => ({
    value: JSON.stringify(option.value),
    type: `${typeScriptType(option.type)}${prop.required ? "" : " | null"}`,
  }));
  return cases.reduceRight((otherwise, item) =>
    `${parameter} extends ${item.value} ? ${item.type} : ${otherwise}`,
  prop.required ? "never" : "null");
}

export function generatedPropDescriptor(
  name: string,
  prop: PropContract,
  value: string,
  root?: ElementNode,
): string | undefined {
  const type = prop.values !== undefined && prop.values.every((member) => typeof member === "string")
    ? JSON.stringify(prop.values)
    : prop.type === "string" || prop.type === "boolean" || prop.type === "number"
      ? quote(prop.type) : undefined;
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
      ...(prop.values === undefined ? {} : { values: prop.values }),
      ...(prop.select === undefined ? {} : { select: prop.select }),
      ...(prop.pattern === undefined ? {} : { pattern: prop.pattern }),
      ...(prop.min === undefined ? {} : { min: prop.min }),
      ...(prop.max === undefined ? {} : { max: prop.max }),
      ...(prop.minLength === undefined ? {} : { minLength: prop.minLength }),
      ...(prop.maxLength === undefined ? {} : { maxLength: prop.maxLength }),
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
