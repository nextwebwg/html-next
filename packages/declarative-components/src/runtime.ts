import { parseBrowserComponent } from "./browser-source.js";
import type { ControllerModule } from "./controller.js";
import { DataResource } from "./data.js";
import { fail } from "./diagnostics.js";
import type { ComponentGraph } from "./graph.js";
import {
  ABSENT,
  UndeclaredName,
  evaluate,
  evaluateCompiled,
  toAttribute,
  toText,
  truthy,
  type Scope,
  type Value,
} from "./expression.js";
import { kebabCase } from "./names.js";
import {
  createComputed,
  createEffect,
  createSignal,
  ReactiveScope,
  type ReactiveOwner,
} from "./reactivity.js";
import { hasExecutableUrl, isUrlAttribute, sanitizeFragment } from "./sanitize.js";
import {
  addAttributeToken,
  COMPONENT_ATTRIBUTE,
  compileComponentStyles,
  markProjectedRoot,
  stateAttribute,
  stateAttributeValue,
} from "./component-styles.js";
import { parseTypeExpression, parseTypedValue, serializeTypedValue } from "./type-system.js";
import type {
  ComponentDefinition,
  DataDeclaration,
  DirectiveAttribute,
  ElementNode,
  EventDeclaration,
  Flow,
  HandlerDeclaration,
  LiteralAttribute,
  SlotNode,
  TemplateNode,
} from "./template.js";
import type { WritablePath } from "./expression.js";
import type { PropContract, PropValue } from "./types.js";

interface LiveDefinition {
  readonly wrapper?: Element;
  readonly style: HTMLStyleElement | undefined;
  readonly definition: ComponentDefinition;
}

interface PreparedInvocation {
  readonly invocation: Element;
  readonly nativeRoot: Element;
  readonly context: RuntimeRenderContext;
  readonly definition: ComponentDefinition;
  readonly instance: RuntimeInstance;
  readonly replace: boolean;
}

interface SlotInsertion {
  readonly anchor: Comment;
  readonly nodes: readonly Node[];
}

interface RuntimeInstance {
  element?: Element;
  readonly definition: ComponentDefinition;
  readonly scope: ReactiveScope;
  readonly refs: Record<string, Element>;
  readonly effects: ReactiveOwner[];
  readonly connectCallbacks: Set<() => void>;
  readonly disconnectCallbacks: Set<() => void>;
  connected: boolean;
  controllerModule?: Promise<ControllerModule>;
  host?: ComponentHost;
  /** Props the author supplied. Only these are reflected; defaults never are. */
  readonly explicit: Set<string>;
  /** A framework renders this root; document observation never manages it. */
  readonly frameworkOwned: boolean;
  /** Every projected node and its slot, rendered or not (for serialization). */
  projection?: { readonly nodes: readonly Node[]; readonly slotNames: WeakMap<Node, string> };
}

interface DocumentRegistry {
  readonly root: Element | null;
  readonly definitions: Map<string, LiveDefinition>;
  discoverySelector: string | undefined;
}

const contentOnly = new WeakSet<Element>();
const runtimeInstances = new WeakMap<Element, RuntimeInstance>();
const definitionAttributes = new WeakMap<ComponentDefinition, readonly [
  Readonly<Record<string, string>>,
  Readonly<Record<string, string>>,
]>();
const runtimeKey = Symbol.for("@nextwebwg/declarative-components.runtime.v1");
const lifecycleKey = Symbol.for("@nextwebwg/declarative-components.lifecycle.v1");

interface DocumentState {
  registry?: DocumentRegistry;
  mutationHub?: DocumentMutationHub;
  lifecycle?: LifecycleCoordinator;
  observer?: () => void;
  /** Hands a root the observer manages over to a framework attachment. */
  release?: (element: Element) => void;
}

type RuntimeDocument = Document & { [runtimeKey]?: DocumentState };
type RuntimeElement = Element & { [lifecycleKey]?: ManagedComponentLifecycle };

function documentState(root: Document): DocumentState {
  return (root as RuntimeDocument)[runtimeKey] ??= {};
}

function runtimeInstance(element: Element): RuntimeInstance | undefined {
  return runtimeInstances.get(element);
}

function registryFor(root: Document): DocumentRegistry {
  const state = documentState(root);
  let registry = state.registry;
  if (registry === undefined || registry.root !== root.documentElement) {
    registry = { root: root.documentElement, definitions: new Map(), discoverySelector: undefined };
    state.registry = registry;
  }
  return registry;
}

/** The props and state each definition's `:host-state()` rules test, recorded when its styles compile. */
const stateNamesByDefinition = new WeakMap<ComponentDefinition, readonly string[]>();

function compileStyles(css: string, definition: ComponentDefinition, document: Document): string {
  const compiled = compileComponentStyles(css, definition, document);
  stateNamesByDefinition.set(definition, compiled.stateNames);
  return compiled.css;
}

function registerDefinition(registry: DocumentRegistry, tag: string, definition: LiveDefinition): void {
  registry.definitions.set(tag, definition);
  if (registry.discoverySelector !== undefined) registry.discoverySelector += `,${tag}`;
}

function discoverySelector(registry: DocumentRegistry): string {
  return registry.discoverySelector ??=
    [
      "template[component]",
      "[data-component]",
      ...Array.from(registry.definitions.keys()),
    ].join(",");
}

function parseDefinition(wrapper: HTMLTemplateElement, index: number): LiveDefinition {
  const tag = wrapper.getAttribute("component") ?? "";
  const source = `${wrapper.ownerDocument.URL}#template[component="${tag}"][${index + 1}]`;
  if (wrapper.hasAttribute("src")) {
    fail("HL001", "External definitions require the application-owned graph resolver.", source);
  }
  const definition = parseBrowserComponent(wrapper, source);
  const style = Array.from(wrapper.content.children).find(
    (element): element is HTMLStyleElement => element.localName === "style",
  );

  return {
    wrapper,
    style,
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
      style.textContent = compileStyles(node.definition.css, node.definition, root);
      root.head.append(style);
    }
    registerDefinition(registry, tag, {
      definition: node.definition,
      style,
    });
    installed += 1;
  }
  return installed;
}

function invocationValue(prop: PropContract, input: unknown, attributePresent = false): PropValue {
  // Bare boolean attributes retain HTML presence semantics. Explicit values
  // are invocation strings and must still pass through the declared type.
  const candidate = prop.type === "boolean" && attributePresent && input === "" ? true : input;
  const parsed = parseTypedValue(candidate, prop.type);
  if (!parsed.ok) {
    const detail = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    fail("HR002", `A prop invocation value does not satisfy its declared type. ${detail}`);
  }
  return parsed.value as PropValue;
}

function assignedPropValue(name: string, prop: PropContract, input: unknown): Value {
  if (input !== undefined) return invocationValue(prop, input) as Value;
  if (prop.required) fail("HC020", `Required prop \`${name}\` was not provided.`);
  return (prop.default === undefined ? ABSENT : prop.default) as Value;
}

function propAttributeNames(
  definition: ComponentDefinition,
  hydration: boolean,
): Readonly<Record<string, string>> {
  let names = definitionAttributes.get(definition);
  if (names === undefined) {
    const invocation = Object.create(null) as Record<string, string>;
    const hydrated = Object.create(null) as Record<string, string>;
    for (const name of Object.keys(definition.contract.props)) {
      const attributeName = kebabCase(name);
      invocation[attributeName] = name;
      hydrated[`data-${attributeName}`] = name;
      if (attributeName !== name.toLowerCase()) hydrated[`data-${name.toLowerCase()}`] = name;
    }
    names = [invocation, hydrated];
    definitionAttributes.set(definition, names);
  }
  return names[hydration ? 1 : 0];
}

