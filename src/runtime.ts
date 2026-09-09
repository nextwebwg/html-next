import { coerceDefault, defineContract, parseTypeAttribute } from "./contract.js";
import { fail } from "./diagnostics.js";
import {
  UndeclaredName,
  checkExpression,
  evaluate,
  toAttribute,
  toText,
  truthy,
  type Scope,
  type Value,
} from "./expression.js";
import { isReservedElement, validateLiteralAttributeName } from "./language.js";
import type {
  ComponentDefinition,
  DirectiveAttribute,
  ElementNode,
  Flow,
  TemplateAttribute,
  TemplateNode,
} from "./template.js";
import type { ComponentContract, PropContract, PropValue } from "./types.js";

interface LiveDefinition {
  readonly wrapper: Element;
  readonly style: HTMLStyleElement | undefined;
  readonly definition: ComponentDefinition;
}

interface PreparedInvocation {
  readonly invocation: Element;
  readonly nativeRoot: Element;
  readonly slotContainers: readonly Element[];
  readonly children: readonly Node[];
}

function significant(nodes: ArrayLike<Node>): Node[] {
  return Array.from(nodes).filter((node) => {
    if (node.nodeType === Node.COMMENT_NODE) return false;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() !== "";
    return true;
  });
}

function directElements(wrapper: Element, name: string): Element[] {
  return Array.from(wrapper.children).filter((element) => element.localName === name);
}

/**
 * Content and raw-HTML sinks are never reachable by a binding; markup is set with the
 * `$value`/`$html` directives (or the trusted-HTML type), never a string assigned to a
 * property. A `:name` binding that names one of these is a conformance error.
 */
const RAW_SINKS = new Set(["innerhtml", "outerhtml", "textcontent", "innertext", "srcdoc"]);

/** Structural `$`-directive attribute names (extracted as flow, not passed to parseAttributes). */
const FLOW_NAMES = new Set([
  "$if", "$each", "$where", "$sort", "$limit", "$key", "$with", "$match", "$when", "$else",
]);

const EACH_RE = /^\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\bof\b\s*(.+)$/;
const AS_RE = /^\s*(.+?)\s+\bas\b\s+([A-Za-z_$][\w$]*)\s*$/;

function checkExpr(src: string, source: string): void {
  try {
    checkExpression(src);
  } catch {
    fail("HT013", `Malformed expression \`${src}\`.`, source);
  }
}

/** Read the one structural directive on an element (with `$each`'s modifiers), if any. */
function extractFlow(element: Element, source: string): Flow | undefined {
  const has = (name: string): boolean => element.hasAttribute(name);
  const val = (name: string): string => element.getAttribute(name) ?? "";
  const structural = ["$if", "$each", "$with", "$match", "$when", "$else"].filter(has);
  if (structural.length > 1) {
    fail("HT014", `An element carries one structural directive; found ${structural.join(", ")}.`, source);
  }

  if (has("$if")) {
    checkExpr(val("$if"), source);
    return { kind: "if", test: val("$if") };
  }
  if (has("$with")) {
    const match = AS_RE.exec(val("$with"));
    if (match === null) fail("HT015", "`$with` must be written `expr as name`.", source);
    checkExpr(match![1]!, source);
    return { kind: "with", expr: match![1]!, alias: match![2]! };
  }
  if (has("$each")) {
    const match = EACH_RE.exec(val("$each"));
    if (match === null) {
      fail("HT016", "`$each` must be written `item of items` (optionally `item, i of items`).", source);
    }
    checkExpr(match![3]!, source);
    const flow: {
      kind: "each";
      item: string;
      index?: string;
      list: string;
      where?: string;
      sort?: string;
      limit?: string;
      key?: string;
    } = { kind: "each", item: match![1]!, list: match![3]! };
    if (match![2] !== undefined) flow.index = match![2];
    if (has("$where")) { checkExpr(val("$where"), source); flow.where = val("$where"); }
    if (has("$sort")) flow.sort = val("$sort"); // a comma-list of keys, not an expression
    if (has("$limit")) { checkExpr(val("$limit"), source); flow.limit = val("$limit"); }
    if (has("$key")) { checkExpr(val("$key"), source); flow.key = val("$key"); }
    return flow;
  }
  if (has("$match")) {
    const raw = val("$match").trim();
    if (raw === "") return { kind: "match" };
    const match = AS_RE.exec(raw);
    if (match === null) fail("HT017", "`$match` scope must be written `expr as name`.", source);
    checkExpr(match![1]!, source);
    return { kind: "match", expr: match![1]!, alias: match![2]! };
  }
  if (has("$when")) {
    checkExpr(val("$when"), source);
    return { kind: "when", test: val("$when") };
  }
  if (has("$else")) return { kind: "else" };
  return undefined;
}

