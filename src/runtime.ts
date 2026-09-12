import { parseBrowserComponent } from "./browser-source.js";
import type { ControllerModule } from "./controller.js";
import { DataResource } from "./data.js";
import { fail } from "./diagnostics.js";
import { enhanceForm } from "./forms.js";
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
import { kebabCase } from "./names.js";
import { createEffect, ReactiveScope, type ReactiveEffect } from "./reactivity.js";
import { hasExecutableUrl, isUrlAttribute, sanitizeFragment } from "./sanitize.js";
import {
  componentStyleMode,
  markProjectedRoot,
  stampAuthoredElement,
  stampComponentRoot,
  transformComponentStyles,
} from "./style.js";
import { isPropertyOnlyType, parseTypeExpression, parseTypedValue, serializeTypedValue } from "./type-system.js";
import {
  manageElementValidity,
} from "./validity.js";
import type { Constraint } from "./validate.js";
import type {
  ComponentDefinition,
  DataDeclaration,
  DirectiveAttribute,
  ElementNode,
  Flow,
  FormDeclaration,
  HandlerDeclaration,
  HandlerStep,
  SlotNode,
  TemplateNode,
  TextNode,
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
  readonly effects: ReactiveEffect[];
  readonly connectCallbacks: Set<() => void>;
  readonly disconnectCallbacks: Set<() => void>;
  connected: boolean;
  controllerModule?: Promise<ControllerModule>;
}

interface DocumentRegistry {
  readonly definitions: Map<string, LiveDefinition>;
  readonly instances: WeakMap<Element, ComponentDefinition>;
}

const registries = new WeakMap<Document, DocumentRegistry>();
const contentOnly = new WeakSet<Element>();
const runtimeInstances = new WeakMap<Element, RuntimeInstance>();
const frameworkProjectedNodes = new WeakMap<Element, readonly Node[]>();

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
      style.textContent = transformComponentStyles(node.definition.css, tag, {
        mode: componentStyleMode(root),
        rootElement: node.definition.template.name,
      });
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

function invocationValue(prop: PropContract, input: unknown, attributePresent = false): PropValue {
  const candidate = prop.type === "boolean" && attributePresent ? true : input;
  const parsed = parseTypedValue(candidate, prop.type);
  if (!parsed.ok) {
    const detail = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    fail("HR002", `A prop invocation value does not satisfy its declared type. ${detail}`);
  }
  return parsed.value as PropValue;
}