function readInvocation(
  invocation: Element,
  definition: ComponentDefinition,
  hydration = false,
): {
  readonly scope: ReactiveScope;
  readonly passThrough: readonly Attr[];
  readonly effects: ReactiveOwner[];
  readonly rootName: string;
  readonly explicit: Set<string>;
} {
  const contract = definition.contract;
  const names = propAttributeNames(definition, hydration);
  const values = Object.create(null) as Record<string, PropValue | undefined>;
  const passThrough: Attr[] = [];
  let requestedRoot: string | undefined;
  for (const attribute of Array.from(invocation.attributes)) {
    if (attribute.name.toLowerCase() === "as" && definition.root?.kind === "native") {
      requestedRoot = attribute.value.toLowerCase();
      continue;
    }
    const propName = names[attribute.name.toLowerCase()];
    if (propName === undefined) {
      if (!hydration) passThrough.push(attribute);
      continue;
    }
    values[propName] = invocationValue(contract.props[propName]!, attribute.value, !hydration);
  }

  const rootName = definition.root?.kind === "native"
    ? hydration ? invocation.localName : requestedRoot ?? definition.root.element
    : definition.template.name;
  if (
    definition.root?.kind === "native" &&
    !definition.root.choices.includes(rootName)
  ) {
    fail(
      hydration ? "HR005" : "HR002",
      `<${contract.tag}> cannot use root <${rootName}>; expected one of ${definition.root.choices.join(", ")}.`,
    );
  }

  // Props are attributes on the invocation (or, when hydrating, the data-* reflection of the
  // author's explicit attributes). They are never read from JavaScript properties.
  const explicit = new Set(Object.keys(values).filter((name) => values[name] !== undefined));

  const scope = new ReactiveScope();
  for (const [name, prop] of Object.entries(contract.props)) {
    if (prop.required && values[name] === undefined) {
      fail("HC020", `Required prop \`${name}\` was not provided.`);
    }
    // The effective value seen by expressions: passed value, default, or first-class absence.
    scope.set(
      name,
      (values[name] !== undefined
        ? values[name]!
        : prop.default === undefined ? ABSENT : prop.default) as Value,
    );
  }

  const declarations = definition.declarations ?? [];
  for (const declaration of declarations) {
    if (
      declaration.kind === "state" || declaration.kind === "computed" ||
      declaration.kind === "data"
    ) scope.set(declaration.name, null);
  }
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
  const effects: ReactiveOwner[] = [];
  for (const declaration of declarations) {
    if (declaration.kind !== "computed" || declaration.expression === undefined) continue;
    effects.push(scope.defineComputed(
      declaration.name,
      () => evaluateCompiled(declaration.expression!, scope),
    ));
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
  return { scope, passThrough, effects, rootName, explicit };
}

/** A child scope layer whose locals shadow the parent (for $each/$with/$match aliases). */
function layer(parent: ReactiveScope, locals: Record<string, Value>): ReactiveScope {
  return parent.fork(Object.entries(locals));
}

function evalValue(expression: string, scope: Scope): Value {
  try {
    return evaluate(expression, scope);
  } catch (error) {
    if (error instanceof UndeclaredName) fail("HB001", error.message);
    throw error;
  }
}

interface HydrationRange {
  readonly slot: string;
  readonly fallback: boolean;
  /** The server's marker nodes: [start, end], or [marker] for an empty slot. */
  readonly markers: readonly Node[];
  readonly content: readonly Node[];
}

interface RuntimeRenderContext {
  readonly definition: ComponentDefinition;
  readonly effects: ReactiveOwner[];
  readonly refs: Record<string, Element>;
  readonly connectCallbacks: Set<() => void>;
  readonly disconnectCallbacks: Set<() => void>;
  root?: Element;
  readonly projectedNodes: readonly Node[];
  readonly projectedSlotNames: WeakMap<Node, string>;
  readonly slotInsertions: SlotInsertion[];
  readonly rootName: string;
  readonly frameworkOwned: boolean;
  committed: boolean;
  /** Server slot ranges, consumed in template order while hydrating. */
  hydrationRanges?: HydrationRange[] | undefined;
  /** SVG while rendering inside an `<svg>` subtree (outside `<foreignObject>`); otherwise HTML. */
  readonly namespace?: typeof SVG_NAMESPACE;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Bound attribute names reach the runtime lowercased (`:viewBox` is tokenized as `:viewbox`), so
// let the HTML parser apply its own SVG attribute adjustment table rather than shipping a copy.
const svgAttributeNames = new Map<string, string>();

function attributeNameFor(element: Element, name: string): string {
  if (element.namespaceURI !== SVG_NAMESPACE) return name;
  let adjusted = svgAttributeNames.get(name);
  if (adjusted === undefined) {
    const parser = element.ownerDocument.createElement("template");
    parser.innerHTML = `<svg ${name}>`;
    adjusted = (parser.content.firstChild as Element).attributes[0]?.name ?? name;
    svgAttributeNames.set(name, adjusted);
  }
  return adjusted;
}

/** Create an element in the namespace its template position implies. */
function createTemplateElement(document: Document, name: string, context: RuntimeRenderContext): Element {
  if (name === "svg" || context.namespace === SVG_NAMESPACE) {
    return document.createElementNS(SVG_NAMESPACE, name);
  }
  return document.createElement(name);
}

/** The context for an element's children: entering `<svg>` switches to SVG, `<foreignObject>` back to HTML. */
function childContextFor(element: Element, context: RuntimeRenderContext): RuntimeRenderContext {
  const namespace = element.namespaceURI === SVG_NAMESPACE && element.localName !== "foreignObject"
    ? SVG_NAMESPACE
    : undefined;
  if (namespace === context.namespace) return context;
  // Inherit so live fields (committed, root) keep reading from the shared render context.
  return Object.create(context, { namespace: { value: namespace, enumerable: true } }) as RuntimeRenderContext;
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
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
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
      const declaration = eventDeclaration(context.definition, step.event);
      const detail = step.value === undefined ? undefined : evaluateCompiled(step.value, scope);
      if (declaration !== undefined && detail !== undefined) {
        const parsed = parseTypedValue(detail, parseTypeExpression(declaration.type));
        if (!parsed.ok) fail("HR002", `Event \`${step.event}\` detail does not satisfy its declared type.`);
      }
      dispatchComponentEvent(context.root ?? element, step.event, detail, declaration);
    } else {
      const target = context.refs[step.target];
      if (step.kind === "focus") (target as HTMLElement | undefined)?.focus();
      else (target as HTMLInputElement | undefined)?.reportValidity?.();
    }
  }
}

function eventDeclaration(definition: ComponentDefinition, name: string): EventDeclaration | undefined {
  return (definition.declarations ?? []).find(
    (candidate): candidate is EventDeclaration => candidate.kind === "event" && candidate.name === name,
  );
}

/** Undeclared events keep the permissive default: bubbling, composed, and not cancelable. */
function dispatchComponentEvent(
  target: Element,
  event: string,
  detail: unknown,
  declaration: EventDeclaration | undefined,
): boolean {
  return target.dispatchEvent(new CustomEvent(event, {
    detail,
    bubbles: declaration?.bubbles ?? true,
    composed: declaration?.composed ?? true,
    cancelable: declaration?.cancelable ?? false,
  }));
}

