import { parseBrowserComponent } from "./browser-source.js";
import { DataResource } from "./data.js";
import { fail } from "./diagnostics.js";
import type { ComponentGraph } from "./graph.js";
import {
  UndeclaredName,
  evaluate,
  evaluateCompiled,
  toAttribute,
  toText,
  truthy,
  type Scope,
  type Value,
} from "./expression.js";
import { validateLiteralAttributeName } from "./language.js";
import { createEffect, ReactiveScope, type ReactiveEffect } from "./reactivity.js";
import { rewriteValiditySelectors } from "./validity-css.js";
import type {
  ComponentDefinition,
  DataDeclaration,
  DirectiveAttribute,
  ElementNode,
  Flow,
  HandlerDeclaration,
  HandlerStep,
  TemplateNode,
} from "./template.js";
import type { WritablePath } from "./expression.js";
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
  readonly wrapper?: Element;
  readonly style: HTMLStyleElement | undefined;
  readonly definition: ComponentDefinition;
  readonly decls: readonly Decl[];
}

function runtimeDeclarations(definition: ComponentDefinition): Decl[] {
  return (definition.declarations ?? []).flatMap((declaration) => {
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
}

interface PreparedInvocation {
  readonly invocation: Element;
  readonly nativeRoot: Element;
  readonly slotContainers: readonly Element[];
  readonly children: readonly Node[];
  readonly definition: ComponentDefinition;
  readonly instance: RuntimeInstance;
}

interface RuntimeInstance {
  element?: Element;
  readonly definition: ComponentDefinition;
  readonly scope: ReactiveScope;
  readonly refs: Record<string, Element>;
  readonly effects: ReactiveEffect[];
  readonly connectCallbacks: Set<() => void>;
  readonly disconnectCallbacks: Set<() => void>;
  connected: boolean;
}

interface DocumentRegistry {
  readonly definitions: Map<string, LiveDefinition>;
  readonly instances: WeakMap<Element, ComponentDefinition>;
}

const registries = new WeakMap<Document, DocumentRegistry>();
const contentOnly = new WeakSet<Element>();
const runtimeInstances = new WeakMap<Element, RuntimeInstance>();

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

  return {
    wrapper,
    style,
    decls: runtimeDeclarations(definition),
    definition,
  };
}

/** Installs an already validated external/package graph without reparsing or executing it. */
export function installComponentGraph(
  graph: ComponentGraph,
  root: Document = document,
): number {
  const registry = registryFor(root);
  let installed = 0;
  for (const node of graph.nodes.values()) {
    if (node.shadowedByCustomElement) continue;
    const tag = node.definition.contract.tag;
    if (registry.definitions.has(tag)) fail("HR001", `More than one definition declares <${tag}>.`);
    const style = node.definition.css === "" ? undefined : root.createElement("style");
    if (style !== undefined) {
      style.textContent = rewriteValiditySelectors(node.definition.css);
      style.dataset.htmlNextComponent = tag;
      root.head.append(style);
    }
    registry.definitions.set(tag, {
      definition: node.definition,
      decls: runtimeDeclarations(node.definition),
      style,
    });
    installed += 1;
  }
  return installed;
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
  definition: ComponentDefinition,
): {
  readonly scope: ReactiveScope;
  readonly passThrough: readonly Attr[];
  readonly effects: ReactiveEffect[];
} {
  const contract = definition.contract;
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

  const scope = new ReactiveScope();
  for (const [name, prop] of Object.entries(contract.props)) {
    if (prop.required && values[name] === undefined) {
      fail("HC020", `Required prop \`${name}\` was not provided.`);
    }
    // The effective value seen by expressions: the passed value, else the default, else null.
    scope.set(name, values[name] !== undefined ? values[name]! : prop.default ?? null);
  }

  const declarations = definition.declarations ?? [];
  for (const declaration of declarations) scope.set(declaration.name, null);
  for (const declaration of declarations) {
    if (declaration.kind === "data") {
      scope.set(declaration.name, { pending: true, value: null, error: null, ok: false });
    } else if (declaration.kind === "state") {
      scope.set(
        declaration.name,
        declaration.expression === undefined ? null : evalValue(declaration.expression.source, scope),
      );
    }
  }
  const effects: ReactiveEffect[] = [];
  for (const declaration of declarations) {
    if (declaration.kind !== "computed" || declaration.expression === undefined) continue;
    effects.push(createEffect(scope.scheduler, () => {
      scope.set(declaration.name, evalValue(declaration.expression!.source, scope));
    }, 0));
  }
  const definitionBase = (() => {
    try { return new URL(definition.source.file, invocation.ownerDocument.baseURI).href; }
    catch { return invocation.ownerDocument.baseURI; }
  })();
  for (const declaration of declarations) {
    if (declaration.kind !== "data" || declaration.source === undefined) continue;
    const data = declaration as DataDeclaration;
    const dataSource = declaration.source;
    const resource = new DataResource({
      source: dataSource,
      baseURL: definitionBase,
      ...(data.type === undefined ? {} : { type: data.type }),
      ...(data.debounce === undefined ? {} : { debounce: Number(data.debounce) }),
      ...(data.poll === undefined ? {} : { poll: Number(data.poll) }),
      onState: (state) => scope.set(data.name, state as unknown as Value),
    });
    effects.push(createEffect(scope.scheduler, () => {
      const parameters = Object.fromEntries(
        data.parameters.map((parameter) => [
          parameter.name,
          evaluateCompiled(parameter.expression, scope),
        ]),
      );
      resource.update(parameters);
      return () => resource.disconnect();
    }, 0));
  }
  return { scope, passThrough, effects };
}

/** A child scope layer whose locals shadow the parent (for $each/$with/$match aliases). */
function layer(parent: ReactiveScope, locals: Record<string, Value>): ReactiveScope;
function layer(parent: Scope, locals: Record<string, Value>): Scope {
  if (parent instanceof ReactiveScope) return parent.fork(Object.entries(locals));
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

interface RuntimeRenderContext {
  readonly definition: ComponentDefinition;
  readonly effects: ReactiveEffect[];
  readonly refs: Record<string, Element>;
}

function ownEffect(
  context: RuntimeRenderContext,
  scope: ReactiveScope,
  run: () => void | (() => void),
  priority = 1,
): void {
  context.effects.push(createEffect(scope.scheduler, run, priority));
}

function setWritablePath(scope: ReactiveScope, path: WritablePath, value: Value): void {
  const [root, ...segments] = path;
  if (typeof root !== "string") return;
  if (segments.length === 0) {
    scope.set(root, value);
    return;
  }
  let target = scope.get(root) as Record<PropertyKey, unknown> | undefined;
  for (const segment of segments.slice(0, -1)) {
    const key = typeof segment === "object" ? evaluateCompiled(segment.expression, scope) : segment;
    if ((typeof key !== "string" && typeof key !== "number") || target == null) return;
    target = target[key] as Record<PropertyKey, unknown> | undefined;
  }
  const last = segments.at(-1)!;
  const key = typeof last === "object" ? evaluateCompiled(last.expression, scope) : last;
  if ((typeof key === "string" || typeof key === "number") && target != null) target[key] = value;
}

function controlValue(element: Element): Value {
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") return element.checked;
    if (element.type === "number" || element.type === "range") {
      return Number.isNaN(element.valueAsNumber) ? null : element.valueAsNumber;
    }
    return element.value;
  }
  if (element instanceof HTMLSelectElement) {
    return element.multiple
      ? Array.from(element.selectedOptions, (option) => option.value)
      : element.value;
  }
  if (element instanceof HTMLTextAreaElement) return element.value;
  return (element as unknown as { value?: Value }).value ?? element.getAttribute("value");
}

function applyBoundControlValue(element: Element, name: string, value: Value): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName === "checked" && element instanceof HTMLInputElement) {
    element.checked = truthy(value);
    return true;
  }
  if (lowerName === "value" && element instanceof HTMLSelectElement && element.multiple) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    for (const option of Array.from(element.options)) option.selected = selected.has(option.value);
    return true;
  }
  if (
    lowerName === "value" &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement)
  ) {
    element.value = value == null ? "" : String(value);
    return true;
  }
  return false;
}