function readProps(group: Element | undefined, source: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (group === undefined) return props;
  for (const element of directElements(group, "prop")) {
    const name = element.getAttribute("name");
    if (name === null || name === "") {
      fail("HC010", "A <prop> requires a `name` attribute.", source);
    }
    const typeAttribute = element.getAttribute("type");
    if (typeAttribute === null || typeAttribute === "") {
      fail("HC013", `Prop \`${name}\` requires a \`type\` attribute.`, source);
    }
    const type = parseTypeAttribute(typeAttribute);
    // The target is a nominal attribute of the same name, kept for contract shape; the
    // in-browser render resolves bindings as expressions over scope, not by target.
    const spec: Record<string, unknown> = {
      type,
      target: { attribute: name.toLowerCase() },
      description: (element.textContent ?? "").trim(),
    };
    if (element.hasAttribute("required")) spec.required = true;
    const defaultValue = element.getAttribute("default");
    if (defaultValue !== null) spec.default = coerceDefault(type, defaultValue);
    props[name] = spec;
  }
  return props;
}

function parseAttributes(element: Element, source: string): TemplateAttribute[] {
  return Array.from(element.attributes)
    .filter((attribute) => !FLOW_NAMES.has(attribute.name.toLowerCase()))
    .map((attribute) => {
      if (attribute.name.startsWith("bind:")) {
        fail("HT005", "Two-way bindings are reserved but not supported by the component MVP.", source);
      }

      if (attribute.name.startsWith(".")) {
        fail(
          "HT011",
          `The \`.property\` binding syntax has been removed; bind with \`:${attribute.name.slice(1)}\`, or set content with \`$value\`/\`$html\`.`,
          source,
        );
      }

      if (attribute.name.startsWith("$")) {
        const directive = attribute.name.slice(1).toLowerCase();
        if (directive !== "value" && directive !== "html") {
          fail("HT012", `\`$${directive}\` is not a known directive.`, source);
        }
        checkExpr(attribute.value, source);
        return { kind: "directive", name: directive, expression: attribute.value };
      }

      if (attribute.name.startsWith(":")) {
        const name = attribute.name.slice(1).toLowerCase();
        if (RAW_SINKS.has(name)) {
          fail("HT007", `\`:${name}\` cannot bind a raw content sink; use \`$value\`/\`$html\` or the trusted-HTML type.`, source);
        }
        checkExpr(attribute.value, source);
        return { kind: "attribute", name, expression: attribute.value };
      }

      validateLiteralAttributeName(attribute.name, source);
      return { kind: "literal", name: attribute.name, value: attribute.value };
    });
}

function parseElement(
  element: Element,
  contract: ComponentContract,
  source: string,
  slotCount: { value: number },
): ElementNode {
  if (isReservedElement(element.localName)) {
    fail("HT009", `<${element.localName}> is reserved but not supported by the component MVP.`, source);
  }

  const attributes = parseAttributes(element, source);
  const flow = extractFlow(element, source);
  const children: TemplateNode[] = [];
  // A nested <template>'s children live in its inert content fragment, not childNodes.
  const childNodes =
    element.localName === "template"
      ? Array.from((element as HTMLTemplateElement).content.childNodes)
      : Array.from(element.childNodes);
  for (const child of childNodes) {
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim() !== "") {
        children.push({ kind: "text", value: child.textContent ?? "" });
      }
      continue;
    }
    if (!(child instanceof Element)) continue;
    if (child.localName === "slot") {
      slotCount.value += 1;
      if (
        slotCount.value > 1 ||
        child.attributes.length > 0 ||
        significant(child.childNodes).length > 0
      ) {
        fail("HT008", "The MVP supports exactly one empty default slot.", source);
      }
      children.push({ kind: "slot" });
      continue;
    }
    children.push(parseElement(child, contract, source, slotCount));
  }

  const contentDirective = attributes.find((binding) => binding.kind === "directive");
  if (contentDirective !== undefined && children.length > 0) {
    fail(
      "HT006",
      `\`$${(contentDirective as { name: string }).name}\` sets the whole content; it cannot coexist with children.`,
      source,
    );
  }

  // A $match container's direct element children must all be $when/$else arms, at most one
  // $else, and $else last.
  if (flow?.kind === "match") {
    const arms = children.filter((node): node is ElementNode => node.kind === "element");
    let elseSeen = false;
    arms.forEach((arm, index) => {
      if (arm.flow?.kind === "when") {
        if (elseSeen) fail("HT018", "A `$when` arm may not follow `$else`.", source);
      } else if (arm.flow?.kind === "else") {
        if (elseSeen) fail("HT018", "A `$match` has at most one `$else`.", source);
        elseSeen = true;
        if (index !== arms.length - 1) fail("HT018", "`$else` must be the last arm.", source);
      } else {
        fail("HT018", "Every direct child of a `$match` must be a `$when` or `$else` arm.", source);
      }
    });
  }

  return flow === undefined
    ? { kind: "element", name: element.localName, attributes, children }
    : { kind: "element", name: element.localName, attributes, children, flow };
}

