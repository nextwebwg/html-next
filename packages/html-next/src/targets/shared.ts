import { parseFragment } from "parse5";

import type { ComponentDefinition, ElementNode, TemplateAttribute, TemplateNode } from "../template.js";
import type { PropContract, PropType, PropValue } from "../types.js";
import { isPreformattedElement } from "../language.js";
import { kebabCase } from "../names.js";
import { resolveDomProperty } from "../platform.js";
import { formatType, normalizeType, typeScriptType } from "../type-system.js";

/** Reflected native properties with an HTML representation during server rendering. */
export const SSR_BOOLEAN_PROPERTIES = new Set(["disabled", "hidden", "required", "readOnly", "multiple", "open", "controls"]);
export const SSR_STRING_PROPERTIES = new Set(["formAction", "title", "id", "name", "placeholder", "alt"]);

/** Attributes React types as numbers alone; Vue and Svelte accept a number or text for them. */
export const NUMERIC_ATTRIBUTES = new Set(["tabindex", "colspan", "rowspan", "maxlength", "minlength", "size", "rows", "cols", "span", "start",
  "high", "low", "optimum", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-level", "aria-posinset", "aria-setsize",
  "aria-colcount", "aria-colindex", "aria-colspan", "aria-rowcount", "aria-rowindex", "aria-rowspan"]);

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

/**
 * The props a declared slot gives its consumer's template, as a TypeScript object type: a required
 * prop, or one with a default, is always present; any other may be absent.
 */
export function slotPropsType(declared: Readonly<Record<string, PropContract>>): string {
  return `{ ${Object.entries(declared).map(([name, prop]) => {
    const type = prop.values === undefined ? typeSource(prop.type) : prop.values.map((value) => JSON.stringify(value)).join(" | ");
    return `readonly ${propKey(name)}${prop.required || prop.default !== undefined ? "" : "?"}: ${type};`;
  }).join(" ")} }`;
}

/**
 * A bound slot prop's check as an arrow function's source: absent, null and an invalid result are not
 * given; a value its declared type does not accept, checked in full as a prop's input is
 * (`acceptsSlotProp`, the props module's shared parser), warns once (HR007) and is not given.
 */
export function slotPropCheckSource(definition: { readonly source: { readonly file: string }; readonly contract: { readonly tag: string } },
  slot: string | undefined, prop: string, type: PropType): string {
  const file = definition.source.file;
  const normalized = normalizeType(type);
  const name = slot === undefined ? "The default slot" : `Slot \`${slot}\``;
  const message = `${file}: HR007: ${name} prop \`${prop}\` does not satisfy its declared type \`${formatType(normalized)}\`.`;
  return `(value: any): boolean => value != null && typeof value !== "symbol" && warnUnless(acceptsSlotProp(value, ${JSON.stringify(normalized)}), ${quote(`${file}#${definition.contract.tag}:slot:${slot ?? ""}:${prop}`)}, ${quote(message)})`;
}

/**
 * What a bound slot prop gives its consumer, as a one-argument function's source, or undefined when it
 * gives its value as it is: a null value, and one its declared type rejects (which warns HR007), take the
 * declared default, or null without one. `keepSymbols` passes an invalid result through for the caller to retain.
 */
export function slotPropValueSource(definition: { readonly source: { readonly file: string }; readonly contract: { readonly tag: string } },
  slot: string | undefined, prop: { readonly name: string; readonly type?: PropType; readonly default?: PropValue }, keepSymbols = false): string | undefined {
  const fallback = prop.default === undefined ? "null" : JSON.stringify(prop.default);
  if (prop.type === undefined) return prop.default === undefined ? undefined : `(value: any): any => value == null ? ${fallback} : value`;
  return `(value: any): any => ${keepSymbols ? `typeof value === "symbol" || ` : ""}(${slotPropCheckSource(definition, slot, prop.name, prop.type)})(value) ? value : ${fallback}`;
}

/** The props module's full value check, imported under the name slot prop checks call it by. */
export const SLOT_PROP_IMPORT = "acceptsDeclaredEvent as acceptsSlotProp";

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