function runHandler(
  declaration: HandlerDeclaration,
  element: Element,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
): void {
  for (const step of declaration.steps) {
    if (step.guard !== undefined && !truthy(evaluateCompiled(step.guard, scope))) continue;
    if (step.kind === "set") {
      setWritablePath(scope, step.writablePath, evaluateCompiled(step.value, scope));
    } else if (step.kind === "dispatch") {
      element.dispatchEvent(new CustomEvent(step.event, {
        detail: step.value === undefined ? undefined : evaluateCompiled(step.value, scope),
        bubbles: true,
        composed: true,
      }));
    } else {
      const target = context.refs[step.target];
      if (step.kind === "focus") (target as HTMLElement | undefined)?.focus();
      else (target as HTMLInputElement | undefined)?.reportValidity?.();
    }
  }
}

function eventPasses(event: Event, element: Element, modifiers: readonly string[]): boolean {
  if (modifiers.includes("self") && event.target !== element) return false;
  if (event instanceof KeyboardEvent) {
    const keyFilters = modifiers.filter((modifier) =>
      ["enter", "escape", "space", "tab", "up", "down", "left", "right"].includes(modifier),
    );
    const keyNames: Record<string, string> = {
      enter: "Enter", escape: "Escape", space: " ", tab: "Tab",
      up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    };
    if (keyFilters.length > 0 && !keyFilters.some((filter) => event.key === keyNames[filter])) return false;
  }
  return true;
}