function parseDefinition(wrapper: HTMLTemplateElement, index: number): LiveDefinition {
  const tag = wrapper.getAttribute("component") ?? "";
  const source = `${wrapper.ownerDocument.URL}#template[component="${tag}"][${index + 1}]`;

  // A <template>'s children live in its inert content fragment.
  const content = Array.from(wrapper.content.childNodes);
  const contentElement = (name: string): Element[] =>
    content.filter(
      (node): node is Element => node instanceof Element && node.localName === name,
    );
  const defsRegions = contentElement("defs");
  const styles = contentElement("style");
  if (defsRegions.length > 1 || styles.length > 1) {
    fail("HS002", "A component has an optional <defs> region, one markup root, and an optional <style>.", source);
  }

  const known = new Set<Element>([...defsRegions, ...styles]);
  const markup = significant(content).filter(
    (node) => !(node instanceof Element) || !known.has(node),
  );
  if (markup.length !== 1 || !(markup[0] instanceof Element)) {
    fail("HT001", "A component's markup must be exactly one element root.", source);
  }
  const root = markup[0] as Element;

  const contract = defineContract(
    {
      status: wrapper.getAttribute("status") ?? undefined,
      summary: wrapper.getAttribute("summary") ?? undefined,
      nativeElement: root.localName,
      props: readProps(defsRegions[0], source),
    },
    { source, tag },
  );

  const normalizedTemplate = parseElement(root, contract, source, { value: 0 });
  const style = styles[0] as HTMLStyleElement | undefined;

  return {
    wrapper,
    style,
    definition: Object.freeze({
      source: Object.freeze({ file: source }),
      contract,
      template: normalizedTemplate,
      css: style?.textContent?.trim() ?? "",
    }),
  };
}

function invocationValue(prop: PropContract, attributeValue: string): PropValue {
  if (prop.type === "boolean") return true;
  if (prop.type === "number") {
    if (attributeValue.trim() === "") {
      fail("HR002", "A number prop invocation value must not be empty.");
    }
    const value = Number(attributeValue);
    if (!Number.isFinite(value)) {
      fail("HR002", `\`${attributeValue}\` is not a finite number prop value.`);
    }
    return value;
  }
  return attributeValue;
}

function readInvocation(
  invocation: Element,
  contract: ComponentContract,
): {
  readonly scope: Scope;
  readonly passThrough: readonly Attr[];
} {
  const names = new Map<string, string>();
  for (const name of Object.keys(contract.props)) names.set(name.toLowerCase(), name);

  const values: Record<string, PropValue | undefined> = {};
  const passThrough: Attr[] = [];
  for (const attribute of Array.from(invocation.attributes)) {
    const propName = names.get(attribute.name.toLowerCase());
    if (propName === undefined) {
      passThrough.push(attribute);
      continue;
    }
    values[propName] = invocationValue(contract.props[propName]!, attribute.value);
  }

  const scope = new Map<string, Value>();
  for (const [name, prop] of Object.entries(contract.props)) {
    if (prop.required && values[name] === undefined) {
      fail("HC020", `Required prop \`${name}\` was not provided.`);
    }
    // The effective value seen by expressions: the passed value, else the default, else null.
    scope.set(name, values[name] !== undefined ? values[name]! : prop.default ?? null);
  }
  return { scope, passThrough };
}

/** A child scope layer whose locals shadow the parent (for $each/$with/$match aliases). */
function layer(parent: Scope, locals: Record<string, Value>): Scope {
  return new Map<string, Value>([...parent, ...Object.entries(locals)]);
}