function eventPasses(event: Event, element: Element, modifiers: readonly string[]): boolean {
  if (modifiers.includes("self") && event.target !== element) return false;
  if (event instanceof MouseEvent) {
    const buttonFilters = modifiers.filter((modifier) => ["left", "middle", "right"].includes(modifier));
    const buttons: Record<string, number> = { left: 0, middle: 1, right: 2 };
    if (buttonFilters.length > 0 && !buttonFilters.some((filter) => event.button === buttons[filter])) return false;
  }
  const systemKeys = ["ctrl", "shift", "alt", "meta"] as const;
  for (const key of systemKeys) {
    if (modifiers.includes(key) && !(event as unknown as Record<string, boolean>)[`${key}Key`]) return false;
  }
  if (
    modifiers.includes("exact") &&
    systemKeys.some((key) => !modifiers.includes(key) && (event as unknown as Record<string, boolean>)[`${key}Key`])
  ) return false;
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
  for (const binding of node.events ?? []) {
    const declaration = (context.definition.declarations ?? []).find(
      (candidate): candidate is HandlerDeclaration =>
        candidate.kind === "handler" && candidate.name === binding.handler,
    )!;
    const listener = (event: Event): void => {
      if (!eventPasses(event, element, binding.modifiers)) return;
      if (binding.modifiers.includes("prevent")) event.preventDefault();
      if (binding.modifiers.includes("stop")) event.stopPropagation();
      runHandler(declaration, element, scope, context);
    };
    if (binding.name === "connect" || binding.name === "disconnect") {
      const callbacks = binding.name === "connect"
        ? context.connectCallbacks
        : context.disconnectCallbacks;
      callbacks.add(() => listener(new Event(binding.name)));
      continue;
    }
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

function setAttribute(element: Element, name: string, value: string | null): void {
  name = attributeNameFor(element, name);
  if (value === null || (isUrlAttribute(name) && hasExecutableUrl(value))) {
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
  else element.replaceChildren(sanitizeFragment(toText(value), document, (node) => contentOnly.add(node)));
}

/** A `<template $value>`/`<template $html>` produces inline nodes with no wrapper element. */
function inlineDirective(directive: DirectiveAttribute, scope: Scope, document: Document): Node {
  const value = evalValue(directive.expression, scope);
  if (directive.name === "value") return document.createTextNode(toText(value));
  return sanitizeFragment(toText(value), document, (node) => contentOnly.add(node));
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
  document: Document,
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
): Node[] {
  if (node.flow?.kind === "each") {
    return renderEachRegion(node, scope, document, passThrough, context);
  }
  const start = document.createComment("html-next:start");
  const end = document.createComment("html-next:end");
  const fragment = document.createDocumentFragment();
  fragment.append(start, end);
  let childEffects: ReactiveOwner[] = [];
  ownEffect(context, scope, () => {
    for (const effect of childEffects) effect.stop();
    childEffects = [];
    clearRange(start, end);
    const effectsStart = context.effects.length;
    let rendered: Node[] = [];
    if (node.flow?.kind === "if") {
      if (truthy(evalValue(node.flow.test, scope))) {
        const { flow: _flow, ...body } = node;
        rendered = renderInstance(body, scope, document, passThrough, context);
      }
    } else if (node.flow?.kind === "with") {
      const local = scope.fork([[node.flow.alias, evalValue(node.flow.expr, scope)]]);
      const { flow: _flow, ...body } = node;
      rendered = renderInstance(body, local, document, passThrough, context);
    } else if (node.flow?.kind === "match") {
      rendered = renderMatch(node, scope, document, context);
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
  readonly effects: readonly ReactiveOwner[];
}

function moveBlockBefore(block: EachBlock, reference: Node): void {
  if (block.end.nextSibling === reference) return;
  const nodes: Node[] = [];
  let current: Node | null = block.start;
  while (current !== null) {
    nodes.push(current);
    if (current === block.end) break;
    current = current.nextSibling;
  }
  const parent = reference.parentNode;
  if (parent === null) return;
  const moveBefore = (parent as Node & {
    moveBefore?: (node: Node, child: Node | null) => void;
  }).moveBefore;
  for (const node of nodes) {
    if (moveBefore === undefined) parent.insertBefore(node, reference);
    else moveBefore.call(parent, node, reference);
  }
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

/** Mark the longest subsequence of retained blocks that is already in DOM order. */
function stableBlockPositions(previous: readonly number[]): Uint8Array | undefined {
  let last = -1;
  let ordered = true;
  for (const position of previous) {
    if (position < 0) continue;
    if (position < last) ordered = false;
    last = position;
  }
  if (ordered) return undefined;

  const tails: number[] = [];
  const predecessors = new Int32Array(previous.length).fill(-1);
  for (let index = 0; index < previous.length; index += 1) {
    const position = previous[index]!;
    if (position < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (previous[tails[middle]!]! < position) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = tails[low - 1]!;
    tails[low] = index;
  }

  const stable = new Uint8Array(previous.length);
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    stable[cursor] = 1;
    cursor = predecessors[cursor]!;
  }
  return stable;
}

function renderEachRegion(
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
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
    const keyed = flow.key !== undefined;
    const ordered: EachBlock[] | undefined = keyed ? [] : undefined;
    let oldPositions: Map<unknown, number> | undefined;
    if (keyed) {
      oldPositions = new Map();
      let position = 0;
      for (const key of blocks.keys()) oldPositions.set(key, position++);
    }
    const previous: number[] | undefined = keyed ? [] : undefined;
    const { flow: _flow, ...body } = node;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const locals: Record<string, Value> = {
        [flow.item]: item,
        loop: { index, first: index === 0, last: index === items.length - 1, count: items.length },
      };
      if (flow.index !== undefined) locals[flow.index] = index;
      let local: ReactiveScope | undefined;
      let key: unknown = index;
      if (flow.key !== undefined) {
        local = scope.fork(Object.entries(locals));
        key = evalValue(flow.key, local);
      }
      if (next.has(key)) fail("HR004", `A keyed list produced duplicate key \`${toText(key as Value)}\`.`);
      let block = blocks.get(key);
      if (block === undefined) {
        local ??= scope.fork(Object.entries(locals));
        const effectsStart = context.effects.length;
        const rendered = materialize(
          renderInstance(body, local, document, passThrough, context),
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
      ordered?.push(block);
      previous?.push(oldPositions?.get(key) ?? -1);
    }
    for (const [key, block] of blocks) if (!next.has(key)) removeBlock(block);
    if (ordered !== undefined && previous !== undefined) {
      const stable = stableBlockPositions(previous);
      let reference: Node = end;
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const block = ordered[index]!;
        if (previous[index]! < 0 || stable !== undefined && stable[index] !== 1) {
          moveBlockBefore(block, reference);
        }
        reference = block.start;
      }
    }
    blocks = next;
  });
  return [fragment];
}

function renderNode(
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  if (
    node.flow?.kind === "if" ||
    node.flow?.kind === "each" ||
    node.flow?.kind === "with" ||
    node.flow?.kind === "match"
  ) {
    // Framework renderers retain ownership of structural branches and their
    // reconciliation anchors. During adoption, keep the framework's current
    // node; installing a second reactive branch would invalidate its next
    // update target and can move projected content into the wrong region.
    if (context.committed && context.frameworkOwned && candidate !== undefined) return [candidate];
    return renderDynamicNode(node, scope, document, passThrough, context);
  }
  // Only `$when`/`$else` arms remain; outside a `$match` their marker is ignored.
  return renderInstance(node, scope, document, passThrough, context, candidate);
}

function renderMatch(
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
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
  const rendered = renderInstance(armNode, matchScope, document, [], context);
  if (node.name === "template") return rendered;

  // $match on a real element wraps the winning arm in that element.
  const wrapper = createTemplateElement(document, node.name, context);
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
  document: Document,
  passThrough: readonly Attr[],
  context: RuntimeRenderContext,
  candidate?: Node,
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
    return renderChildren(node.children, scope, document, context);
  }

  const elementName = node === context.definition.template ? context.rootName : node.name;
  if (
    context.frameworkOwned &&
    candidate instanceof Element &&
    candidate.localName !== elementName &&
    (candidate.getAttribute("data-component") ?? "").split(/\s+/).includes(node.name)
  ) {
    // A framework renders nested declarative components as their native roots,
    // not as the authored invocation tag. That child owns its already-adopted
    // subtree; walking the parent's invocation shape would move its projected
    // nodes into a disconnected synthetic element.
    return [candidate];
  }
  if (
    context.hydrationRanges !== undefined &&
    !context.frameworkOwned &&
    candidate instanceof Element &&
    candidate.localName !== elementName &&
    (candidate.getAttribute("data-component") ?? "").split(/\s+/).includes(node.name)
  ) {
    // A nested component the server already lowered. Keep its root, and bind this
    // definition's nodes that were projected into it: they sit in the nested root's slot ranges (or its
    // carrier), exactly where lowering put them.
    const nested = serverRanges(candidate, false);
    const slotOf = (child: TemplateNode): string => child.kind === "element"
      ? child.attributes.find((attribute): attribute is LiteralAttribute => attribute.kind === "literal" && attribute.name === "slot")?.value ?? ""
      : "";
    const rendered = nested?.ranges.filter((range) => !range.fallback) ?? [];
    const walk = (children: readonly TemplateNode[], existing: readonly Node[]): void => {
      let cursor = 0;
      for (const child of children) cursor += renderTemplateNode(child, scope, document, context, existing[cursor]).length;
    };
    for (const range of rendered) walk(node.children.filter((child) => slotOf(child) === range.slot), range.content);
    const renderedSlots = new Set(rendered.map((range) => range.slot));
    walk(node.children.filter((child) => !renderedSlots.has(slotOf(child))), nested?.carried ?? []);
    return [candidate];
  }
  const adopted = candidate instanceof Element && candidate.localName === elementName;
  const element = adopted ? candidate : createTemplateElement(document, elementName, context);
  if (node === context.definition.template) context.root = element;
  const existingChildren = adopted ? Array.from(element.childNodes) : [];
  const controlState = adopted && (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) ? {
      value: element.value,
      focused: element.ownerDocument.activeElement === element,
      ...(element instanceof HTMLInputElement ? { checked: element.checked } : {}),
      ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? { selectionStart: element.selectionStart, selectionEnd: element.selectionEnd }
        : {}),
    } : undefined;
  if (node.ref !== undefined) context.refs[node.ref] = element;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") element.setAttribute(attribute.name, attribute.value);
  }
  // The invocation's attributes win over the template's literals; class and style combine. Bound
  // attributes, applied next, are the component's own output.
  for (const attribute of passThrough) {
    const own = attribute.name === "class" || attribute.name === "style" ? element.getAttribute(attribute.name) : null;
    element.setAttribute(attribute.name, own === null || own === "" ? attribute.value : `${own}${attribute.name === "class" ? " " : "; "}${attribute.value}`);
  }
  for (const attribute of node.attributes) {
    if (attribute.kind === "attribute") {
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

  let renderedChildren: Node[] = [];
  let cursor = 0;
  const childContext = childContextFor(element, context);
  for (const child of node.children) {
    let candidateIndex = cursor;
    if (context.frameworkOwned && child.kind === "element") {
      // Frameworks may retain whitespace, hydration anchors, and branch sentinels between
      // authored elements. Match the framework's owned element by shape instead of treating
      // its raw childNodes offset as the declarative-template offset; otherwise effects and
      // listeners are installed on a disconnected replacement that the framework never uses.
      let matchingIndex = existingChildren.findIndex((candidate, index) => {
        if (index < cursor) return false;
        return candidate instanceof Element && (
          candidate.localName === child.name ||
          (candidate.getAttribute("data-component") ?? "").split(/\s+/).includes(child.name)
        );
      });
      if (matchingIndex < 0 && child.flow !== undefined) {
        matchingIndex = existingChildren.findIndex((candidate, index) =>
          index >= cursor && candidate instanceof Comment
        );
      }
      if (matchingIndex >= 0) candidateIndex = matchingIndex;
    }
    const rendered = renderTemplateNode(child, scope, document, childContext, existingChildren[candidateIndex]);
    renderedChildren.push(...rendered);
    cursor = candidateIndex + rendered.length;
  }
  if (adopted && !context.frameworkOwned) {
    // Structural renderers use DocumentFragments. Reconcile their children,
    // not the fragment carrier, because inserting a fragment consumes it and
    // would otherwise make the following-child count stale.
    renderedChildren = renderedChildren.flatMap((child) =>
      child.nodeType === 11 ? Array.from(child.childNodes) : [child]
    );
    for (let index = 0; index < renderedChildren.length; index += 1) {
      const expected = renderedChildren[index]!;
      if (element.childNodes[index] !== expected) {
        element.insertBefore(expected, element.childNodes[index] ?? null);
      }
    }
    while (element.childNodes.length > renderedChildren.length) element.lastChild!.remove();
  } else if (!adopted) {
    element.append(...renderedChildren);
  }
  if (controlState !== undefined) {
    (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = controlState.value;
    if (element instanceof HTMLInputElement && "checked" in controlState) {
      element.checked = controlState.checked;
    }
    if (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      "selectionStart" in controlState &&
      typeof controlState.selectionStart === "number" &&
      typeof controlState.selectionEnd === "number"
    ) {
      if (controlState.focused) element.focus({ preventScroll: true });
      element.setSelectionRange(controlState.selectionStart, controlState.selectionEnd);
    }
  }
  bindEvents(element, node, scope, context);
  return [element];
}

function renderChildren(
  children: readonly TemplateNode[],
  scope: ReactiveScope,
  document: Document,
  context: RuntimeRenderContext,
): Node[] {
  const out: Node[] = [];
  for (const child of children) out.push(...renderTemplateNode(child, scope, document, context));
  return out;
}

function projectedSlotName(node: Node, context: RuntimeRenderContext): string {
  return context.projectedSlotNames.get(node) ??
    (node instanceof Element ? node.getAttribute("slot") ?? "" : "");
}

function renderSlot(
  node: SlotNode,
  scope: ReactiveScope,
  document: Document,
  context: RuntimeRenderContext,
): Node[] {
  const name = node.nameExpression === undefined
    ? node.name ?? ""
    : toText(evaluateCompiled(node.nameExpression, scope));
  const assigned = context.projectedNodes.filter((candidate) => projectedSlotName(candidate, context) === name);
  // Rendered form (spec: live-browser-distributable.md, "Rendered form"): every rendered slot is
  // delimited, so server output can rebuild the same instance.
  const hydrating = context.hydrationRanges?.shift();
  if (hydrating !== undefined) {
    // Adopt the server's range whole: its markers, and either the consumer's nodes or the fallback.
    if (hydrating.fallback) {
      const adopted: Node[] = [];
      let cursor = 0;
      for (const child of node.fallback ?? []) {
        const out = renderTemplateNode(child, scope, document, context, hydrating.content[cursor]);
        adopted.push(...out);
        cursor += out.length;
      }
      return [hydrating.markers[0]!, ...adopted, ...hydrating.markers.slice(1)];
    }
    for (const candidate of hydrating.content) markProjectedRoot(candidate);
    return hydrating.markers.length === 1
      ? [hydrating.markers[0]!]
      : [hydrating.markers[0]!, ...hydrating.content, hydrating.markers[1]!];
  }
  const quoted = (value: string): string =>
    `"${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"`;
  // Where the parser does not produce PIs, write the comment it would produce, so a lowered DOM and a
  // hydrated DOM hold the same nodes.
  const instruction = (target: string, data: string): Node => renderedFormMark(document, target, data);
  const ranged = (nodes: Node[], fallback: boolean): Node[] => {
    if (nodes.length === 0) return [instruction("marker", `slot=${quoted(name)}`)];
    const data = `slot=${quoted(name)}${fallback ? ' fallback=""' : ""}`;
    return [instruction("start", data), ...nodes, instruction("end", "")];
  };
  if (assigned.length === 0) {
    return ranged(renderChildren(node.fallback ?? [], scope, document, context), true);
  }
  if (context.committed) {
    for (const candidate of assigned) markProjectedRoot(candidate);
    return ranged([...assigned], false);
  }
  const anchor = document.createComment(`html-next:slot:${name}`);
  context.slotInsertions.push({ anchor, nodes: assigned });
  return ranged([anchor], false);
}

// ---- Rendered form (spec: live-browser-distributable.md, "Rendered form") ----

interface ServerMark { readonly target: string; readonly attributes: Map<string, string> }

function pseudoAttributes(data: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let rest = data.trim();
  const references: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  while (rest !== "") {
    const match = /^([A-Za-z_:][-A-Za-z0-9._:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')(?:\s+|$)/.exec(rest);
    if (match === null || attributes.has(match[1]!)) return new Map();
    const value = (match[2] ?? match[3]!).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, body: string) =>
      body.startsWith("#x") ? String.fromCodePoint(parseInt(body.slice(2), 16))
        : body.startsWith("#") ? String.fromCodePoint(Number(body.slice(1))) : references[body]!);
    attributes.set(match[1]!, value);
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

const piParsingByDocument = new WeakMap<Document, boolean>();
function documentParsesInstructions(document: Document): boolean {
  let piParsing = piParsingByDocument.get(document);
  if (piParsing === undefined) {
    const probe = document.createElement("div");
    probe.innerHTML = '<?probe x="1"?>';
    piParsing = probe.firstChild?.nodeType === 7;
    piParsingByDocument.set(document, piParsing);
  }
  return piParsing;
}
/**
 * A rendered-form mark: a processing instruction, or, where the parser does not produce them, the
 * comment it would produce instead, so a lowered DOM and a hydrated DOM hold the same nodes.
 */
function renderedFormMark(document: Document, target: string, data: string): Node {
  return documentParsesInstructions(document)
    ? document.createProcessingInstruction(target, data)
    : document.createComment(`?${target}${data === "" ? "" : ` ${data}`}?`);
}

function serverMark(node: Node): ServerMark | undefined {
  if (node.nodeType === 7) {
    const pi = node as ProcessingInstruction;
    return { target: pi.target, attributes: pseudoAttributes(pi.data) };
  }
  if (node.nodeType !== 8) return undefined;
  if (documentParsesInstructions(node.ownerDocument!)) return undefined;   // a real comment is never a marker where PIs parse
  const match = /^\?([A-Za-z][-A-Za-z0-9]*)(?:\s+([\s\S]*?))?\s*\??$/.exec((node as Comment).data);
  return match === null ? undefined : { target: match[1]!, attributes: pseudoAttributes(match[2] ?? "") };
}

/** The slot ranges a server-rendered root owns, in document order, and its carried projection. */
function serverRanges(root: Element, consume = true): { ranges: HydrationRange[]; carried: Node[] } | undefined {
  const ranges: HydrationRange[] = [];
  const inRanges = new Set<Node>();
  const collect = (nodes: readonly Node[], into: HydrationRange[]): void => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const mark = serverMark(node);
      if (mark?.target === "marker" && mark.attributes.has("slot")) {
        into.push({ slot: mark.attributes.get("slot")!, fallback: false, markers: [node], content: [] });
        continue;
      }
      if (mark?.target === "start") {
        let depth = 1;
        const content: Node[] = [];
        let end: Node | undefined;
        for (index += 1; index < nodes.length; index += 1) {
          const inner = serverMark(nodes[index]!);
          if (inner?.target === "start") depth += 1;
          else if (inner?.target === "end" && --depth === 0) { end = nodes[index]; break; }
          content.push(nodes[index]!);
        }
        if (mark.attributes.has("slot")) {
          into.push({ slot: mark.attributes.get("slot")!, fallback: mark.attributes.has("fallback"), markers: end ? [node, end] : [node], content });
          for (const child of content) inRanges.add(child);
        } else collect(content, into);   // a page's own range is transparent
        continue;
      }
      if (!(node instanceof Element)) continue;
      if (node !== root && node.hasAttribute("data-component")) {
        const nested = serverRanges(node, false);
        for (const range of nested?.ranges ?? []) collect(range.content, into);
      } else collect(Array.from(node.childNodes), into);
    }
  };
  collect(Array.from(root.childNodes), ranges);
  // The carrier is the <template> child that follows a `carrier` mark, outside every range.
  const carrier = Array.from(root.children).find((child): child is HTMLTemplateElement =>
    child instanceof HTMLTemplateElement && !inRanges.has(child) &&
    child.previousSibling !== null && serverMark(child.previousSibling)?.target === "carrier");
  if (ranges.length === 0 && carrier === undefined) return undefined;
  const carried: Node[] = [];
  if (carrier !== undefined && consume) {
    for (const child of Array.from(carrier.content.childNodes)) carried.push(root.ownerDocument.adoptNode(child));
    carrier.previousSibling!.remove();
    carrier.remove();
  } else if (carrier !== undefined) carried.push(...Array.from(carrier.content.childNodes));
  return { ranges, carried };
}

/**
 * Serializes the rendered form. Like getHTML({ serializableShadowRoots }), it writes what
 * the live DOM does not hold: each component root's projected nodes that no slot currently renders,
 * in an inert trailing <template>.
 */
export function serializeRenderedForm(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  const originals = [container, ...Array.from(container.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  originals.forEach((original, index) => {
    const projection = runtimeInstance(original)?.projection;
    if (projection === undefined) return;
    const unrendered = projection.nodes.filter((node) => !original.contains(node));
    if (unrendered.length === 0) return;
    const carrier = clone.ownerDocument.createElement("template");
    for (const node of unrendered) carrier.content.append(node.cloneNode(true));
    copies[index]!.append(renderedFormMark(clone.ownerDocument, "carrier", ""), carrier);
  });
  return clone.innerHTML;
}

/**
 * Diagnostic: an instance's internal shape (definition, explicit props, prop values, projected nodes per
 * slot). Two instances with equal shapes behave identically; conformance tests compare them.
 */
export function inspectInstance(element: Element): unknown {
  const instance = runtimeInstance(element);
  if (instance === undefined) return undefined;
  const props: Record<string, unknown> = {};
  for (const name of Object.keys(instance.definition.contract.props)) props[name] = instance.scope.get(name);
  const slots: Record<string, string[]> = {};
  for (const node of instance.projection?.nodes ?? []) {
    const slot = instance.projection!.slotNames.get(node) ?? (node instanceof Element ? node.getAttribute("slot") ?? "" : "");
    (slots[slot] ??= []).push(node instanceof Element ? node.outerHTML.replace(/ data-slotted=""/g, "") : node.textContent ?? "");
  }
  // Order across slots is not observable; order within a slot is.
  const sorted = Object.fromEntries(Object.entries(slots).sort(([a], [b]) => a.localeCompare(b)));
  return { tag: instance.definition.contract.tag, explicit: [...instance.explicit].sort(), props, slots: sorted };
}

function renderTemplateNode(
  node: TemplateNode,
  scope: ReactiveScope,
  document: Document,
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  if (node.kind === "text") {
    const text = candidate instanceof Text ? candidate : document.createTextNode("");
    text.data = node.value;
    return [text];
  }
  if (node.kind === "slot") return renderSlot(node, scope, document, context);
  return renderNode(node, scope, document, [], context, candidate);
}

/**
 * Keeps `data-<tag>-state` in step with the resolved props and state the definition's `:host-state()`
 * rules test, so styles see defaults and state as well as explicit props.
 */
function installStateAttribute(root: Element, instance: RuntimeInstance): void {
  const names = stateNamesByDefinition.get(instance.definition) ?? [];
  if (names.length === 0) return;
  const attribute = stateAttribute(instance.definition.contract.tag);
  instance.effects.push(createEffect(instance.scope.scheduler, () => {
    const value = stateAttributeValue(names, (name) => instance.scope.get(name));
    if (value === "") root.removeAttribute(attribute);
    else if (root.getAttribute(attribute) !== value) root.setAttribute(attribute, value);
  }, 2));
}

/**
 * Reflects the author's explicit props onto the lowered root as `data-<name>` so the element records
 * which options produced it (and server output can be hydrated). Defaults are never written, and no
 * JavaScript properties are added: the root keeps its native properties untouched. Later attribute
 * writes by the author are parsed back into the scope.
 */
function installPropReflection(root: Element, instance: RuntimeInstance): void {
  const props = instance.definition.contract.props;
  const attributeNames: Record<string, string> = {};
  const reflected: Record<string, string | null> = {};

  for (const [name, prop] of Object.entries(props)) {
    const attributeName = `data-${kebabCase(name)}`;
    attributeNames[attributeName] = name;
    // When the template binds this attribute itself it is template output and always shows the
    // effective value (defaults included), matching the compiled runtime's `bound` props.
    const bound = instance.definition.template.attributes.some((binding) =>
      binding.kind === "attribute" && binding.name === attributeName
    );
    instance.effects.push(createEffect(instance.scope.scheduler, () => {
      const value = instance.scope.get(name);
      if (!bound && !instance.explicit.has(name)) return;
      // Null is "no value" at the attribute boundary: it removes the attribute rather than
      // writing text that would not parse back.
      const serialized = value === undefined || value === ABSENT || value === null
        ? null
        : serializeTypedValue(value, prop.type);
      reflected[attributeName] = serialized;
      if (serialized === null) root.removeAttribute(attributeName);
      else root.setAttribute(attributeName, serialized);
    }, 2));
  }

  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  const attributeFilter = Object.keys(attributeNames);
  if (Observer === undefined || attributeFilter.length === 0) return;
  const observer = new Observer((records) => {
    for (const record of records) {
      const attributeName = record.attributeName;
      if (attributeName === null) continue;
      const name = attributeNames[attributeName];
      if (name === undefined) continue;
      const value = root.getAttribute(attributeName);
      if (attributeName in reflected && reflected[attributeName] === value) {
        delete reflected[attributeName];
        continue;
      }
      delete reflected[attributeName];
      const prop = props[name]!;
      if (value === null) instance.explicit.delete(name);
      else instance.explicit.add(name);
      instance.scope.set(
        name,
        value === null ? assignedPropValue(name, prop, undefined) : invocationValue(prop, value, true) as Value,
      );
    }
  });
  const connect = (): void => observer.observe(root, {
    attributes: true,
    attributeFilter,
  });
  const disconnect = (): void => observer.disconnect();
  instance.connectCallbacks.add(connect);
  instance.disconnectCallbacks.add(disconnect);
}

function installPublicMethods(root: Element, instance: RuntimeInstance): void {
  for (const declaration of instance.definition.declarations ?? []) {
    if (declaration.kind !== "method") continue;
    Object.defineProperty(root, declaration.name, {
      configurable: true,
      enumerable: false,
      value: (...args: unknown[]) => {
        if (instance.controllerModule === undefined) {
          return Promise.reject(new TypeError(
            `Controller method \`${declaration.name}\` is not ready for <${instance.definition.contract.tag}>.`,
          ));
        }
        return instance.controllerModule.then((module) => {
          const method = module[declaration.exportName];
          if (typeof method !== "function") {
            fail("HJ003", `Controller does not export method \`${declaration.exportName}\`.`);
          }
          return Reflect.apply(method, undefined, [getComponentHost(root), ...args]);
        });
      },
    });
  }
}

function prepareRuntimeInvocation(
  invocation: Element,
  definition: ComponentDefinition,
  hydration: boolean,
  projectedNodes?: readonly Node[],
  projectedSlotNames = new WeakMap<Node, string>(),
  frameworkOwned = false,
): PreparedInvocation {
  const focusedControl = hydration && invocation.contains(invocation.ownerDocument.activeElement)
    ? invocation.ownerDocument.activeElement
    : null;
  const focusedSelection = focusedControl instanceof HTMLInputElement || focusedControl instanceof HTMLTextAreaElement
    ? [focusedControl.selectionStart, focusedControl.selectionEnd] as const
    : undefined;
  const { scope, passThrough, effects, rootName, explicit } = readInvocation(invocation, definition, hydration);
  let hydratedNodes = projectedNodes;
  let hydrationRanges: HydrationRange[] | undefined;
  if (hydration && hydratedNodes === undefined) {
    const server = serverRanges(invocation);
    if (server !== undefined) {
      // The rendered form names every slot range, and the serializer carried the
      // projected nodes no slot currently renders. Together they are the authored projection.
      hydrationRanges = server.ranges;
      const nodes: Node[] = [];
      for (const range of server.ranges) {
        if (range.fallback) continue;
        for (const node of range.content) {
          projectedSlotNames.set(node, range.slot);
          nodes.push(node);
        }
      }
      nodes.push(...server.carried);
      hydratedNodes = nodes;
    } else if ((definition.slots ?? []).length > 0) {
      // Only the root carries a component marker, so nothing tells template output from projected
      // content without slot marks. Guessing would build a different instance.
      fail("HR005", `<${definition.contract.tag}> has slots but its server-rendered root has no slot marks.`);
    } else {
      hydratedNodes = [];
    }
  }
  const children = hydration ? hydratedNodes! : Array.from(invocation.childNodes);
  const instance: RuntimeInstance = {
    definition,
    scope,
    refs: {},
    effects,
    connectCallbacks: new Set(),
    disconnectCallbacks: new Set(),
    connected: false,
    explicit,
    frameworkOwned,
    projection: { nodes: hydration ? hydratedNodes! : Array.from(invocation.childNodes), slotNames: projectedSlotNames },
  };
  const context: RuntimeRenderContext = {
    definition,
    effects,
    refs: instance.refs,
    connectCallbacks: instance.connectCallbacks,
    disconnectCallbacks: instance.disconnectCallbacks,
    projectedNodes: children,
    projectedSlotNames,
    slotInsertions: [],
    rootName,
    frameworkOwned,
    committed: hydration,
    hydrationRanges,
  };
  const rendered = renderNode(
    definition.template,
    scope,
    invocation.ownerDocument,
    passThrough,
    context,
    hydration ? invocation : undefined,
  );
  context.hydrationRanges = undefined;
  const nativeRoot = rendered[0] as Element;
  if (hydration && nativeRoot !== invocation) {
    fail("HR005", `Server markup for <${definition.contract.tag}> has an incompatible root.`);
  }
  if (focusedControl instanceof HTMLElement) {
    focusedControl.focus({ preventScroll: true });
    if (
      focusedSelection !== undefined &&
      (focusedControl instanceof HTMLInputElement || focusedControl instanceof HTMLTextAreaElement) &&
      typeof focusedSelection[0] === "number" &&
      typeof focusedSelection[1] === "number"
    ) focusedControl.setSelectionRange(focusedSelection[0], focusedSelection[1]);
  }
  addAttributeToken(nativeRoot, COMPONENT_ATTRIBUTE, definition.contract.tag);
  instance.element = nativeRoot;
  return {
    invocation,
    nativeRoot,
    context,
    definition,
    instance,
    replace: !hydration,
  };
}

function commitRuntimeInvocations(
  registry: DocumentRegistry,
  prepared: PreparedInvocation[],
): void {
  // Commit ancestors first so their slot insertion moves nested live invocations before
  // descendants replace themselves. Discovery order does not determine nested survival.
  prepared.sort((left, right) => {
    if (left.invocation.contains(right.invocation)) return -1;
    if (right.invocation.contains(left.invocation)) return 1;
    return 0;
  });
  for (const invocation of prepared) {
    for (const insertion of invocation.context.slotInsertions) {
      for (const child of insertion.nodes) markProjectedRoot(child);
      insertion.anchor.replaceWith(...insertion.nodes);
    }
    if (invocation.replace) invocation.invocation.replaceWith(invocation.nativeRoot);
    invocation.context.committed = true;
    runtimeInstances.set(invocation.nativeRoot, invocation.instance);
    installPropReflection(invocation.nativeRoot, invocation.instance);
    installStateAttribute(invocation.nativeRoot, invocation.instance);
    installPublicMethods(invocation.nativeRoot, invocation.instance);
    connectRuntimeInstance(invocation.instance);
  }
}

type QueryRoot = Node & ParentNode;

function collectWithin(scope: QueryRoot, selector: string, elements: Set<Element>): void {
  if (scope.nodeType === 1 && (scope as Element).matches(selector)) elements.add(scope as Element);
  for (const element of scope.querySelectorAll(selector)) elements.add(element);
}

function visitComponentRoots(scope: QueryRoot, visit: (element: Element) => void): void {
  const element = scope.nodeType === 1 ? scope as Element : undefined;
  if (element?.matches("[data-component]") === true) visit(element);
  if (element?.childElementCount === 0) return;
  for (const descendant of scope.querySelectorAll("[data-component]")) visit(descendant);
}

interface LoweredScopes {
  readonly lowered: readonly Element[];
  readonly roots: readonly Element[];
}

function lowerScopes(
  root: Document,
  scopes: readonly QueryRoot[],
  shouldLower?: (element: Element, definition: ComponentDefinition, hydration: boolean) => boolean,
): LoweredScopes {
  const registry = registryFor(root);
  const discovered = new Set<Element>();
  const selector = discoverySelector(registry);
  for (const scope of scopes) collectWithin(scope, selector, discovered);
  const definitions: LiveDefinition[] = [];
  for (const element of discovered) {
    if (element.localName === "template" && element.hasAttribute("component") && !contentOnly.has(element)) {
      definitions.push(parseDefinition(element as HTMLTemplateElement, definitions.length));
    }
  }
  const newDefinitions = new Map<string, LiveDefinition>();
  for (const live of definitions) {
    const tag = live.definition.contract.tag;
    if (registry.definitions.has(tag) || newDefinitions.has(tag)) {
      fail("HR001", `More than one definition declares <${tag}>.`);
    }
    newDefinitions.set(tag, live);
  }

  const prepared: PreparedInvocation[] = [];
  const roots = new Set<Element>();
  const prepare = (live: LiveDefinition, element: Element, hydration: boolean): boolean => {
    const { definition } = live;
    if (
      contentOnly.has(element) ||
      root.defaultView?.customElements.get(definition.contract.tag) !== undefined ||
      shouldLower?.(element, definition, hydration) === false
    ) return false;
    prepared.push(prepareRuntimeInvocation(element, definition, hydration));
    return true;
  };
  const collect = (byTag: ReadonlyMap<string, LiveDefinition>, elements: Iterable<Element>): void => {
    for (const element of elements) {
      const live = byTag.get(element.localName);
      if (live !== undefined) prepare(live, element, false);
      if (!element.hasAttribute("data-component")) continue;
      const existing = runtimeInstance(element);
      if (existing !== undefined) {
        if (!existing.frameworkOwned) roots.add(element);
        continue;
      }
      let accepted = false;
      for (const tag of new Set((element.getAttribute("data-component") ?? "").split(/\s+/))) {
        const owner = byTag.get(tag);
        if (owner !== undefined && prepare(owner, element, true)) accepted = true;
      }
      if (accepted) roots.add(element);
    }
  };
  collect(registry.definitions, discovered);
  // A newly discovered definition also applies to matching invocations that predate it.
  if (newDefinitions.size > 0) {
    const selector = [
      "[data-component]",
      ...Array.from(newDefinitions.keys()),
    ].join(",");
    const existing = new Set<Element>();
    collectWithin(root, selector, existing);
    collect(newDefinitions, existing);
  }

  for (const live of definitions) {
    registerDefinition(registry, live.definition.contract.tag, live);
    if (live.style !== undefined) {
      live.style.textContent = compileStyles(live.style.textContent ?? "", live.definition, live.wrapper!.ownerDocument);
      live.wrapper!.ownerDocument.head.append(live.style);
    }
    live.wrapper!.remove();
  }

  commitRuntimeInvocations(registry, prepared);
  const lowered = prepared.map((invocation) => invocation.nativeRoot);
  for (const element of lowered) roots.add(element);
  return { lowered, roots: Array.from(roots) };
}

/**
 * Performs one explicit lowering pass, retaining definitions in a document registry for
 * later passes. It does not observe mutations or register Custom Elements.
 */
export function lowerDocument(root: Document = document): number {
  return lowerScopes(root, [root]).lowered.length;
}

export interface ComponentAttachmentOptions {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly controller?: ControllerModule;
  /**
   * The nodes the caller placed in slots, with each one's slot name. Only the root carries a
   * component marker, so a generated factory that renders slot content itself reports it here.
   */
  readonly projected?: readonly (readonly [node: Node, slot: string])[];
}

interface ManagedComponentLifecycle {
  readonly connect: (element: Element) => () => void;
  disconnect: undefined | (() => void);
}

interface LifecycleCoordinator {
  add(element: Element, record: ManagedComponentLifecycle): void;
  remove(element: Element, record: ManagedComponentLifecycle): void;
}

type DocumentMutationSubscriber = (mutations: readonly MutationRecord[]) => void;

interface DocumentMutationHub {
  readonly observer: MutationObserver;
  readonly subscribers: Set<DocumentMutationSubscriber>;
}

function subscribeDocumentMutations(
  root: Document,
  subscriber: DocumentMutationSubscriber,
): () => void {
  const state = documentState(root);
  let hub = state.mutationHub;
  if (hub === undefined) {
    const Observer = root.defaultView?.MutationObserver;
    if (Observer === undefined) {
      fail("HR003", "Automatic component management requires a browser MutationObserver.");
    }
    const subscribers = new Set<DocumentMutationSubscriber>();
    const observer = new Observer((mutations) => {
      for (const notify of Array.from(subscribers)) notify(mutations);
    });
    hub = { observer, subscribers };
    state.mutationHub = hub;
    observer.observe(root, { childList: true, subtree: true });
  }
  hub.subscribers.add(subscriber);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    hub.subscribers.delete(subscriber);
    if (hub.subscribers.size === 0) {
      hub.observer.disconnect();
      delete state.mutationHub;
    }
  };
}

function coordinatorFor(root: Document): LifecycleCoordinator {
  const state = documentState(root);
  const existing = state.lifecycle;
  if (existing !== undefined) return existing;
  let size = 0;
  const synchronize = (element: Element): void => {
    const record = (element as RuntimeElement)[lifecycleKey];
    if (record === undefined) return;
    if (element.isConnected && record.disconnect === undefined) {
      record.disconnect = record.connect(element);
    } else if (!element.isConnected && record.disconnect !== undefined) {
      record.disconnect();
      record.disconnect = undefined;
    }
  };
  const stopObservation = subscribeDocumentMutations(root, (mutations) => {
    const changed: Element[] = [];
    const collect = (node: Node): void => {
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if ((element as RuntimeElement)[lifecycleKey] !== undefined) changed.push(element);
      visitComponentRoots(element, (descendant) => {
        if ((descendant as RuntimeElement)[lifecycleKey] !== undefined) changed.push(descendant);
      });
    };
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) collect(node);
      for (const node of mutation.removedNodes) collect(node);
    }
    for (const element of changed) synchronize(element);
  });
  const coordinator: LifecycleCoordinator = {
    add(element, record) {
      const target = element as RuntimeElement;
      const previous = target[lifecycleKey];
      if (previous === record) return;
      previous?.disconnect?.();
      if (previous === undefined) size += 1;
      target[lifecycleKey] = record;
      synchronize(element);
    },
    remove(element, record) {
      const target = element as RuntimeElement;
      if (target[lifecycleKey] !== record) return;
      record.disconnect?.();
      delete target[lifecycleKey];
      size -= 1;
      if (size === 0) {
        stopObservation();
        delete state.lifecycle;
      }
    },
  };
  state.lifecycle = coordinator;
  return coordinator;
}

/**
 * Gives generated Vanilla roots native-like connection lifecycle without installing one
 * observer per instance. Runtime copies in the same realm share one coordinator per document.
 */
export function manageComponentLifecycle(
  element: Element,
  definition: ComponentDefinition,
  options: ComponentAttachmentOptions = {},
): () => void {
  const coordinator = coordinatorFor(element.ownerDocument);
  const record: ManagedComponentLifecycle = {
    connect: (current) => attachComponent(current, definition, options),
    disconnect: undefined,
  };
  coordinator.add(element, record);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    coordinator.remove(element, record);
  };
}

/** Registers already parsed package definitions without manufacturing live `<template>` nodes. */
export function registerComponentDefinitions(
  definitions: readonly ComponentDefinition[],
  root: Document = document,
): void {
  const registry = registryFor(root);
  for (const definition of definitions) {
    const existing = registry.definitions.get(definition.contract.tag);
    if (existing !== undefined) {
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
        fail("HR001", `More than one definition declares <${definition.contract.tag}>.`);
      }
      continue;
    }
    registerDefinition(registry, definition.contract.tag, {
      definition,
      style: undefined,
    });
    if (definition.css !== "") {
      const style = root.createElement("style");
      style.textContent = compileStyles(definition.css, definition, root);
      root.head.append(style);
    }
  }
}


/**
 * Framework-host adapter. The framework emits the declared native root and owns its outer
 * lifetime; this function adopts that root into the same runtime used by live HTML.
 */
export function attachComponent(
  element: Element,
  definition: ComponentDefinition,
  options: ComponentAttachmentOptions = {},
): () => void {
  const root = element.ownerDocument;
  const registry = registryFor(root);
  const existing = registry.definitions.get(definition.contract.tag);
  if (existing === undefined) {
    registerDefinition(registry, definition.contract.tag, {
      definition,
      style: undefined,
    });
  } else if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
    fail("HR001", `More than one definition declares <${definition.contract.tag}>.`);
  }

  // Server-rendered roots are claimed by whichever arrives first. When document observation hydrated
  // this root before its framework attached, the framework takes it over: hydration leaves the DOM
  // as rendered, so the observer's instance (and its controller) is released and the root is
  // re-attached as framework-owned.
  const observed = runtimeInstance(element);
  if (observed !== undefined && !observed.frameworkOwned) {
    documentState(root).release?.(element);
    disconnectRuntimeInstance(observed);
    runtimeInstances.delete(element);
  }
  const instance = runtimeInstance(element);
  if (instance === undefined) {
    const projected = (options.projected ?? []).map(([node]) => node);
    const projectedSlotNames = new WeakMap<Node, string>();
    for (const [node, slot] of options.projected ?? []) {
      projectedSlotNames.set(node, slot);
      markProjectedRoot(node);
    }
    addAttributeToken(element, COMPONENT_ATTRIBUTE, definition.contract.tag);
    // The framework's explicit props become the same data-* attributes hydration reads; defaults
    // stay implicit, exactly as for HTML authors.
    for (const [name, prop] of Object.entries(definition.contract.props)) {
      const value = options.props?.[name];
      if (value !== undefined && value !== null) element.setAttribute(`data-${kebabCase(name)}`, serializeTypedValue(value, prop.type));
    }
    commitRuntimeInvocations(registry, [
      prepareRuntimeInvocation(element, definition, true, projected, projectedSlotNames, true),
    ]);
  }

  const attached = runtimeInstance(element);
  if (attached === undefined) fail("HR005", `Could not attach <${definition.contract.tag}> to its native root.`);
  updateComponentProps(element, options.props ?? {});
  connectRuntimeInstance(attached);

  let controllerCleanup: void | (() => void);
  let disposed = false;
  if (options.controller !== undefined) {
    const module = Promise.resolve(options.controller);
    setControllerModule(element, module);
    void Promise.resolve(options.controller.default(getComponentHost(element)!)).then((cleanup) => {
      if (typeof cleanup !== "function") return;
      if (disposed) cleanup();
      else controllerCleanup = cleanup;
    });
  }
  return () => {
    if (disposed) return;
    disposed = true;
    controllerCleanup?.();
    disconnectRuntimeInstance(attached);
  };
}

/**
 * The framework-adapter prop channel. A framework's props are the equivalent of authored
 * attributes: each defined value becomes explicit (and is reflected as `data-<name>`), and
 * `undefined` returns the prop to its implicit default. This is not a page-authoring API.
 */
export function updateComponentProps(
  element: Element,
  props: Readonly<Record<string, unknown>>,
): void {
  const instance = runtimeInstance(element);
  if (instance === undefined) return;
  for (const [name, input] of Object.entries(props)) {
    const prop = instance.definition.contract.props[name];
    if (prop === undefined) continue;
    const attributeName = `data-${kebabCase(name)}`;
    const value = assignedPropValue(name, prop, input);
    // Null has no attribute form: like undefined, it leaves no explicit data-* attribute.
    if (input === undefined || input === null) {
      instance.explicit.delete(name);
      // An attribute the template binds is its own output (it shows the default); leave it be.
      const bound = instance.definition.template.attributes.some((binding) =>
        binding.kind === "attribute" && binding.name === attributeName
      );
      if (!bound) element.removeAttribute(attributeName);
    } else {
      instance.explicit.add(name);
      element.setAttribute(attributeName, serializeTypedValue(input, prop.type));
    }
    if (!Object.is(instance.scope.get(name), value)) instance.scope.set(name, value);
  }
}

/**
 * Capabilities owned by one component instance. Properties and methods are receiver-independent,
 * so controllers may destructure only the capabilities they use in their parameter list.
 */
export interface ComponentHost {
  readonly element: Element;
  readonly state: Record<string, unknown>;
  readonly refs: Readonly<Record<string, Element>>;
  readonly elements: Record<string, Element | RadioNodeList | undefined>;
  /**
   * Creates controller-local writable state. Equal writes use `Object.is` and do not notify
   * consumers. The value is private to controller code unless an effect copies it into a declared
   * state root.
   */
  signal<T>(initialValue: T): ControllerSignal<T>;
  /**
   * Creates a lazy, cached derived value. The callback must return its value synchronously and
   * dynamically tracks the signals, computed values, and host state paths it reads. Returning a
   * Promise is unsupported: the Promise itself would be cached and reads after `await` cannot be
   * dependencies. Put asynchronous work in an effect instead.
   */
  computed<T>(compute: () => T): ControllerComputed<T>;
  /**
   * Runs a lifecycle-owned reaction and reruns it after a tracked read changes. A returned cleanup
   * runs before the next execution and when the component disconnects.
   */
  effect(run: () => void | (() => void)): () => void;
  on(event: string, listener: EventListener): () => void;
  dispatch(event: string, detail?: unknown): boolean;
}

export interface ControllerComputed<T> {
  /** Evaluates on first demand, then returns the cached value until a dependency changes. */
  get(): T;
}

export interface ControllerSignal<T> extends ControllerComputed<T> {
  /** Replaces the value, notifying consumers only when it is not `Object.is`-equal. */
  set(value: T): void;
  /** Computes and writes the next value from the current value. */
  update(update: (value: T) => T): void;
}

function connectRuntimeInstance(instance: RuntimeInstance): void {
  if (instance.connected) return;
  instance.connected = true;
  for (const effect of instance.effects) effect.resume();
  for (const callback of instance.connectCallbacks) callback();
  instance.element?.dispatchEvent(new Event("connect"));
}

function disconnectRuntimeInstance(instance: RuntimeInstance): void {
  if (!instance.connected) return;
  instance.element?.dispatchEvent(new Event("disconnect"));
  for (const callback of instance.disconnectCallbacks) callback();
  instance.connected = false;
  for (const effect of instance.effects) effect.pause();
}

/** Returns the private lifecycle host for a lowered root; page code normally never needs it. */
export function getComponentHost(element: Element): ComponentHost | undefined {
  const instance = runtimeInstance(element);
  if (instance === undefined) return undefined;
  if (instance.host !== undefined) return instance.host;
  const writable = new Set(
    (instance.definition.declarations ?? [])
      .filter((declaration) => declaration.kind === "state")
      .map((declaration) => declaration.name),
  );
  const state = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      const value = instance.scope.get(key);
      return value === ABSENT ? undefined : value;
    },
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
    signal(initialValue) {
      return createSignal(initialValue);
    },
    computed(compute) {
      const computed = createComputed(instance.scope.scheduler, compute);
      // A controller may finish asynchronous setup after its element disconnects. Keep any
      // owner created during that gap dormant, and put computed owners before effects so every
      // derived value can track normally when the instance reconnects.
      if (!instance.connected) computed.pause();
      instance.effects.unshift(computed);
      return computed;
    },
    effect(run) {
      const effect = createEffect(instance.scope.scheduler, run, 2, instance.connected);
      instance.effects.push(effect);
      return () => effect.stop();
    },
    on(event, listener) {
      if (event === "connect") {
        const callback = listener as () => void;
        instance.connectCallbacks.add(callback);
        if (instance.connected) (listener as () => void)();
        return () => instance.connectCallbacks.delete(callback);
      }
      if (event === "disconnect") {
        const callback = listener as () => void;
        instance.disconnectCallbacks.add(callback);
        return () => instance.disconnectCallbacks.delete(callback);
      }
      element.addEventListener(event, listener);
      return () => element.removeEventListener(event, listener);
    },
    dispatch(event, detail) {
      return dispatchComponentEvent(element, event, detail, eventDeclaration(instance.definition, event));
    },
  };
  instance.host = Object.freeze(host);
  return instance.host;
}

