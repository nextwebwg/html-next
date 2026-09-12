import { parseBrowserComponent } from "./browser-source.js";
import { fail } from "./diagnostics.js";
import {
  UndeclaredName,
  evaluate,
  toAttribute,
  toText,
  truthy,
  type Scope,
  type Value,
} from "./expression.js";
import { validateLiteralAttributeName } from "./language.js";
import { rewriteValiditySelectors } from "./validity-css.js";
import type {
  ComponentDefinition,
  DirectiveAttribute,
  ElementNode,
  Flow,
  TemplateNode,
} from "./template.js";
import type { ComponentContract, PropContract, PropValue } from "./types.js";

/**
 * A `<defs>` reactive declaration seeding the render scope. At L1 the runtime lowers once
 * (no live updates): `state`/`computed` seed their initial value, `data` seeds the pending
 * reactive-read shape. Live reactivity, and executing `<handler>` steps, are the L2 layer.
 */
interface Decl {
  readonly kind: "state" | "computed" | "data";
  readonly name: string;
  readonly expr?: string;
}

interface LiveDefinition {
  readonly wrapper: Element;
  readonly style: HTMLStyleElement | undefined;
  readonly definition: ComponentDefinition;
  readonly decls: readonly Decl[];
}

interface PreparedInvocation {
  readonly invocation: Element;
  readonly nativeRoot: Element;
  readonly slotContainers: readonly Element[];
  readonly children: readonly Node[];
  readonly definition: ComponentDefinition;
}

interface DocumentRegistry {
  readonly definitions: Map<string, LiveDefinition>;
  readonly instances: WeakMap<Element, ComponentDefinition>;
}

const registries = new WeakMap<Document, DocumentRegistry>();
const contentOnly = new WeakSet<Element>();

function registryFor(root: Document): DocumentRegistry {
  let registry = registries.get(root);
  if (registry === undefined) {
    registry = { definitions: new Map(), instances: new WeakMap() };
    registries.set(root, registry);
  }
  return registry;
}

/** Validate inert carrier content before moving any authored node into the document. */
function validateDefinitionContent(container: ParentNode, source: string): void {
  for (const element of Array.from(container.children)) {
    if (["script", "base", "meta", "object", "embed"].includes(element.localName)) {
      fail("HT009", `<${element.localName}> is not permitted in component definitions.`, source);
    }
    if (element.localName === "link") {
      fail("HL001", "External definition dependencies require the application-owned graph resolver.", source);
    }
    for (const attribute of Array.from(element.attributes)) {
      if (/^on(?!:)/i.test(attribute.name)) {
        validateLiteralAttributeName(attribute.name, source, attribute.value);
      }
    }
    validateDefinitionContent(
      element.localName === "template" ? (element as HTMLTemplateElement).content : element,
      source,
    );
  }
}