function bindEvents(
  element: Element,
  node: ElementNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
): void {
  const handlers = new Map(
    (context.definition.declarations ?? [])
      .filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler")
      .map((declaration) => [declaration.name, declaration]),
  );
  for (const binding of node.events ?? []) {
    const declaration = handlers.get(binding.handler)!;
    const listener = (event: Event): void => {
      if (!eventPasses(event, element, binding.modifiers)) return;
      if (binding.modifiers.includes("prevent")) event.preventDefault();
      if (binding.modifiers.includes("stop")) event.stopPropagation();
      runHandler(declaration, element, scope, context);
    };
    ownEffect(context, scope, () => {
      element.addEventListener(binding.name, listener, {
        capture: binding.modifiers.includes("capture"),
        passive: binding.modifiers.includes("passive"),
        once: binding.modifiers.includes("once"),
      });
      return () => element.removeEventListener(binding.name, listener, {
        capture: binding.modifiers.includes("capture"),
      });
    }, 2);
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
  scope: ReactiveScope,
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
function expandFlow(flow: Flow | undefined, scope: ReactiveScope): ReactiveScope[] {
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

function materialize(nodes: readonly Node[], document: Document): Node[] {
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  return Array.from(fragment.childNodes);
}

function clearRange(start: Comment, end: Comment): void {
  let current = start.nextSibling;
  while (current !== null && current !== end) {
    const next = current.nextSibling;
    current.remove();
    current = next;
  }
}

function renderDynamicNode(
  node: ElementNode,
  scope: ReactiveScope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
): Node[] {
  if (node.flow?.kind === "each") {
    return renderEachRegion(node, scope, slotChildren, document, slotContainers, passThrough, context);
  }
  const start = document.createComment("html-next:start");
  const end = document.createComment("html-next:end");
  const fragment = document.createDocumentFragment();
  fragment.append(start, end);
  let childEffects: ReactiveEffect[] = [];
  ownEffect(context, scope, () => {
    for (const effect of childEffects) effect.stop();
    childEffects = [];
    clearRange(start, end);
    const effectsStart = context.effects.length;
    let rendered: Node[] = [];
    if (node.flow?.kind === "if") {
      if (truthy(evalValue(node.flow.test, scope))) {
        const { flow: _flow, ...body } = node;
        rendered = renderInstance(body, scope, slotChildren, document, slotContainers, passThrough, context);
      }
    } else if (node.flow?.kind === "with") {
      const local = scope.fork([[node.flow.alias, evalValue(node.flow.expr, scope)]]);
      const { flow: _flow, ...body } = node;
      rendered = renderInstance(body, local, slotChildren, document, slotContainers, passThrough, context);
    } else if (node.flow?.kind === "match") {
      rendered = renderMatch(node, scope, slotChildren, document, slotContainers, context);
    }
    childEffects = context.effects.slice(effectsStart);
    end.before(...materialize(rendered, document));
  });
  return [fragment];
}

interface EachBlock {
  readonly start: Comment;
  readonly end: Comment;
  readonly scope: ReactiveScope;
  readonly effects: readonly ReactiveEffect[];
}

function moveBlockBefore(block: EachBlock, reference: Node): void {
  const nodes: Node[] = [];
  let current: Node | null = block.start;
  while (current !== null) {
    nodes.push(current);
    if (current === block.end) break;
    current = current.nextSibling;
  }
  const parent = reference.parentNode;
  if (parent === null) return;
  for (const node of nodes) parent.insertBefore(node, reference);
}

function removeBlock(block: EachBlock): void {
  for (const effect of block.effects) effect.stop();
  let current: Node | null = block.start;
  while (current !== null) {
    const next: Node | null = current.nextSibling;
    current.parentNode?.removeChild(current);
    if (current === block.end) break;
    current = next;
  }
}

function renderEachRegion(
  node: ElementNode,
  scope: ReactiveScope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
): Node[] {
  const flow = node.flow as Extract<Flow, { kind: "each" }>;
  const start = document.createComment("html-next:each-start");
  const end = document.createComment("html-next:each-end");
  const fragment = document.createDocumentFragment();
  fragment.append(start, end);
  let blocks = new Map<unknown, EachBlock>();
  ownEffect(context, scope, () => {
    const value = evalValue(flow.list, scope);
    const items = Array.isArray(value) ? shapeList(value, flow, scope) : [];
    const next = new Map<unknown, EachBlock>();
    const { flow: _flow, ...body } = node;
    items.forEach((item, index) => {
      const locals: Record<string, Value> = {
        [flow.item]: item,
        loop: { index, first: index === 0, last: index === items.length - 1, count: items.length },
      };
      if (flow.index !== undefined) locals[flow.index] = index;
      const probe = scope.fork(Object.entries(locals));
      const key = flow.key === undefined ? index : evalValue(flow.key, probe);
      if (next.has(key)) fail("HR004", `A keyed list produced duplicate key \`${toText(key as Value)}\`.`);
      let block = blocks.get(key);
      if (block === undefined) {
        const local = scope.fork(Object.entries(locals));
        const effectsStart = context.effects.length;
        const rendered = materialize(
          renderInstance(body, local, slotChildren, document, slotContainers, passThrough, context),
          document,
        );
        const blockStart = document.createComment("html-next:item-start");
        const blockEnd = document.createComment("html-next:item-end");
        end.before(blockStart, ...rendered, blockEnd);
        block = {
          start: blockStart,
          end: blockEnd,
          scope: local,
          effects: context.effects.slice(effectsStart),
        };
      } else {
        block.scope.set(flow.item, item);
        if (flow.index !== undefined) block.scope.set(flow.index, index);
        block.scope.set("loop", locals.loop!);
      }
      next.set(key, block);
      moveBlockBefore(block, end);
    });
    for (const [key, block] of blocks) if (!next.has(key)) removeBlock(block);
    blocks = next;
  });
  return [fragment];
}

function renderNode(
  node: ElementNode,
  scope: ReactiveScope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
): Node[] {
  if (
    node.flow?.kind === "if" ||
    node.flow?.kind === "each" ||
    node.flow?.kind === "with" ||
    node.flow?.kind === "match"
  ) {
    return renderDynamicNode(node, scope, slotChildren, document, slotContainers, passThrough, context);
  }
  const out: Node[] = [];
  for (const childScope of expandFlow(node.flow, scope)) {
    out.push(...renderInstance(node, childScope, slotChildren, document, slotContainers, passThrough, context));
  }
  return out;
}

function renderMatch(
  node: ElementNode,
  scope: ReactiveScope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  context: RuntimeRenderContext,
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
  const rendered = renderInstance(armNode, matchScope, slotChildren, document, slotContainers, [], context);
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
  scope: ReactiveScope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
): Node[] {
  const contentDirective = node.attributes.find(
    (attribute): attribute is DirectiveAttribute => attribute.kind === "directive",
  );

  // A <template> is a fragment carrier: it contributes no wrapper element to the output.
  if (node.name === "template") {
    if (contentDirective !== undefined) {
      const text = document.createTextNode("");
      ownEffect(context, scope, () => {
        const value = evalValue(contentDirective.expression, scope);
        if (contentDirective.name === "value") text.data = toText(value);
      });
      return contentDirective.name === "value"
        ? [text]
        : [inlineDirective(contentDirective, scope, document)];
    }
    return renderChildren(node.children, scope, slotChildren, document, slotContainers, context);
  }

  const element = document.createElement(node.name);
  if (node.ref !== undefined) context.refs[node.ref] = element;
  for (const attribute of passThrough) element.setAttribute(attribute.name, attribute.value);
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") element.setAttribute(attribute.name, attribute.value);
    else if (attribute.kind === "attribute") {
      ownEffect(context, scope, () => {
        const value = evalValue(attribute.expression, scope);
        if (attribute.target === "class") {
          element.classList.toggle(attribute.name, truthy(value));
        } else if (attribute.target === "style") {
          (element as HTMLElement).style.setProperty(attribute.name, toText(value));
        } else if (attribute.twoWay === true && applyBoundControlValue(element, attribute.name, value)) {
          // Native form-control properties carry the live value; no duplicate attribute write.
        } else {
          setAttribute(element, attribute.name, toAttribute(value));
        }
      });
      if (attribute.twoWay === true && attribute.writablePath !== undefined) {
        const eventName = element instanceof HTMLSelectElement ||
          (element instanceof HTMLInputElement && ["checkbox", "radio", "file"].includes(element.type))
          ? "change"
          : "input";
        const listener = (): void => {
          if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked) return;
          setWritablePath(scope, attribute.writablePath!, controlValue(element));
        };
        ownEffect(context, scope, () => {
          element.addEventListener(eventName, listener);
          return () => element.removeEventListener(eventName, listener);
        }, 2);
      }
    } else if (attribute.kind === "property") {
      ownEffect(context, scope, () => {
        (element as unknown as Record<string, unknown>)[attribute.name] = evalValue(attribute.expression, scope);
      });
    }
    // Content directives are handled below.
  }

  if (contentDirective !== undefined) {
    ownEffect(context, scope, () => applyContent(element, contentDirective, scope, document));
    bindEvents(element, node, scope, context);
    return [element];
  }

  for (const child of node.children) {
    if (child.kind === "text") {
      element.append(document.createTextNode(child.value));
    } else if (child.kind === "slot") {
      slotContainers.push(element);
      element.append(...slotChildren);
    } else {
      for (const rendered of renderNode(child, scope, slotChildren, document, slotContainers, [], context)) {
        element.append(rendered);
      }
    }
  }
  bindEvents(element, node, scope, context);
  return [element];
}

function renderChildren(
  children: readonly TemplateNode[],
  scope: ReactiveScope,
  slotChildren: readonly Node[],
  document: Document,
  slotContainers: Element[],
  context: RuntimeRenderContext,
): Node[] {
  const out: Node[] = [];
  for (const child of children) {
    if (child.kind === "text") out.push(document.createTextNode(child.value));
    else if (child.kind !== "slot") {
      out.push(...renderNode(child, scope, slotChildren, document, slotContainers, [], context));
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
  for (const { definition } of [...registry.definitions.values(), ...definitions]) {
    if (root.defaultView?.customElements.get(definition.contract.tag) !== undefined) continue;
    // A <template>'s content is inert, so querySelectorAll never returns definition-internal
    // markup; every match is a live invocation to lower.
    const invocations = Array.from(root.querySelectorAll(definition.contract.tag));
    for (const invocation of invocations) {
      if (contentOnly.has(invocation)) continue;
      const { scope, passThrough, effects } = readInvocation(invocation, definition);
      const children = Array.from(invocation.childNodes);
      const slotContainers: Element[] = [];
      const instance: RuntimeInstance = {
        definition,
        scope,
        refs: {},
        effects,
        connectCallbacks: new Set(),
        disconnectCallbacks: new Set(),
        connected: true,
      };
      const context: RuntimeRenderContext = {
        definition,
        effects,
        refs: instance.refs,
      };
      const rendered = renderNode(
        definition.template,
        scope,
        children.map((child) => child.cloneNode(true)),
        invocation.ownerDocument,
        slotContainers,
        passThrough,
        context,
      );
      const nativeRoot = rendered[0] as Element;
      instance.element = nativeRoot;
      prepared.push({ invocation, nativeRoot, slotContainers, children, definition, instance });
    }
  }

  for (const live of definitions) {
    registry.definitions.set(live.definition.contract.tag, live);
    if (live.style !== undefined) {
      live.style.textContent = rewriteValiditySelectors(live.style.textContent ?? "");
      live.wrapper!.ownerDocument.head.append(live.style);
    }
    live.wrapper!.remove();
  }

  for (const invocation of prepared) {
    for (const slotContainer of invocation.slotContainers) {
      slotContainer.replaceChildren(...invocation.children);
    }
    invocation.invocation.replaceWith(invocation.nativeRoot);
    registry.instances.set(invocation.nativeRoot, invocation.definition);
    runtimeInstances.set(invocation.nativeRoot, invocation.instance);
  }
  return prepared.length;
}

export interface ComponentHost {
  readonly element: Element;
  readonly state: Record<string, unknown>;
  readonly refs: Readonly<Record<string, Element>>;
  readonly elements: Record<string, Element | RadioNodeList | undefined>;
  effect(run: () => void | (() => void)): () => void;
  on(event: string, listener: EventListener): () => void;
  dispatch(event: string, detail?: unknown): boolean;
}

function connectRuntimeInstance(instance: RuntimeInstance): void {
  if (instance.connected) return;
  instance.connected = true;
  for (const effect of instance.effects) effect.resume();
  for (const callback of instance.connectCallbacks) callback();
}

function disconnectRuntimeInstance(instance: RuntimeInstance): void {
  if (!instance.connected) return;
  instance.connected = false;
  for (const effect of instance.effects) effect.pause();
  for (const callback of instance.disconnectCallbacks) callback();
}

/** Returns the private lifecycle host for a lowered root; page code normally never needs it. */
export function getComponentHost(element: Element): ComponentHost | undefined {
  const instance = runtimeInstances.get(element);
  if (instance === undefined) return undefined;
  const writable = new Set(
    (instance.definition.declarations ?? [])
      .filter((declaration) => declaration.kind === "state")
      .map((declaration) => declaration.name),
  );
  const state = new Proxy({}, {
    get: (_target, key) => typeof key === "string" ? instance.scope.get(key) : undefined,
    set: (_target, key, value) => {
      if (typeof key !== "string" || !writable.has(key)) {
        throw new TypeError(`Only declared state roots are writable; \`${String(key)}\` is read-only.`);
      }
      instance.scope.set(key, value as Value);
      return true;
    },
    has: (_target, key) => typeof key === "string" && instance.scope.has(key),
  });
  const elements = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      const form = element instanceof HTMLFormElement ? element : element.querySelector("form");
      return form?.elements.namedItem(key) ?? element.querySelector(`[name="${CSS.escape(key)}"]`) ?? undefined;
    },
  }) as Record<string, Element | RadioNodeList | undefined>;
  const host: ComponentHost = {
    element,
    state,
    refs: instance.refs,
    elements,
    effect(run) {
      const effect = createEffect(instance.scope.scheduler, run, 2);
      instance.effects.push(effect);
      return () => effect.stop();
    },
    on(event, listener) {
      if (event === "connect") {
        instance.connectCallbacks.add(listener as () => void);
        if (instance.connected) (listener as () => void)();
        return () => instance.connectCallbacks.delete(listener as () => void);
      }
      if (event === "disconnect") {
        instance.disconnectCallbacks.add(listener as () => void);
        return () => instance.disconnectCallbacks.delete(listener as () => void);
      }
      element.addEventListener(event, listener);
      return () => element.removeEventListener(event, listener);
    },
    dispatch(event, detail) {
      return element.dispatchEvent(new CustomEvent(event, { detail, bubbles: true, composed: true }));
    },
  };
  return Object.freeze(host);
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
        const instance = runtimeInstances.get(element);
        if (instance !== undefined) disconnectRuntimeInstance(instance);
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
        const instance = runtimeInstances.get(element);
        if (instance !== undefined) connectRuntimeInstance(instance);
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
    for (const element of connected.keys()) {
      const instance = runtimeInstances.get(element);
      if (instance !== undefined) disconnectRuntimeInstance(instance);
    }
    connected.clear();
  };
  documentObservers.set(root, stop);
  observer.observe(root, { childList: true, subtree: true });
  synchronize();
  return stop;
}