/** Supplies the already application-approved controller module to a lowered instance. */
export function setControllerModule(
  element: Element,
  module: Promise<ControllerModule>,
): void {
  const instance = runtimeInstance(element);
  if (instance === undefined) fail("HJ003", "A controller can attach only to a lowered component root.");
  instance.controllerModule = module;
}

export interface DocumentObservationOptions {
  /**
   * Return false to leave a discovered invocation or hydration root unlowered. Framework ownership
   * needs no filter: a framework attachment claims its root in either order.
   */
  readonly shouldLower?: (
    element: Element,
    definition: ComponentDefinition,
    hydration: boolean,
  ) => boolean;
  /** Runtime lifecycle integration; the returned disposer runs on removal or stop. */
  readonly onConnect?: (element: Element, definition: ComponentDefinition) => void | (() => void);
  readonly onError?: (error: unknown) => void;
}

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
  const state = documentState(root);
  if (state.observer !== undefined) fail("HR003", "This document is already being observed.");
  const connected = new Map<Element, void | (() => void)>();
  const report = options.onError ?? ((error: unknown) => console.error(error));
  let stopped = false;
  const disconnect = (element: Element): void => {
    const dispose = connected.get(element);
    connected.delete(element);
    const instance = runtimeInstance(element);
    if (instance !== undefined) disconnectRuntimeInstance(instance);
    try { dispose?.(); } catch (error) { report(error); }
  };
  const connect = (element: Element): void => {
    const instance = runtimeInstance(element);
    if (instance === undefined || instance.frameworkOwned || connected.has(element) || !root.contains(element)) return;
    // Record first so callback mutations cannot connect an instance twice.
    connected.set(element, undefined);
    try {
      connectRuntimeInstance(instance);
      const dispose = options.onConnect?.(element, instance.definition);
      if (stopped) dispose?.();
      else connected.set(element, dispose);
    } catch (error) { report(error); }
  };
  const synchronize = (mutations?: readonly MutationRecord[]): void => {
    if (stopped) return;
    const scopes: QueryRoot[] = [];
    if (mutations === undefined) {
      scopes.push(root);
    } else {
      const removed: Element[] = [];
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;
          visitComponentRoots(node as QueryRoot, (element) => {
            if (connected.has(element)) removed.push(element);
          });
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          scopes.push(node as QueryRoot);
        }
      }
      for (const element of removed) if (!root.contains(element)) disconnect(element);
    }
    if (scopes.length > 0) {
      try {
        for (const element of lowerScopes(root, scopes, options.shouldLower).roots) {
          if (stopped) break;
          connect(element);
        }
      } catch (error) { report(error); }
    }
  };
  state.release = (element) => {
    if (connected.has(element)) disconnect(element);
  };
  const stopObservation = subscribeDocumentMutations(root, synchronize);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopObservation();
    delete state.observer;
    delete state.release;
    for (const dispose of connected.values()) {
      try { dispose?.(); } catch (error) { report(error); }
    }
    for (const element of connected.keys()) {
      const instance = runtimeInstance(element);
      if (instance !== undefined) disconnectRuntimeInstance(instance);
    }
    connected.clear();
  };
  state.observer = stop;
  synchronize();
  return stop;
}