// Elements the UA stylesheet lays out as blocks: whitespace beside one starts or ends a line.
const BLOCK_ELEMENTS = new Set(["address", "article", "aside", "blockquote", "caption", "center", "col", "colgroup", "dd", "details",
  "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hgroup", "hr", "legend", "li", "listing", "main", "menu", "nav", "ol", "optgroup", "option", "p", "plaintext", "pre", "search", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "xmp"]);
const WHITESPACE_RE = /^[\t\n\f\r ]+$/;

function isWhitespace(node: TemplateNode): boolean {
  return node.kind === "text" && node.expressionPlan === undefined && node.segments === undefined && WHITESPACE_RE.test(node.value);
}

/**
 * The definition with whitespace-only text as a framework host renders it. The proposal lets a
 * converter condense whitespace that does not render (Templating, "What observable equivalence
 * covers"), so this drops what never renders under normal `white-space`: text at an element's edges,
 * text beside a block-level element, and text among a select's options; the parser already drops it
 * in table and SVG structure. Text between inline content stays, as one space each host keeps.
 * Preformatted text stays as written.
 */
export function condenseWhitespace(definition: ComponentDefinition): ComponentDefinition {
  const template = condenseNode(definition.template, "") as ElementNode;
  return template === definition.template ? definition : { ...definition, template };
}

function condenseNode(node: TemplateNode, parent: string): TemplateNode {
  if (node.kind === "text") return node;
  if (node.kind === "slot") {
    const fallback = node.fallback === undefined ? undefined : condenseChildren(node.fallback, parent, true);
    return fallback === node.fallback ? node : { ...node, fallback: fallback! };
  }
  if (isPreformattedElement(node.name)) return node;
  // A <template> carries its children into its parent's content.
  const children = condenseChildren(node.children, node.name === "template" ? parent : node.name, node.name === "template");
  return children === node.children ? node : { ...node, children };
}

function condenseChildren(nodes: readonly TemplateNode[], parent: string, inParent: boolean): readonly TemplateNode[] {
  let changed = false;
  const kept = nodes.flatMap((node, index): TemplateNode[] => {
    if (!isWhitespace(node)) {
      const next = condenseNode(node, parent);
      if (next !== node) changed = true;
      return [next];
    }
    changed = true;
    // Next to a block-level box or at an element's edge, whitespace starts or ends a line, where it
    // collapses away; a template's or fallback's edge is its parent's content, and a conditional or
    // repeated block may render nothing, so neither counts.
    const atLineEdge = [nodes[index - 1], nodes[index + 1]].some((neighbour) => neighbour === undefined ? !inParent
      : neighbour.kind === "element" && neighbour.flow === undefined && BLOCK_ELEMENTS.has(neighbour.name));
    // A select's options are its content; frameworks reject text between them.
    if (atLineEdge || parent === "select" || parent === "optgroup") return [];
    return [{ kind: "text", value: " " }];
  });
  return changed ? kept : nodes;
}

/** A space `condenseWhitespace` kept, the only whitespace-only text it leaves outside preformatted text. */
export function isKeptSpace(node: TemplateNode | undefined): boolean {
  return node?.kind === "text" && node.value === " " && node.expressionPlan === undefined && node.segments === undefined;
}

/** A kept space at the start or end of a `<template>`'s or slot fallback's content. */
export function isEdgeSpace(nodes: readonly TemplateNode[], index: number): boolean {
  return (index === 0 || index === nodes.length - 1) && isKeptSpace(nodes[index]);
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
  const props = runtimeProps(definition);
  const runtime = {
    contract: { tag: definition.contract.tag, props },
    template: definition.template,
    ...(definition.declarations === undefined ? {} : { declarations: definition.declarations }),
    ...(definition.root === undefined ? {} : { root: definition.root }),
    ...(definition.lifecycle === undefined ? {} : { lifecycle: definition.lifecycle }),
  };
  return `{...${JSON.stringify(runtime)},source:{file:import.meta.url},css:""}`;
}

/** The parts of each prop's contract that the runtime reads. */
export function runtimeProps(definition: ComponentDefinition): Record<string, unknown> {
  return Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) => [
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

/** CSS-derived names can include characters outside JavaScript's binding-identifier grammar. */
export function isScriptIdentifier(name: string): boolean {
  return /^[\p{ID_Start}_$][\p{ID_Continue}_$\u200C\u200D]*$/u.test(name)
    && !/^(?:await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|arguments|eval)$/.test(name);
}