function parseDefinition(wrapper: HTMLTemplateElement, index: number): LiveDefinition {
  const tag = wrapper.getAttribute("component") ?? "";
  const source = `${wrapper.ownerDocument.URL}#template[component="${tag}"][${index + 1}]`;
  if (wrapper.hasAttribute("src")) {
    fail("HL001", "External definitions require the application-owned graph resolver.", source);
  }
  validateDefinitionContent(wrapper.content, source);
  const definition = parseBrowserComponent(wrapper, source);
  const style = Array.from(wrapper.content.children).find(
    (element): element is HTMLStyleElement => element.localName === "style",
  );
  const decls: Decl[] = (definition.declarations ?? []).flatMap((declaration) => {
    if (declaration.kind !== "state" && declaration.kind !== "computed" && declaration.kind !== "data") {
      return [];
    }
    return [{
      kind: declaration.kind,
      name: declaration.name,
      ...(declaration.kind === "data" || declaration.expression === undefined
        ? {}
        : { expr: declaration.expression.source }),
    }];
  });

  return {
    wrapper,
    style,
    decls,
    definition,
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
  decls: readonly Decl[],
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

  // Seed reactive declarations in document order, each evaluated against the scope so far
  // (props, then earlier declarations). One-shot: `data` starts in its pending shape.
  for (const decl of decls) {
    if (decl.kind === "data") {
      scope.set(decl.name, { pending: true, value: null, error: null, ok: false });
    } else {
      scope.set(decl.name, decl.expr !== undefined ? evalValue(decl.expr, scope) : null);
    }
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
const BLOCKED_HTML_ELEMENTS = new Set(["base", "embed", "iframe", "link", "meta", "object", "script", "style", "template"]);
const BLOCKED_HTML_ATTRIBUTES = new Set(["srcdoc", "style"]);

function hasExecutableUrl(value: string): boolean {
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  return /^(?:data|javascript|vbscript):/i.test(normalized);
}

/**
 * `$html` sanitizes an ordinary string, dropping active embedding elements, inline `on*`
 * handlers, raw style/srcdoc sinks, and executable URLs. This is a conservative placeholder
 * for the HTML Sanitizer API
 * (`Element.setHTML`), which the reference library will lazy-load where the browser lacks it.
 * ponytail: minimal sanitizer; swap for the Sanitizer API polyfill when it lands.
 */
function sanitizedFragment(html: string, document: Document): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    contentOnly.add(element);
    if (BLOCKED_HTML_ELEMENTS.has(element.localName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || BLOCKED_HTML_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
      } else if (URL_ATTRIBUTES.has(name) && hasExecutableUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.content;
}

function setAttribute(element: Element, name: string, value: string | null): void {
  if (value === null || (URL_ATTRIBUTES.has(name.toLowerCase()) && hasExecutableUrl(value))) {
    element.removeAttribute(name);
  }
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
    // A `$sort` key is a bare field path on the item (unlike `$key`, which is an expression):
    // `price,-name` sorts by item.price ascending then item.name descending. A scalar-item
    // list sorts by the value itself; the key then only carries the ascending/descending sign.
    const sortValue = (item: Value, field: string): Value =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? evalValue(`${flow.item}.${field}`, layer(scope, { [flow.item]: item }))
        : item;
    result.sort((a, b) => {
      for (const key of keys) {
        const descending = key.startsWith("-");
        const field = descending ? key.slice(1).trim() : key;
        const order = compareValues(sortValue(a, field), sortValue(b, field));
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
      const value = evalValue(attribute.expression, scope);
      if (attribute.target === "class") {
        element.classList.toggle(attribute.name, truthy(value));
      } else if (attribute.target === "style") {
        (element as HTMLElement).style.setProperty(attribute.name, toText(value));
      } else {
        setAttribute(element, attribute.name, toAttribute(value));
      }
    } else if (attribute.kind === "property") {
      (element as unknown as Record<string, unknown>)[attribute.name] = evalValue(attribute.expression, scope);
    }
    // Content directives are handled below.
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
 * Performs one explicit lowering pass, retaining definitions in a document registry for
 * later passes. It does not observe mutations or register Custom Elements.
 */
export function lowerDocument(root: Document = document): number {
  const registry = registryFor(root);
  const wrappers = Array.from(
    root.querySelectorAll("template[component]"),
  ).filter((element) => !contentOnly.has(element)) as HTMLTemplateElement[];
  const definitions = wrappers.map(parseDefinition);
  const tags = new Set(registry.definitions.keys());
  for (const { definition } of definitions) {
    if (tags.has(definition.contract.tag)) {
      fail("HR001", `More than one definition declares <${definition.contract.tag}>.`);
    }
    tags.add(definition.contract.tag);
  }

  const prepared: PreparedInvocation[] = [];
  for (const { definition, decls } of [...registry.definitions.values(), ...definitions]) {
    if (root.defaultView?.customElements.get(definition.contract.tag) !== undefined) continue;
    // A <template>'s content is inert, so querySelectorAll never returns definition-internal
    // markup; every match is a live invocation to lower.
    const invocations = Array.from(root.querySelectorAll(definition.contract.tag));
    for (const invocation of invocations) {
      if (contentOnly.has(invocation)) continue;
      const { scope, passThrough } = readInvocation(invocation, definition.contract, decls);
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
      prepared.push({ invocation, nativeRoot, slotContainers, children, definition });
    }
  }

  for (const live of definitions) {
    registry.definitions.set(live.definition.contract.tag, live);
    if (live.style !== undefined) {
      live.style.textContent = rewriteValiditySelectors(live.style.textContent ?? "");
      live.wrapper.ownerDocument.head.append(live.style);
    }
    live.wrapper.remove();
  }

  for (const invocation of prepared) {
    for (const slotContainer of invocation.slotContainers) {
      slotContainer.replaceChildren(...invocation.children);
    }
    invocation.invocation.replaceWith(invocation.nativeRoot);
    registry.instances.set(invocation.nativeRoot, invocation.definition);
  }
  return prepared.length;
}

export interface DocumentObservationOptions {
  /** Runtime lifecycle integration; the returned disposer runs on removal or stop. */
  readonly onConnect?: (element: Element, definition: ComponentDefinition) => void | (() => void);
  readonly onError?: (error: unknown) => void;
}

const documentObservers = new WeakMap<Document, () => void>();

/**
 * Discover inline definitions and instances added after boot. This browser-only entrypoint
 * owns observation; explicit lowering and compiled/AOT targets do not install observers.
 * Controller loading and its host are provided by runtime lifecycle integration, not by
 * evaluating authored markup. Stop disconnects observation and disposes connected roots.
 */
export function observeDocument(
  root: Document = document,
  options: DocumentObservationOptions = {},
): () => void {
  if (documentObservers.has(root)) fail("HR003", "This document is already being observed.");
  const registry = registryFor(root);
  const connected = new Map<Element, void | (() => void)>();
  const report = options.onError ?? ((error: unknown) => console.error(error));
  let stopped = false;
  const synchronize = (): void => {
    if (stopped) return;
    for (const [element, dispose] of connected) {
      if (!root.contains(element)) {
        connected.delete(element);
        try { dispose?.(); } catch (error) { report(error); }
      }
    }
    try { lowerDocument(root); } catch (error) { report(error); }
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (stopped) break;
      const definition = registry.instances.get(element);
      if (definition === undefined || connected.has(element) || !root.contains(element)) continue;
      // Record first so callback mutations cannot connect an instance twice.
      connected.set(element, undefined);
      try {
        const dispose = options.onConnect?.(element, definition);
        if (stopped) dispose?.();
        else connected.set(element, dispose);
      }
      catch (error) { report(error); }
    }
  };
  const Observer = root.defaultView?.MutationObserver;
  if (Observer === undefined) fail("HR003", "Document observation requires a browser MutationObserver.");
  const observer = new Observer(synchronize);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    documentObservers.delete(root);
    for (const dispose of connected.values()) {
      try { dispose?.(); } catch (error) { report(error); }
    }
    connected.clear();
  };
  documentObservers.set(root, stop);
  observer.observe(root, { childList: true, subtree: true });
  synchronize();
  return stop;
}