function evalValue(expression: string, scope: Scope): Value {
  try {
    return evaluate(expression, scope);
  } catch (error) {
    if (error instanceof UndeclaredName) fail("HB001", error.message);
    throw error;
  }
}

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href"]);

/**
 * `$html` sanitizes an ordinary string, dropping `<script>`, inline `on*` handlers, and
 * `javascript:` URLs. This is a conservative placeholder for the HTML Sanitizer API
 * (`Element.setHTML`), which the reference library will lazy-load where the browser lacks it.
 * ponytail: minimal sanitizer; swap for the Sanitizer API polyfill when it lands.
 */
function sanitizedFragment(html: string, document: Document): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    if (element.localName === "script") {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if (URL_ATTRIBUTES.has(name) && /^\s*javascript:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.content;
}

function setAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Set an element's whole content from a `$value` (escaped text) or `$html` (sanitized) directive. */
function applyContent(
  element: Element,
  directive: DirectiveAttribute,
  scope: Scope,
  document: Document,
): void {
  const value = evalValue(directive.expression, scope);
  if (directive.name === "value") element.textContent = toText(value);
  else element.replaceChildren(sanitizedFragment(toText(value), document));
}

/** A `<template $value>`/`<template $html>` produces inline nodes with no wrapper element. */
function inlineDirective(directive: DirectiveAttribute, scope: Scope, document: Document): Node {
  const value = evalValue(directive.expression, scope);
  if (directive.name === "value") return document.createTextNode(toText(value));
  return sanitizedFragment(toText(value), document);
}

function compareValues(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return toText(a).localeCompare(toText(b));
}

/** Apply the `$each` modifiers: `$where` filter, `$sort` (comma keys, `-` = descending), `$limit`. */
function shapeList(
  items: readonly Value[],
  flow: Extract<Flow, { kind: "each" }>,
  scope: Scope,
): Value[] {
  let result = items.slice();
  if (flow.where !== undefined) {
    const where = flow.where;
    result = result.filter((item) => truthy(evalValue(where, layer(scope, { [flow.item]: item }))));
  }
  if (flow.sort !== undefined) {
    const keys = flow.sort.split(",").map((raw) => raw.trim()).filter((key) => key !== "");
    result.sort((a, b) => {
      for (const key of keys) {
        const descending = key.startsWith("-");
        const path = descending ? key.slice(1) : key;
        const order = compareValues(
          evalValue(path, layer(scope, { [flow.item]: a })),
          evalValue(path, layer(scope, { [flow.item]: b })),
        );
        if (order !== 0) return descending ? -order : order;
      }
      return 0;
    });
  }
  if (flow.limit !== undefined) {
    const limit = evalValue(flow.limit, scope);
    if (typeof limit === "number") result = result.slice(0, Math.max(0, Math.trunc(limit)));
  }
  return result;
}

/** The scopes in which a node's body should render, per its structural directive. */
function expandFlow(flow: Flow | undefined, scope: Scope): Scope[] {
  if (flow === undefined) return [scope];
  switch (flow.kind) {
    case "if":
      return truthy(evalValue(flow.test, scope)) ? [scope] : [];
    case "with":
      return [layer(scope, { [flow.alias]: evalValue(flow.expr, scope) })];
    case "each": {
      const list = evalValue(flow.list, scope);
      if (!Array.isArray(list)) return [];
      const items = shapeList(list, flow, scope);
      return items.map((item, index) => {
        const locals: Record<string, Value> = {
          [flow.item]: item,
          loop: { index, first: index === 0, last: index === items.length - 1, count: items.length },
        };
        if (flow.index !== undefined) locals[flow.index] = index;
        return layer(scope, locals);
      });
    }
    default:
      // A stray when/else (no enclosing $match) renders once, its marker ignored.
      return [scope];
  }
}

function renderNode(
  node: ElementNode,
  scope: Scope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  passThrough: readonly Attr[] = [],
): Node[] {
  if (node.flow?.kind === "match") {
    return renderMatch(node, scope, slotChildren, document, slotContainers);
  }
  const out: Node[] = [];
  for (const childScope of expandFlow(node.flow, scope)) {
    out.push(...renderInstance(node, childScope, slotChildren, document, slotContainers, passThrough));
  }
  return out;
}

function renderMatch(
  node: ElementNode,
  scope: Scope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
): Node[] {
  const flow = node.flow as Extract<Flow, { kind: "match" }>;
  const matchScope =
    flow.expr !== undefined ? layer(scope, { [flow.alias!]: evalValue(flow.expr, scope) }) : scope;

  let chosen: ElementNode | undefined;
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    if (child.flow?.kind === "when" && truthy(evalValue(child.flow.test, matchScope))) {
      chosen = child;
      break;
    }
    if (child.flow?.kind === "else") {
      chosen = child;
      break;
    }
  }
  if (chosen === undefined) return [];

  // Render the winning arm, ignoring its own $when/$else marker.
  const { flow: _armFlow, ...armNode } = chosen;
  const rendered = renderInstance(armNode, matchScope, slotChildren, document, slotContainers);
  if (node.name === "template") return rendered;

  // $match on a real element wraps the winning arm in that element.
  const wrapper = document.createElement(node.name);
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") wrapper.setAttribute(attribute.name, attribute.value);
  }
  wrapper.append(...rendered);
  return [wrapper];
}