function readInvocation(
  invocation: Element,
  definition: ComponentDefinition,
  hydration = false,
): {
  readonly scope: ReactiveScope;
  readonly passThrough: readonly Attr[];
  readonly effects: ReactiveEffect[];
  readonly rootName: string;
} {
  const contract = definition.contract;
  const names = new Map<string, string>();
  for (const name of Object.keys(contract.props)) {
    const attributeName = kebabCase(name);
    names.set(hydration ? `data-${attributeName}` : attributeName, name);
    // Adopt output emitted by pre-kebab-case versions without making that spelling
    // part of the author-facing contract.
    if (hydration && attributeName !== name.toLowerCase()) {
      names.set(`data-${name.toLowerCase()}`, name);
    }
  }

  const values: Record<string, PropValue | undefined> = {};
  const passThrough: Attr[] = [];
  let requestedRoot: string | undefined;
  for (const attribute of Array.from(invocation.attributes)) {
    if (attribute.name.toLowerCase() === "as" && definition.root?.kind === "native") {
      requestedRoot = attribute.value.toLowerCase();
      continue;
    }
    const propName = names.get(attribute.name.toLowerCase());
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

  for (const [name, prop] of Object.entries(contract.props)) {
    if (values[name] !== undefined) continue;
    const propertyValue = (invocation as unknown as Record<string, unknown>)[name];
    if (propertyValue !== undefined) values[name] = invocationValue(prop, propertyValue);
  }

  const scope = new ReactiveScope();
  for (const [name, prop] of Object.entries(contract.props)) {
    if (prop.required && values[name] === undefined) {
      fail("HC020", `Required prop \`${name}\` was not provided.`);
    }
    // The effective value seen by expressions: passed value, default, or first-class absence.
    scope.set(name, (values[name] !== undefined ? values[name]! : prop.default) as Value);
  }

  const declarations = definition.declarations ?? [];
  for (const declaration of declarations) {
    if (
      declaration.kind === "state" || declaration.kind === "computed" ||
      declaration.kind === "data" || declaration.kind === "form"
    ) scope.set(declaration.name, null);
  }
  for (const declaration of declarations) {
    if (declaration.kind === "data") {
      scope.set(declaration.name, { pending: true, value: null, error: null, ok: false });
    } else if (declaration.kind === "form") {
      scope.set(declaration.name, { pending: false, value: null, error: null, ok: false });
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
      ...(data.schema === undefined || /^(?:\.?\.?\/|\/|[A-Za-z][A-Za-z+.-]*:)/.test(data.schema)
        ? {}
        : { schema: data.schema }),
      ...(data.schema !== undefined && /^(?:\.?\.?\/|\/|[A-Za-z][A-Za-z+.-]*:)/.test(data.schema)
        ? { schemaURL: new URL(data.schema, definitionBase).href }
        : {}),
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
  return { scope, passThrough, effects, rootName };
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
  readonly connectCallbacks: Set<() => void>;
  readonly disconnectCallbacks: Set<() => void>;
  root?: Element;
  readonly projectedNodes: readonly Node[];
  readonly slotInsertions: SlotInsertion[];
  readonly rootName: string;
  committed: boolean;
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
      const declaration = (context.definition.declarations ?? []).find(
        (candidate) => candidate.kind === "event" && candidate.name === step.event,
      );
      const detail = step.value === undefined ? undefined : evaluateCompiled(step.value, scope);
      if (declaration?.kind === "event" && detail !== undefined) {
        const parsed = parseTypedValue(detail, parseTypeExpression(declaration.type));
        if (!parsed.ok) fail("HR002", `Event \`${step.event}\` detail does not satisfy its declared type.`);
      }
      (context.root ?? element).dispatchEvent(new CustomEvent(step.event, {
        detail,
        bubbles: declaration?.kind === "event" ? declaration.bubbles : true,
        composed: declaration?.kind === "event" ? declaration.composed : true,
        cancelable: declaration?.kind === "event" ? declaration.cancelable : false,
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

function bindEnhancedForm(
  element: Element,
  node: ElementNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
): void {
  if (!(element instanceof HTMLFormElement) || node.name !== "form") return;
  const name = node.attributes.find(
    (attribute) => attribute.kind === "literal" && attribute.name === "name",
  );
  if (name?.kind !== "literal") return;
  const declaration = (context.definition.declarations ?? []).find(
    (candidate): candidate is FormDeclaration =>
      candidate.kind === "form" && candidate.name === name.value,
  );
  if (declaration === undefined) return;
  ownEffect(context, scope, () => enhanceForm(element, {
    source: declaration.source,
    parameters: () => Object.fromEntries(
      declaration.parameters.map((parameter) => [
        parameter.name,
        evaluateCompiled(parameter.expression, scope),
      ]),
    ),
    onState: (state) => scope.set(declaration.name, state as unknown as Value),
  }), 2);
}

function setAttribute(element: Element, name: string, value: string | null): void {
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
    return renderDynamicNode(node, scope, document, passThrough, context);
  }
  const out: Node[] = [];
  for (const childScope of expandFlow(node.flow, scope)) {
    out.push(...renderInstance(node, childScope, document, passThrough, context, candidate));
  }
  return out;
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
  const wrapper = document.createElement(node.name);
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") wrapper.setAttribute(attribute.name, attribute.value);
  }
  wrapper.append(...rendered);
  stampAuthoredElement(wrapper, context.definition.contract.tag);
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
  const adopted = candidate instanceof Element && candidate.localName === elementName;
  const element = adopted ? candidate : document.createElement(elementName);
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
  stampAuthoredElement(element, context.definition.contract.tag);

  if (contentDirective !== undefined) {
    ownEffect(context, scope, () => applyContent(element, contentDirective, scope, document));
    bindEvents(element, node, scope, context);
    return [element];
  }

  const renderedChildren: Node[] = [];
  let cursor = 0;
  for (const child of node.children) {
    const rendered = renderTemplateNode(child, scope, document, context, existingChildren[cursor]);
    renderedChildren.push(...rendered);
    cursor += rendered.length;
  }
  if (adopted) {
    for (let index = 0; index < renderedChildren.length; index += 1) {
      const expected = renderedChildren[index]!;
      if (element.childNodes[index] !== expected) {
        element.insertBefore(expected, element.childNodes[index] ?? null);
      }
    }
    while (element.childNodes.length > renderedChildren.length) element.lastChild!.remove();
  } else {
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
  bindEnhancedForm(element, node, scope, context);
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

function projectedSlotName(node: Node): string {
  return node instanceof Element ? node.getAttribute("slot") ?? "" : "";
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
  const assigned = context.projectedNodes.filter((candidate) => projectedSlotName(candidate) === name);
  if (assigned.length === 0) return renderChildren(node.fallback ?? [], scope, document, context);
  if (context.committed) {
    for (const candidate of assigned) markProjectedRoot(candidate);
    return [...assigned];
  }
  const anchor = document.createComment(`html-next:slot:${name}`);
  context.slotInsertions.push({ anchor, nodes: assigned });
  return [anchor];
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

const VALIDITY_ATTRIBUTES = new Set([
  "type", "required", "multiple", "min", "max", "minlength", "maxlength", "pattern", "step",
]);

function nativeValidatableElement(element: Element): boolean {
  return "validity" in element && typeof (element as { checkValidity?: unknown }).checkValidity === "function";
}

function numberConstraint(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function constraintFromElement(element: Element): Constraint {
  const type = element.getAttribute("type") ?? undefined;
  const min = element.getAttribute("min") ?? undefined;
  const max = element.getAttribute("max") ?? undefined;
  const stepValue = element.getAttribute("step");
  const step = stepValue === "any" ? "any" : numberConstraint(element, "step");
  return {
    ...(type === undefined ? {} : { type }),
    ...(element.hasAttribute("required") ? { required: true } : {}),
    ...(element.hasAttribute("multiple") ? { multiple: true } : {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(numberConstraint(element, "minlength") === undefined
      ? {}
      : { minLength: numberConstraint(element, "minlength")! }),
    ...(numberConstraint(element, "maxlength") === undefined
      ? {}
      : { maxLength: numberConstraint(element, "maxlength")! }),
    ...(element.getAttribute("pattern") === null ? {} : { pattern: element.getAttribute("pattern")! }),
    ...(step === undefined ? {} : { step }),
  };
}

function installInstanceValidity(root: Element, instance: RuntimeInstance): void {
  let cleanups: Array<() => void> = [];
  const connect = (): void => {
    if (cleanups.length > 0) return;
    const elements = [root, ...Array.from(root.querySelectorAll("*"))];
    for (const element of elements) {
      const native = nativeValidatableElement(element);
      const generalized = Array.from(element.attributes).some((attribute) =>
        VALIDITY_ATTRIBUTES.has(attribute.name.toLowerCase()),
      );
      if (!native && !generalized) continue;
      cleanups.push(manageElementValidity(element, native ? {} : constraintFromElement(element)));
    }
  };
  const disconnect = (): void => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
  };
  instance.connectCallbacks.add(connect);
  instance.disconnectCallbacks.add(disconnect);
}

function installPublicProps(root: Element, instance: RuntimeInstance): void {
  const props = instance.definition.contract.props;
  const attributeNames = new Map(
    Object.entries(props).filter(([, prop]) => !isPropertyOnlyType(prop.type))
      .map(([name]) => [`data-${kebabCase(name)}`, name]),
  );
  const reflected = new Set<string>();

  for (const [name, prop] of Object.entries(props)) {
    Object.defineProperty(root, name, {
      configurable: true,
      enumerable: true,
      get: () => instance.scope.get(name),
      set: (input: unknown) => instance.scope.set(name, invocationValue(prop, input) as Value),
    });
    if (isPropertyOnlyType(prop.type)) continue;
    const attributeName = `data-${kebabCase(name)}`;
    instance.effects.push(createEffect(instance.scope.scheduler, () => {
      const value = instance.scope.get(name);
      reflected.add(attributeName);
      if (value === undefined) root.removeAttribute(attributeName);
      else root.setAttribute(attributeName, serializeTypedValue(value, prop.type));
      queueMicrotask(() => reflected.delete(attributeName));
    }, 2));
  }

  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  if (Observer === undefined || attributeNames.size === 0) return;
  const observer = new Observer((records) => {
    for (const record of records) {
      const attributeName = record.attributeName;
      if (attributeName === null || reflected.has(attributeName)) continue;
      const name = attributeNames.get(attributeName);
      if (name === undefined) continue;
      const prop = props[name]!;
      const value = root.getAttribute(attributeName);
      instance.scope.set(name, invocationValue(prop, value ?? undefined, value !== null) as Value);
    }
  });
  const connect = (): void => observer.observe(root, {
    attributes: true,
    attributeFilter: [...attributeNames.keys()],
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
    const invocations = Array.from(root.querySelectorAll(definition.contract.tag)).map(
      (invocation) => ({ invocation, hydration: false }),
    );
    const hydrationRoots = Array.from(
      root.querySelectorAll(`[data-component-root~="${definition.contract.tag}"]`),
    ).filter((element) => !runtimeInstances.has(element)).map(
      (invocation) => ({ invocation, hydration: true }),
    );
    for (const { invocation, hydration } of [...invocations, ...hydrationRoots]) {
      if (contentOnly.has(invocation)) continue;
      const focusedControl = hydration && invocation.contains(invocation.ownerDocument.activeElement)
        ? invocation.ownerDocument.activeElement
        : null;
      const focusedSelection = focusedControl instanceof HTMLInputElement || focusedControl instanceof HTMLTextAreaElement
        ? [focusedControl.selectionStart, focusedControl.selectionEnd] as const
        : undefined;
      const { scope, passThrough, effects, rootName } = readInvocation(invocation, definition, hydration);
      const children = hydration
        ? [...(frameworkProjectedNodes.get(invocation) ?? invocation.querySelectorAll("[data-slotted]"))]
        : Array.from(invocation.childNodes);
      const instance: RuntimeInstance = {
        definition,
        scope,
        refs: {},
        effects,
        connectCallbacks: new Set(),
        disconnectCallbacks: new Set(),
        connected: false,
      };
      const context: RuntimeRenderContext = {
        definition,
        effects,
        refs: instance.refs,
        connectCallbacks: instance.connectCallbacks,
        disconnectCallbacks: instance.disconnectCallbacks,
        projectedNodes: children,
        slotInsertions: [],
        rootName,
        committed: hydration,
      };
      const rendered = renderNode(
        definition.template,
        scope,
        invocation.ownerDocument,
        passThrough,
        context,
        hydration ? invocation : undefined,
      );
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
      stampComponentRoot(nativeRoot, definition.contract.tag);
      instance.element = nativeRoot;
      prepared.push({
        invocation,
        nativeRoot,
        context,
        definition,
        instance,
        replace: !hydration,
      });
    }
  }

  for (const live of definitions) {
    registry.definitions.set(live.definition.contract.tag, live);
    if (live.style !== undefined) {
      live.style.textContent = transformComponentStyles(
        live.style.textContent ?? "",
        live.definition.contract.tag,
        {
          mode: componentStyleMode(live.wrapper!.ownerDocument),
          rootElement: live.definition.template.name,
        },
      );
      live.wrapper!.ownerDocument.head.append(live.style);
    }
    live.wrapper!.remove();
  }

  // A projected component invocation can be nested inside another invocation in the
  // authored document. Commit ancestors first so their slot insertion moves the live
  // invocation; the descendant can then replace itself at that new location. Definition
  // discovery order must not decide whether nested authored components survive.
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
    registry.instances.set(invocation.nativeRoot, invocation.definition);
    runtimeInstances.set(invocation.nativeRoot, invocation.instance);
    frameworkProjectedNodes.delete(invocation.nativeRoot);
    installPublicProps(invocation.nativeRoot, invocation.instance);
    installPublicMethods(invocation.nativeRoot, invocation.instance);
    installInstanceValidity(invocation.nativeRoot, invocation.instance);
    connectRuntimeInstance(invocation.instance);
  }
  return prepared.length;
}

export interface ComponentAttachmentOptions {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly controller?: ControllerModule;
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
    registry.definitions.set(definition.contract.tag, {
      definition,
      decls: runtimeDeclarations(definition),
      style: undefined,
    });
    if (definition.css !== "") {
      const style = root.createElement("style");
      style.dataset.htmlNextPackage = definition.contract.tag;
      style.textContent = transformComponentStyles(definition.css, definition.contract.tag, {
        mode: componentStyleMode(root),
        rootElement: definition.template.name,
      });
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
    registry.definitions.set(definition.contract.tag, {
      definition,
      decls: runtimeDeclarations(definition),
      style: undefined,
    });
  } else if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
    fail("HR001", `More than one definition declares <${definition.contract.tag}>.`);
  }

  const instance = runtimeInstances.get(element);
  if (instance === undefined) {
    const projected: Node[] = [];
    const markFrameworkProjection = (parent: Element, authored: ElementNode): void => {
      const literalText = authored.children.filter((child): child is TextNode => child.kind === "text")
        .map((child) => child.value);
      let literalCursor = 0;
      const authoredElements = authored.children.filter((child): child is ElementNode => child.kind === "element");
      let elementCursor = 0;
      for (const child of Array.from(parent.childNodes)) {
        if (child instanceof Element) {
          const lineage = child.getAttribute("data-component")?.split(/\s+/) ?? [];
          if (!lineage.includes(definition.contract.tag)) {
            markProjectedRoot(child);
            projected.push(child);
          } else {
            while (
              elementCursor < authoredElements.length &&
              authoredElements[elementCursor]!.name !== child.localName
            ) elementCursor += 1;
            const authoredChild = authoredElements[elementCursor++];
            if (authoredChild !== undefined) markFrameworkProjection(child, authoredChild);
          }
          continue;
        }
        if (child instanceof Text && child.data.trim() !== "") {
          while (literalCursor < literalText.length && literalText[literalCursor] !== child.data) literalCursor += 1;
          if (literalCursor < literalText.length) literalCursor += 1;
          else projected.push(child);
        }
      }
    };
    markFrameworkProjection(element, definition.template);
    frameworkProjectedNodes.set(element, Object.freeze(projected));
    stampAuthoredElement(element, definition.contract.tag);
    stampComponentRoot(element, definition.contract.tag);
    for (const [name, prop] of Object.entries(definition.contract.props)) {
      const value = options.props?.[name] ?? prop.default;
      if (value !== undefined) {
        (element as unknown as Record<string, unknown>)[name] = value;
        if (!isPropertyOnlyType(prop.type)) {
          element.setAttribute(`data-${kebabCase(name)}`, serializeTypedValue(value, prop.type));
        }
      }
    }
    lowerDocument(root);
  }

  const attached = runtimeInstances.get(element);
  if (attached === undefined) fail("HR005", `Could not attach <${definition.contract.tag}> to its native root.`);
  for (const [name, value] of Object.entries(options.props ?? {})) {
    if (name in definition.contract.props) (element as unknown as Record<string, unknown>)[name] = value;
  }

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

/** Supplies the already application-approved controller module to a lowered instance. */
export function setControllerModule(
  element: Element,
  module: Promise<ControllerModule>,
): void {
  const instance = runtimeInstances.get(element);
  if (instance === undefined) fail("HJ003", "A controller can attach only to a lowered component root.");
  instance.controllerModule = module;
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