/** Render one instance of a node (its structural flow already resolved) into 0+ nodes. */
function renderInstance(
  node: ElementNode,
  scope: Scope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  passThrough: readonly Attr[] = [],
): Node[] {
  const contentDirective = node.attributes.find(
    (attribute): attribute is DirectiveAttribute => attribute.kind === "directive",
  );

  // A <template> is a fragment carrier: it contributes no wrapper element to the output.
  if (node.name === "template") {
    if (contentDirective !== undefined) return [inlineDirective(contentDirective, scope, document)];
    return renderChildren(node.children, scope, slotChildren, document, slotContainers);
  }

  const element = document.createElement(node.name);
  for (const attribute of passThrough) element.setAttribute(attribute.name, attribute.value);
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") element.setAttribute(attribute.name, attribute.value);
    else if (attribute.kind === "attribute") {
      setAttribute(element, attribute.name, toAttribute(evalValue(attribute.expression, scope)));
    }
    // Content directives are handled below; property bindings are not produced in-browser.
  }

  if (contentDirective !== undefined) {
    applyContent(element, contentDirective, scope, document);
    return [element];
  }

  for (const child of node.children) {
    if (child.kind === "text") {
      element.append(document.createTextNode(child.value));
    } else if (child.kind === "slot") {
      slotContainers.push(element);
      element.append(...slotChildren);
    } else {
      for (const rendered of renderNode(child, scope, slotChildren, document, slotContainers)) {
        element.append(rendered);
      }
    }
  }
  return [element];
}

function renderChildren(
  children: readonly TemplateNode[],
  scope: Scope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
): Node[] {
  const out: Node[] = [];
  for (const child of children) {
    if (child.kind === "text") out.push(document.createTextNode(child.value));
    else if (child.kind !== "slot") {
      out.push(...renderNode(child, scope, slotChildren, document, slotContainers));
    }
  }
  return out;
}

/**
 * Performs one explicit lowering pass over the document's current HTML Next definitions
 * and invocations. It does not observe later mutations or register Custom Elements.
 */
export function lowerDocument(root: Document = document): number {
  const wrappers = Array.from(
    root.querySelectorAll("template[component]"),
  ) as HTMLTemplateElement[];
  const definitions = wrappers.map(parseDefinition);
  const tags = new Set<string>();
  for (const { definition } of definitions) {
    if (tags.has(definition.contract.tag)) {
      fail("HR001", `More than one definition declares <${definition.contract.tag}>.`);
    }
    tags.add(definition.contract.tag);
  }

  const prepared: PreparedInvocation[] = [];
  for (const { definition } of definitions) {
    // A <template>'s content is inert, so querySelectorAll never returns definition-internal
    // markup; every match is a live invocation to lower.
    const invocations = Array.from(root.querySelectorAll(definition.contract.tag));
    for (const invocation of invocations) {
      const { scope, passThrough } = readInvocation(invocation, definition.contract);
      const children = Array.from(invocation.childNodes);
      const slotContainers: Element[] = [];
      const rendered = renderNode(
        definition.template,
        scope,
        children.map((child) => child.cloneNode(true)),
        invocation.ownerDocument,
        slotContainers,
        passThrough,
      );
      const nativeRoot = rendered[0] as Element;
      prepared.push({ invocation, nativeRoot, slotContainers, children });
    }
  }

  for (const live of definitions) {
    if (live.style !== undefined) live.wrapper.ownerDocument.head.append(live.style);
    live.wrapper.remove();
  }

  for (const invocation of prepared) {
    for (const slotContainer of invocation.slotContainers) {
      slotContainer.replaceChildren(...invocation.children);
    }
    invocation.invocation.replaceWith(invocation.nativeRoot);
  }
  return prepared.length;
}
