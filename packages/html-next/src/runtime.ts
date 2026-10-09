import type { ControllerModule } from "./controller.js";
import { selectedPropType } from "./contract.js";
import { declaredExpressionType, declareLayerTypes, declaredTypeAt, declareTypes } from "./declared-types.js";
import { DataResource } from "./data.js";
import { parseDuration } from "./duration.js";
import { fail } from "./diagnostics.js";
import { applyBoundControlValue, controlValue } from "./controls.js";
import { eventPasses } from "./event-filter.js";
import { isNativeEvent } from "./freeze.js";
import { decodeHydrationValue, encodeHydrationValue } from "./hydration-value.js";
import type { ComponentGraph } from "./graph.js";
import {
  ABSENT,
  NONCONFORMING,
  UndeclaredName,
  compileExpression,
  evaluate,
  type CompiledExpression,
  type ExpressionNode,
  evaluateCompiled,
  toAttribute,
  toText,
  typeCheckedDependencies,
  truthy,
  type Scope,
  type Value,
} from "./expression.js";
import { kebabCase } from "./names.js";
import { documentParsesInstructions, renderedFormMark } from "./rendered-form.js";
import { assignedPropValue, conformsAtDestination, conformsAtReference, invocationValue, reflectedPropValue } from "./prop-values.js";
import { keyedEquality, visitSelected } from "./selection.js";
import {
  createComputed,
  createEffect,
  createSignal,
  ReactiveScope,
  readItems,
  readKey,
  registerReactiveAlias,
  untracked,
  type ReactiveEffect,
  type ReactiveOwner,
  type ReactiveSignal,
} from "./reactivity.js";
import { hasExecutableUrl, isContentOnly, isUrlAttribute, markContentOnly, sanitizeFragment } from "./sanitize.js";
import {
  addAttributeToken,
  COMPONENT_ATTRIBUTE,
  compileComponentStyles,
  type CompiledComponentStyles,
  markProjectedRoot,
  stateAttribute,
  stateAttributeValue,
} from "./component-styles.js";
import {
  declarationTypeNode,
  formatType,
  parseTypedValue,
  type TypeNode,
} from "./type-system.js";
import type {
  AttributeBinding,
  ComponentDefinition,
  DataDeclaration,
  DirectiveAttribute,
  ElementNode,
  EventDeclaration,
  Flow,
  HandlerDeclaration,
  LiteralAttribute,
  PropertyBinding,
  SlotNode,
  TemplateNode,
  TextNode,
} from "./template.js";
import { definitionMayInvokeComponents, elementMatchRoot, iteratedRefNames, rootArms } from "./template.js";
import type { WritablePath } from "./expression.js";
import type { ComponentContract, PropValue } from "./types.js";
import { validateComponentProps, type Validity } from "./validate.js";
import { manageDerivedValidity, setElementValidity, validityState, type GeneralizedValidityState } from "./validity.js";

interface LiveDefinition {
  readonly wrapper?: Element;
  readonly style: HTMLStyleElement | HTMLLinkElement | undefined;
  readonly definition: ComponentDefinition;
}

interface PreparedInvocation {
  readonly invocation: Element;
  readonly nativeRoot: Element;
  readonly context: RuntimeRenderContext;
  readonly definition: ComponentDefinition;
  readonly instance: RuntimeInstance;
  readonly replace: boolean;
  /**
   * The element this instance ends up rooted at. It differs from `nativeRoot` for a delegated
   * root, whose rendered root is another component's invocation that lowers to its own root.
   */
  host?: Element;
}

interface SlotInsertion {
  readonly anchor: Comment;
  readonly nodes: readonly Node[];
}

/**
 * Records the projected nodes a freshly prepared invocation renders in no slot. The components
 * inside them are not instantiated by the same pass: they wait, like a branch whose condition is
 * not met, until a slot renders them and lowering finds them in the document. Hidden content costs
 * no instance, no bindings and no nested lowering.
 */
function recordUnrendered(invocation: PreparedInvocation, unrendered: Set<Node>): void {
  const placed = new Set(invocation.context.slotInsertions.flatMap((insertion) => insertion.nodes));
  for (const node of invocation.context.projectedNodes) if (!placed.has(node)) unrendered.add(node);
}

/** Whether `element` sits in projected content no slot renders yet (see `recordUnrendered`). */
function withinUnrendered(element: Element, unrendered: ReadonlySet<Node>): boolean {
  if (unrendered.size === 0) return false;
  for (let node: Node | null = element; node !== null; node = node.parentNode) if (unrendered.has(node)) return true;
  return false;
}

interface PropInput {
  readonly value: unknown;
  readonly source: "html" | "value";
  readonly present: boolean;
}

interface RuntimeInstance {
  controllerInitialized?: boolean;
  element?: Element;
  /** Stable component ownership, captured when invoked rather than inferred from later DOM position. */
  readonly parent?: RuntimeInstance;
  readonly definition: ComponentDefinition;
  readonly scope: ReactiveScope;
  /** Latest direct input for each prop, kept apart from the accepted value in scope. */
  readonly propInputs: Readonly<Record<string, ReactiveSignal<PropInput>>>;
  readonly refs: Record<string, Element | Element[]>;
  readonly effects: ReactiveOwner[];
  connected: boolean;
  host?: ComponentHost;
  /** Props the author supplied. Only these are reflected; defaults never are. */
  readonly explicit: Set<string>;
  /** A framework renders this root; document observation never manages it. */
  readonly frameworkOwned: boolean;
  /** The definition's root element, or the root `$match` arm this instance chose. */
  rootNode: ElementNode;
  /** The root element in the document; effects tied to the root read it, so they follow a replacement. */
  readonly rootElement: ReactiveSignal<Element | undefined>;
  /** Every projected node and its slot, rendered or not (for serialization). */
  projection?: {
    readonly nodes: readonly Node[];
    readonly slotNames: WeakMap<Node, string>;
    /** Puts `next` in `current`'s place, in its slot, wherever this instance records its projection. */
    readonly replace: (current: Node, next: Node) => void;
  };
  /**
   * Instances sharing this instance's root because this component delegates its root to them.
   * They are not separately discoverable, so this instance carries their lifecycle.
   */
  readonly delegates: RuntimeInstance[];
  /** What a parent bound on this component's invocation; each follows the root when it is replaced. */
  readonly followers: ((root: Element) => void)[];
  /** What the current rendering of the root owns. */
  owned: RenderOwned;
  validityCleanup?: () => void;
}

interface DocumentRegistry {
  readonly root: Element | null;
  readonly definitions: Map<string, LiveDefinition>;
  discoverySelector: string | undefined;
}

const selectValueBindings = new WeakMap<HTMLSelectElement, () => void>();
/**
 * Invocation elements a component has already replaced. A mutation batch can still name one, and
 * lowering it again would build a second instance whose own root gets discovered in turn.
 */
const supersededInvocations = new WeakSet<Element>();
/** Work a parent deferred until its child invocation lowered, keyed by that invocation. */
const rebindOnLower = new WeakMap<Element, ((root: Element) => void)[]>();

function whenLowered(invocation: Element, rebind: (root: Element) => void): void {
  const pending = rebindOnLower.get(invocation);
  if (pending === undefined) rebindOnLower.set(invocation, [rebind]);
  else pending.push(rebind);
}

/**
 * What a parent bound on a template-component invocation. Lowering discards that element, so the
 * parent binds nothing to it: these bindings act on the component that lowers in its place.
 */
interface InvocationBinding {
  readonly tag: string;
  /** A registered component's invocation: lowering replaces it, so nothing attaches to it meanwhile. */
  readonly awaitsLowering: boolean;
  component: RuntimeInstance | undefined;
  /** Run against the component's root when it lowers and again whenever that root is replaced. */
  readonly effects: ReactiveEffect[];
}
/** Bindings waiting for their component, keyed by invocation (or, when hydrating, its server root). */
const pendingInvocationBindings = new WeakMap<Element, InvocationBinding[]>();

/** The component named `tag` that already owns `root`, directly or as a delegate. */
function committedComponent(root: Element, tag: string): RuntimeInstance | undefined {
  const owner = runtimeInstances.get(root);
  return owner?.definition.contract.tag === tag
    ? owner : owner?.delegates.find((instance) => instance.definition.contract.tag === tag);
}

function followComponent(binding: InvocationBinding, component: RuntimeInstance): void {
  binding.component = component;
  component.followers.push(() => { for (const effect of binding.effects) effect.execute(); });
}

/**
 * Where bound values go. Until its component lowers, an invocation's attributes are that component's
 * inputs (a hydrating root is already the component's root); afterwards they go to its current root.
 */
function valueTarget(element: Element, invocation: InvocationBinding | undefined): Element | undefined {
  const component = invocation?.component;
  return component === undefined ? element : untracked(() => component.rootElement.get()) ?? component.element;
}

/**
 * Where listeners, properties and refs go: the root of the component an invocation became. Before
 * then, a server-rendered root or an element no registered component claims yet is itself the target.
 */
function rootTarget(element: Element, invocation: InvocationBinding | undefined): Element | undefined {
  const component = invocation?.component;
  if (component !== undefined) return untracked(() => component.rootElement.get());
  return invocation?.awaitsLowering === true ? undefined : element;
}

/** Re-run what invocations bound on a root, a delegate's bindings before those of the component it serves. */
function followRoot(owner: RuntimeInstance, root: Element): void {
  for (let index = owner.delegates.length; index >= 0; index -= 1) {
    const instance = index === 0 ? owner : owner.delegates[index - 1]!;
    for (const follow of instance.followers) follow(root);
  }
}
const runtimeInstances = new WeakMap<Element, RuntimeInstance>();
/** How deep one lowering pass follows component invocations that other components render. */
const maximumNestedLoweringPasses = 32;
const definitionAttributes = new WeakMap<ComponentDefinition, readonly [
  Readonly<Record<string, string>>,
  Readonly<Record<string, string>>,
]>();
const runtimeKey = Symbol.for("@nextwebwg/html-next.runtime.v1");
const lifecycleKey = Symbol.for("@nextwebwg/html-next.lifecycle.v1");

interface DocumentState {
  /** Static server lowering renders bindings without connecting lifecycle-owned work. */
  staticRendering?: boolean;
  registry?: DocumentRegistry;
  mutationHub?: DocumentMutationHub;
  lifecycle?: LifecycleCoordinator;
  observer?: () => void;
  /** Hands a root the observer manages over to a framework attachment. */
  release?: (element: Element) => void;
  /** Keeps a connected root connected when its element is replaced. */
  move?: (from: Element, to: Element) => void;
  /** Lowers and connects every waiting instance; set while the document is observed. */
  rescan?: () => void;
}

type RuntimeDocument = Document & { [runtimeKey]?: DocumentState };
type RuntimeElement = Element & { [lifecycleKey]?: ManagedComponentLifecycle };

function documentState(root: Document): DocumentState {
  return (root as RuntimeDocument)[runtimeKey] ??= {};
}

function runtimeInstance(element: Element): RuntimeInstance | undefined {
  return runtimeInstances.get(element);
}

/** What a compiled root registers on its lifecycle record: its state spec, raw values and host. */
interface CompiledHandle {
  readonly S: { readonly n: readonly string[]; readonly g: string; readonly k?: number };
  readonly v: readonly unknown[];
  readonly H: ComponentHost;
  /** Its props: their latest inputs and the explicit ones; values follow the state's in `v`. */
  readonly B?: {
    readonly D: { readonly props: Readonly<Record<string, unknown>> }; readonly i: Readonly<Record<string, PropInput>>; readonly x: ReadonlySet<string>;
    /** Applies props, as `updateComponentProps` applies a live instance's. */
    readonly u?: (props: Readonly<Record<string, unknown>>) => void;
  };
  /** Its projected nodes and the slot each is for. */
  readonly J?: readonly (readonly [Node, string])[];
  /** The components it delegates its root to, which share it. */
  readonly D?: readonly CompiledHandle[];
}

/** The compiled handle of a generated root, which the live runtime's instance map never holds. */
const replacedKey = Symbol.for("@nextwebwg/html-next.replaced.v1");

function compiledHandle(element: Element): CompiledHandle | undefined {
  // A root switch leaves the element a caller kept pointing at its instance.
  const handle = ((element as RuntimeElement)[lifecycleKey]?.h ?? (element as Element & { [replacedKey]?: unknown })[replacedKey]) as Partial<CompiledHandle> | undefined;
  return handle?.H === undefined ? undefined : handle as CompiledHandle;
}

/** A compiled root's record, as `instanceRecord` reports a live instance's: computeds are not state. */
function compiledRecord(handle: CompiledHandle): RenderedInstanceRecord {
  const names = Object.keys(handle.B?.D.props ?? {});
  return {
    explicit: [...handle.B?.x ?? []],
    inputs: { ...handle.B?.i },
    props: Object.fromEntries(names.map((name, index) => [name, handle.v[handle.S.n.length + index]])),
    state: Object.fromEntries(handle.S.n.slice(0, handle.S.k).map((name, index) => [name, handle.v[index] as Value])),
  };
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

/** The state names each definition's `:host-state()` rules test, recorded when its styles compile. */
const stateNamesByDefinition = new WeakMap<ComponentDefinition, readonly string[]>();

/** Only explicitly owned style nodes participate in reuse; application CSS is never inspected. */
function installComponentStyles(
  definition: ComponentDefinition,
  document: Document,
  carrier?: HTMLStyleElement,
  styleCompiler?: (css: string, definition: ComponentDefinition) => CompiledComponentStyles,
): HTMLStyleElement | HTMLLinkElement | undefined {
  const tag = definition.contract.tag;
  const existing = document.head.querySelector<HTMLStyleElement | HTMLLinkElement>(
    `style[data-html-next-component-styles~="${tag}"],link[rel="stylesheet"][data-html-next-component-styles~="${tag}"]`,
  );
  if (existing !== null) {
    const names = JSON.parse(existing.getAttribute("data-html-next-style-states") ?? "{}") as Record<string, string[]>;
    stateNamesByDefinition.set(definition, names[tag] ?? []);
    return existing;
  }
  if (definition.css === "" && carrier === undefined) return undefined;
  const style = carrier ?? document.createElement("style");
  const compiled = styleCompiler === undefined
    ? compileComponentStyles(definition.css, definition, document)
    : styleCompiler(definition.css, definition);
  stateNamesByDefinition.set(definition, compiled.stateNames);
  style.textContent = compiled.css;
  style.setAttribute("data-html-next-component-styles", tag);
  // Hydration needs this metadata without parsing or transforming the server's CSS again.
  style.setAttribute("data-html-next-style-states", JSON.stringify({ [tag]: compiled.stateNames }));
  document.head.append(style);
  return style;
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

/**
 * Parses an inline `<template component>` carrier. Only a page that authors definitions in HTML
 * needs a parser, so the live entry points install one and a build-time graph never carries it.
 */
export type InlineDefinitionParser = (carrier: Element, source: string) => ComponentDefinition;
export type ProjectedSlotParser = (
  carrier: HTMLTemplateElement,
  definition: ComponentDefinition,
  names: readonly string[],
) => readonly TemplateNode[];

let inlineDefinitionParser: InlineDefinitionParser | undefined;
let projectedSlotParser: ProjectedSlotParser | undefined;

/** Lets the live delivery teach this runtime to read definitions authored in the document. */
export function installInlineDefinitionParser(parse: InlineDefinitionParser): void {
  inlineDefinitionParser = parse;
}

/** The live delivery installs this; generated definitions never import the parser. */
export function installProjectedSlotParser(parse: ProjectedSlotParser): void {
  projectedSlotParser = parse;
}

function parseDefinition(wrapper: HTMLTemplateElement, index: number): LiveDefinition {
  const tag = wrapper.getAttribute("component") ?? "";
  const source = `${wrapper.ownerDocument.URL}#template[component="${tag}"][${index + 1}]`;
  if (wrapper.hasAttribute("src")) {
    fail("HL001", "External definitions require the application-owned graph resolver.", source);
  }
  if (inlineDefinitionParser === undefined) {
    fail(
      "HR007",
      "Reading a definition from the document requires the live delivery's parser; " +
        "a build-time graph registers already parsed definitions instead.",
      source,
    );
  }
  const definition = inlineDefinitionParser(wrapper, source);
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
    const style = installComponentStyles(node.definition, root);
    registerDefinition(registry, tag, {
      definition: node.definition,
      style,
    });
    installed += 1;
  }
  // Definitions installed into an observed document apply to the instances already waiting in it.
  if (installed > 0) documentState(root).rescan?.();
  return installed;
}

function propValidity(instance: RuntimeInstance): Validity {
  return validateComponentProps(instance.definition.contract,
    (name) => {
      const input = instance.propInputs[name]?.get();
      return input?.present ? input.value : instance.scope.get(name);
    },
    (name) => instance.scope.get(name),
    (name) => instance.propInputs[name]?.get().source ?? "value");
}

function rootPropValidity(instance: RuntimeInstance): Validity {
  if (instance.delegates.length === 0) return propValidity(instance);
  const errors = [instance, ...instance.delegates].flatMap((entry) => propValidity(entry).errors);
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
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

/** An instance's props, state, and computed values, as its expressions read them. */
function componentScope(
  definition: ComponentDefinition,
  values: Readonly<Record<string, PropValue | undefined>>,
  parent?: RuntimeInstance,
): { readonly scope: ReactiveScope; readonly effects: ReactiveOwner[] } {
  const scope = new ReactiveScope();
  declareTypes(scope, definition);
  for (const [name, prop] of Object.entries(definition.contract.props)) {
    // The effective value seen by expressions: passed value, default, or null.
    scope.set(
      name,
      (values[name] !== undefined
        ? values[name]!
        : prop.default === undefined ? null : prop.default) as Value,
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
    if (declaration.kind === "context") {
      let provider = parent;
      while (provider !== undefined && (
        provider.definition.contract.tag !== declaration.from ||
        !provider.definition.declarations?.some((candidate) =>
          candidate.kind === "state" && candidate.name === declaration.name)
      )) provider = provider.parent;
      if (provider === undefined) {
        fail("HR009", `<${definition.contract.tag}> requires context \`${declaration.name}\` from <${declaration.from}>.`);
      }
      const source = provider.scope;
      effects.push(scope.defineComputed(declaration.as ?? declaration.name, () => source.get(declaration.name)!));
      continue;
    }
    if (declaration.kind !== "computed" || declaration.expression === undefined) continue;
    effects.push(scope.defineComputed(
      declaration.name,
      () => evalConforming(declaration.expression!, scope, definition) as Value,
    ));
  }
  return { scope, effects };
}

interface IncomingProp {
  readonly value: unknown;
  readonly source: "html" | "value";
  readonly attributePresent: boolean;
}

function parseIncomingProps(
  contract: ComponentContract,
  incoming: Readonly<Record<string, IncomingProp>>,
): Record<string, PropValue | undefined> {
  const values = Object.create(null) as Record<string, PropValue | undefined>;
  for (const [name, prop] of Object.entries(contract.props)) {
    const item = incoming[name];
    if (item !== undefined && prop.select === undefined) {
      values[name] = invocationValue(prop, item.value, item.source, item.attributePresent);
    }
  }
  for (const [name, prop] of Object.entries(contract.props)) {
    const item = incoming[name];
    if (item !== undefined && prop.select !== undefined && contract.props[prop.select.from] !== undefined) {
      const type = selectedPropType(contract, prop, values);
      values[name] = invocationValue(prop, item.value, item.source, item.attributePresent, type);
    }
  }
  return values;
}

function readInvocation(
  invocation: Element,
  definition: ComponentDefinition,
  hydration = false,
  parent?: RuntimeInstance,
  frameworkProps?: Readonly<Record<string, unknown>>,
): {
  readonly scope: ReactiveScope;
  readonly passThrough: readonly RootAttribute[];
  readonly effects: ReactiveOwner[];
  readonly explicit: Set<string>;
  readonly propInputs: Readonly<Record<string, ReactiveSignal<PropInput>>>;
} {
  const contract = definition.contract;
  const restored = hydration && frameworkProps === undefined
    ? renderedInstanceRecord(invocation, contract.tag) : undefined;
  const names = propAttributeNames(definition, hydration);
  const incoming = Object.create(null) as Record<string, IncomingProp>;
  const passThrough: Attr[] = [];
  for (const attribute of Array.from(invocation.attributes)) {
    const propName = restored === undefined ? names[attribute.name.toLowerCase()] : undefined;
    if (propName === undefined) {
      if (!hydration) passThrough.push(attribute);
      continue;
    }
    incoming[propName] = { value: attribute.value, source: "html", attributePresent: !hydration };
  }
  if (restored !== undefined) {
    for (const name of Object.keys(contract.props)) {
      const input = restored.inputs[name];
      if (input?.present) incoming[name] = { value: input.value, source: input.source, attributePresent: false };
    }
  }
  for (const [name, input] of Object.entries(frameworkProps ?? {})) {
    const prop = contract.props[name];
    if (prop !== undefined && input !== undefined) incoming[name] = { value: input, source: "value", attributePresent: false };
  }

  const values = parseIncomingProps(contract, incoming);
  if (restored !== undefined) {
    for (const name of Object.keys(contract.props)) values[name] = restored.props[name] as PropValue;
  }
  const propInputs = Object.create(null) as Record<string, ReactiveSignal<PropInput>>;
  for (const name of Object.keys(contract.props)) {
    const item = incoming[name];
    propInputs[name] = createSignal(item === undefined
      ? { value: null, source: "value", present: false }
      : { value: item.value, source: item.source, present: true });
  }

  // Props are attributes on the invocation (or, when hydrating, the data-* reflection of the
  // author's explicit attributes). They are never read from JavaScript properties.
  const { scope, effects } = componentScope(definition, values, parent);
  if (restored !== undefined) {
    for (const declaration of definition.declarations ?? []) {
      if (declaration.kind === "state" && Object.hasOwn(restored.state, declaration.name)) {
        scope.set(declaration.name, restored.state[declaration.name] as Value);
      }
    }
  }
  for (const [name, prop] of Object.entries(contract.props)) {
    if (prop.select === undefined || contract.props[prop.select.from] !== undefined) continue;
    const item = incoming[name];
    if (item !== undefined) {
      const type = selectedPropType(contract, prop, { [prop.select.from]: scope.get(prop.select.from) });
      values[name] = invocationValue(prop, item.value, item.source, item.attributePresent, type);
      if (values[name] !== undefined) scope.set(name, values[name] as Value);
    }
  }
  const explicit = new Set(restored?.explicit ?? Object.keys(incoming).filter((name) => incoming[name]?.value !== null));
  const declarations = definition.declarations ?? [];
  const definitionBase = (() => {
    try { return new URL(definition.source.file, invocation.ownerDocument.baseURI).href; }
    catch { return invocation.ownerDocument.baseURI; }
  })();
  for (const declaration of declarations) {
    if (declaration.kind !== "data" || declaration.source === undefined) continue;
    const data = declaration as DataDeclaration;
    const dataSource = declaration.source;
    const acceptedParameters = new Map<string, Value>();
    const readParameter = (parameter: DataDeclaration["parameters"][number]): { value: Value; valid: boolean } => {
      const evaluated = evalConforming(parameter.expression, scope, definition);
      if (evaluated === NONCONFORMING) return { value: acceptedParameters.get(parameter.name) ?? null, valid: false };
      const value = evaluated === ABSENT ? null : evaluated;
      acceptedParameters.set(parameter.name, value);
      return { value, valid: true };
    };
    const resource = new DataResource({
      source: dataSource,
      baseURL: definitionBase,
      ...(data.type === undefined ? {} : { type: data.type }),
      ...(data.debounce === undefined ? {} : { debounce: parseDuration(data.debounce) ?? 0 }),
      ...(data.poll === undefined ? {} : { poll: parseDuration(data.poll) ?? 0 }),
      sampleParameters: () => Object.fromEntries(data.parameters.map((parameter) => [
        parameter.name, untracked(() => readParameter(parameter).value),
      ])),
      onState: (state) => scope.set(data.name, state as unknown as Value),
    });
    const active = !documentState(invocation.ownerDocument).staticRendering;
    effects.push(createEffect(scope.scheduler, () => () => resource.disconnect(), 0, active));
    effects.push(createEffect(scope.scheduler, () => {
      let valid = true;
      const parameters = Object.fromEntries(data.parameters.map((parameter) => {
        const result = parameter.mode === "from"
          ? readParameter(parameter)
          : untracked(() => readParameter(parameter));
        if (parameter.mode === "from" && !result.valid) valid = false;
        return [parameter.name, result.value];
      }));
      if (!valid) return;
      resource.update(parameters);
    }, 0, active));
  }
  return { scope, passThrough, effects, explicit, propInputs };
}

/** A child scope layer whose locals shadow the parent (for $each/$with/$match aliases). */
function layer(parent: ReactiveScope, locals: Record<string, Value>): ReactiveScope {
  return parent.fork(Object.entries(locals));
}

function typedLayer(parent: ReactiveScope, locals: Record<string, Value>, types: Readonly<Record<string, TypeNode | undefined>>): ReactiveScope {
  const child = layer(parent, locals);
  declareLayerTypes(child, parent, types);
  return child;
}

function evalValue(expression: string, scope: Scope): Value {
  try {
    return evaluate(expression, scope);
  } catch (error) {
    if (error instanceof UndeclaredName) fail("HB001", error.message);
    throw error;
  }
}

/** A path an expression reads that a declaration constrains, and its type. */
type ConstrainedReference = readonly [path: string, type: TypeNode];

/** Paths an expression reads that a declaration constrains, resolved once per definition. */
const constrainedPaths = new WeakMap<ComponentDefinition, Map<string, readonly ConstrainedReference[]>>();

/**
 * The value at a dependency path. A path names both a list index and a record key as a segment
 * (`items.0`, `byId.42`), so each segment is read the way the value in hand reads it.
 */
function readPath(path: string, scope: ReactiveScope): Value {
  const [root, ...keys] = path.split(".");
  let value = scope.read(root!);
  for (const key of keys) {
    if (Array.isArray(value)) {
      value = key === "length" || /^\d+$/.test(key) ? readKey(value, key === "length" ? key : Number(key)) : undefined;
    } else if (typeof value === "string" && key === "length") {
      value = value.length;
    } else if (typeof value === "object" && value !== null) {
      value = readKey(value, key);
    } else {
      return ABSENT;
    }
  }
  return value ?? ABSENT;
}

function constrainedReferences(
  definition: ComponentDefinition,
  expression: string,
): readonly ConstrainedReference[] {
  let cache = constrainedPaths.get(definition);
  if (cache === undefined) {
    cache = new Map();
    constrainedPaths.set(definition, cache);
  }
  const known = cache.get(expression);
  if (known !== undefined) return known;
  let paths: readonly ConstrainedReference[] = [];
  try {
    paths = typeCheckedDependencies(expression).flatMap((path) => {
      const type = declaredTypeAt(definition, path);
      return type === undefined ? [] : [[path, type] as const];
    });
  } catch { /* an unreadable expression fails where it is evaluated, not here */ }
  cache.set(expression, paths);
  return paths;
}

/**
 * Whether a value satisfies the type declared for the reference that read it.
 *
 * A reference is checked against its own type, not its subtree: a list reference needs a list, and
 * whether an item's field satisfies its own type is that field reference's business. That keeps the
 * check constant-time on a hot path, and keeps one bad row from silencing a reference to the list.
 */
/**
 * Evaluates a binding expression, or leaves it inert when a reference fails its declared type.
 *
 * A reference is checked where it is read, not where its value arrived, so a payload stays exactly
 * as it came back and only the references into its offending part go inert. Callers keep whatever
 * they last had: a binding does not write, and a computed does not recompute, so nothing downstream
 * of a broken contract moves.
 */
const reportedAuthoredWarnings = new WeakMap<ComponentDefinition, Set<string>>();

function warnAuthored(definition: ComponentDefinition, location: string, message: string): void {
  let reported = reportedAuthoredWarnings.get(definition);
  if (reported === undefined) reportedAuthoredWarnings.set(definition, reported = new Set());
  if (reported.has(location)) return;
  reported.add(location);
  console.warn(`${definition.source.file}: HR007: ${message}`);
}

function evalConforming(
  expression: string | CompiledExpression,
  scope: ReactiveScope,
  definition: ComponentDefinition,
): Value | typeof NONCONFORMING {
  const source = typeof expression === "string" ? expression : expression.source;
  for (const [path, type] of constrainedReferences(definition, source)) {
    const value = readPath(path, scope);
    // Absence is not a violation: a value that is not there yet has nothing to conform to.
    if (value === ABSENT || value === undefined) continue;
    const selectedType = definition.contract.props[path.split(".")[0]!]?.select === undefined
      ? type : declaredTypeAt(definition, path, scope);
    if (selectedType === undefined || conformsAtReference(value, selectedType)) continue;
    warnAuthored(definition, `expression:${source}:${path}`, `Reference \`${path}\` must satisfy ${formatType(selectedType)}.`);
    return NONCONFORMING;
  }
  try {
    return evaluateCompiled(typeof expression === "string" ? compileExpression(expression) : expression, scope);
  } catch (error) {
    if (error instanceof UndeclaredName) fail("HB001", error.message);
    throw error;
  }
}


interface HydrationRange {
  readonly slot: string;
  readonly fallback: boolean;
  readonly scoped?: boolean;
  /** The server's marker nodes: [start, end], or [marker] for an empty slot. */
  readonly markers: readonly Node[];
  readonly content: readonly Node[];
}

/** Weak tags reuse the existing effect ownership; row removal releases every indexed binding. */
const indexedSelections = new WeakMap<ReactiveEffect, string>();

/** The outer root a keyed selection compares with, compiled as its `$root` reference. */
const selectedRoot = (root: CompiledExpression): string => (root.ast as Extract<ExpressionNode, { kind: "id" }>).name;

/**
 * What one rendering of the root owns: its effects, including those later `$if`/`$each` renders
 * add. A root switch stops them all and starts afresh.
 */
class RenderOwned {
  /** Flat creation order for instance pause/resume and root replacement. */
  readonly effects: Set<ReactiveEffect>;
  /** Structural ownership includes descendants added after the first render. */
  readonly #entries = new Set<ReactiveEffect | RenderOwned>();
  readonly #root: RenderOwned;
  #stopped = false;

  constructor(readonly parent?: RenderOwned) {
    this.#root = parent === undefined ? this : parent.#root;
    this.effects = parent?.effects ?? new Set();
    if (parent !== undefined) {
      this.#stopped = parent.#stopped || this.#root.#stopped;
      if (!this.#stopped) parent.#entries.add(this);
    }
  }

  add(effect: ReactiveEffect): void {
    if (effect.stopped) return;
    if (this.#stopped || this.#root.#stopped) {
      effect.stop();
      return;
    }
    this.#entries.add(effect);
    this.effects.add(effect);
    effect.registration = this;
  }

  release(effect: ReactiveEffect): void {
    this.#entries.delete(effect);
    this.effects.delete(effect);
  }

  select(root: string): void {
    for (const entry of this.#entries) {
      if (entry instanceof RenderOwned) entry.select(root);
      else if (indexedSelections.get(entry) === root) entry.schedule();
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.parent !== undefined) this.parent.#entries.delete(this);
    let failed = false;
    let failure: unknown;
    const stop = (owner: ReactiveEffect | RenderOwned): void => {
      try { owner.stop(); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    };
    // Root replacement retains the old flat cleanup order. A local group stops its tree.
    if (this.parent === undefined) for (const effect of this.effects) stop(effect);
    for (const owner of this.#entries) stop(owner);
    this.#entries.clear();
    if (failed) throw failure;
  }
}

function renderOwned(parent?: RenderOwned): RenderOwned {
  return new RenderOwned(parent);
}

function ownedContext(context: RuntimeRenderContext, owned: RenderOwned): RuntimeRenderContext {
  // Preserve live root/committed fields and inherited namespace/projection context fields.
  return Object.create(context, { owned: { value: owned, enumerable: true } }) as RuntimeRenderContext;
}

interface RuntimeRenderContext {
  readonly definition: ComponentDefinition;
  owned: RenderOwned;
  readonly refs: Record<string, Element | Element[]>;
  readonly selection?: {
    readonly key: CompiledExpression;
    readonly scope: ReactiveScope;
    readonly bindings: ReadonlyMap<CompiledExpression, CompiledExpression>;
  };
  root?: Element;
  readonly projectedNodes: readonly Node[];
  readonly projectedSlotNames: WeakMap<Node, string>;
  readonly slotInsertions: SlotInsertion[];
  readonly selectBindings: Array<() => void>;
  /** The definition's root element, or the root `$match` arm this instance chose. */
  rootNode: ElementNode;
  readonly frameworkOwned: boolean;
  committed: boolean;
  /** Server slot ranges, consumed in template order while hydrating. */
  hydrationRanges?: HydrationRange[] | undefined;
  /** SVG while rendering inside an `<svg>` subtree (outside `<foreignObject>`); otherwise HTML. */
  readonly namespace?: typeof SVG_NAMESPACE;
}

interface ProjectedTemplate {
  readonly children: readonly TemplateNode[];
  readonly scope: ReactiveScope;
  readonly context: RuntimeRenderContext;
}

const projectedTemplates = new WeakMap<HTMLTemplateElement, ProjectedTemplate>();
/** The element roots each consumer `<template slot>` renders, one set per outlet rendering it now. */
const templateRenderings = new WeakMap<HTMLTemplateElement, Set<Element[]>>();

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
): ReturnType<typeof createEffect> {
  const owned = context.owned;
  const effect = createEffect(scope.scheduler, run, priority);
  owned.add(effect);
  return effect;
}

function resolveWritablePath(scope: ReactiveScope, path: WritablePath): (string | number)[] | undefined {
  const resolved: (string | number)[] = [];
  for (const segment of path) {
    const key = typeof segment === "object" ? evaluateCompiled(segment.expression, scope) : segment;
    if (typeof key !== "string" && typeof key !== "number") return undefined;
    resolved.push(key);
  }
  return resolved;
}

function setWritablePath(scope: ReactiveScope, path: WritablePath, value: Value): void {
  const [root, ...segments] = path;
  if (typeof root !== "string") return;
  if (segments.length === 0) {
    scope.setExisting(root, value);
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



const eventDependentHandlers = new WeakMap<HandlerDeclaration, boolean>();

function runHandler(
  declaration: HandlerDeclaration,
  element: Element,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
  event: Event,
): void {
  // Per-invocation lexical scope preserves the outer event during synchronous nested dispatch.
  let readsEvent = eventDependentHandlers.get(declaration);
  if (readsEvent === undefined) {
    readsEvent = declaration.steps.some((step) => [step.guard, ...("value" in step ? [step.value] : [])]
      .some((expression) => expression?.dependencies.some((name) => name.split(".", 1)[0] === "$$event")));
    eventDependentHandlers.set(declaration, readsEvent);
  }
  if (readsEvent) scope = scope.fork([["$$event", event]]);
  for (const step of declaration.steps) {
    if (step.guard !== undefined) {
      const guard = evalConforming(step.guard, scope, context.definition);
      if (guard === NONCONFORMING || !truthy(guard)) continue;
    }
    if (step.kind === "set") {
      const next = evalConforming(step.value, scope, context.definition);
      if (next === NONCONFORMING) continue;
      const path = resolveWritablePath(scope, step.writablePath);
      if (path === undefined) continue;
      if (!conformsAtDestination(next, declaredTypeAt(context.definition, path, scope))) {
        warnAuthored(context.definition, `handler:${declaration.name}:${step.path}`, `State \`${step.path}\` does not satisfy its declared type.`);
        continue;
      }
      setWritablePath(scope, path, next);
    } else if (step.kind === "dispatch") {
      const declaration = eventDeclaration(context.definition, step.event);
      const detail = step.value === undefined ? undefined : evalConforming(step.value, scope, context.definition);
      if (detail === NONCONFORMING) continue;
      if (step.target === undefined) dispatchComponentEvent(context.root ?? element, step.event, detail, declaration);
      else {
        const recorded = context.refs[step.target];
        const targets = (Array.isArray(recorded) ? [...recorded] : recorded === undefined ? [] : [recorded])
          .filter((target) => target.isConnected)
          .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
        dispatchComponentEvent(targets, step.event, detail, declaration);
      }
    } else {
      const recorded = context.refs[step.target];
      const target = Array.isArray(recorded) ? recorded[0] : recorded;
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
  target: Element | readonly Element[],
  event: string,
  detail: unknown,
  declaration: EventDeclaration | undefined,
): boolean {
  if (declaration !== undefined && detail !== undefined) {
    // Literal <dispatch value> text is parsed while reading the definition. At dispatch time
    // both controller input and expr:value are JavaScript values, not HTML text to coerce.
    const parsed = parseTypedValue(detail, declarationTypeNode(declaration.type, declaration.shape)!, "$", "value");
    if (!parsed.ok) fail("HR002", `Event \`${event}\` detail does not satisfy its declared type.`);
  }
  const init = {
    detail,
    bubbles: declaration?.bubbles ?? true,
    composed: declaration?.composed ?? true,
    cancelable: declaration?.cancelable ?? false,
  };
  if (Array.isArray(target)) {
    let accepted = true;
    for (const element of target) {
      if (element.isConnected && !element.dispatchEvent(new CustomEvent(event, init))) accepted = false;
    }
    return accepted;
  }
  return (target as Element).dispatchEvent(new CustomEvent(event, init));
}

function bindEvents(
  element: Element,
  node: ElementNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
  invocation?: InvocationBinding,
): void {
  for (const binding of node.events ?? []) {
    const declaration = (context.definition.declarations ?? []).find(
      (candidate): candidate is HandlerDeclaration =>
        candidate.kind === "handler" && candidate.name === binding.handler,
    )!;
    const capture = binding.modifiers.includes("capture");
    const once = binding.modifiers.includes("once");
    // Native `once` removes the listener after its first call; a later root must not re-arm it.
    let fired = false;
    const effect = ownEffect(context, scope, () => {
      const target = rootTarget(element, invocation);
      if (target === undefined || fired) return;
      const listener = (event: Event): void => {
        fired = once;
        if (!eventPasses(event, target, binding.modifiers)) return;
        if (binding.modifiers.includes("prevent")) event.preventDefault();
        if (binding.modifiers.includes("stop")) event.stopPropagation();
        runHandler(declaration, target, scope, context, event);
      };
      target.addEventListener(binding.name, listener, { capture, passive: binding.modifiers.includes("passive"), once });
      return () => target.removeEventListener(binding.name, listener, { capture });
    }, 2);
    invocation?.effects.push(effect);
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
  scope: ReactiveScope,
  document: Document,
  definition: ComponentDefinition,
): void {
  const value = evalConforming(directive.expression, scope, definition);
  if (value === NONCONFORMING) return;
  if (directive.name === "value") element.textContent = toText(value);
  else element.replaceChildren(sanitizeFragment(toText(value), document, markContentOnly));
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
  // Rows stay plain: tracked like the proxy's reads, but no row ever needs its own proxy.
  let result = readItems(items);
  if (flow.where !== undefined) {
    const where = flow.where;
    result = result.filter((item) => truthy(evalValue(where, layer(scope, { [flow.item]: item }))));
  }
  if (flow.sortKeys !== undefined) {
    // A `$sort` key is a path from the loop item (unlike `$key`, which is an expression):
    // `p.price,-p.name` sorts by price ascending then name descending, and `p` by the item itself.
    // A scalar-item list sorts by the value itself; the key then only carries its direction.
    const keys = flow.sortKeys;
    const sortValue = (item: Value, path: readonly string[]): Value =>
      path.length > 0 && item !== null && typeof item === "object" && !Array.isArray(item)
        ? evalValue(`$${flow.item}.${path.join(".")}`, layer(scope, { [flow.item]: item }))
        : item;
    result.sort((a, b) => {
      for (const { path, descending } of keys) {
        const order = compareValues(sortValue(a, path), sortValue(b, path));
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

function existingDynamicRange(candidate: Node | undefined): readonly [Comment, Comment] | undefined {
  if (!(candidate instanceof Comment) || candidate.data !== "html-next:start") return undefined;
  let depth = 1;
  for (let node = candidate.nextSibling; node !== null; node = node.nextSibling) {
    if (node instanceof Comment && node.data === "html-next:start") depth += 1;
    else if (node instanceof Comment && node.data === "html-next:end" && --depth === 0) return [candidate, node];
  }
  return undefined;
}

function rangeNodes(start: Comment, end: Comment): Node[] {
  const nodes: Node[] = [start];
  for (let node = start.nextSibling; node !== null; node = node.nextSibling) {
    nodes.push(node);
    if (node === end) break;
  }
  return nodes;
}

/** Option regions can change without the select's bound value changing. */
function syncContainingSelect(after: Comment): void {
  const parent = after.parentElement;
  if (parent?.localName !== "select" && parent?.localName !== "optgroup") return;
  const select = parent.closest("select");
  if (!(select instanceof HTMLSelectElement)) return;
  const applySelection = selectValueBindings.get(select);
  if (applySelection !== undefined) queueMicrotask(applySelection);
}

function renderDynamicNode(
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
  passThrough: readonly RootAttribute[],
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  if (node.flow?.kind === "each") {
    return renderEachRegion(node, scope, document, passThrough, context, candidate);
  }
  const existing = context.committed ? existingDynamicRange(candidate) : undefined;
  const start = existing?.[0] ?? document.createComment("html-next:start");
  const end = existing?.[1] ?? document.createComment("html-next:end");
  const fragment = existing === undefined ? document.createDocumentFragment() : undefined;
  fragment?.append(start, end);
  let childOwned: RenderOwned | undefined;
  let adopting = existing !== undefined;
  ownEffect(context, scope, () => {
    const test = node.flow?.kind === "if" ? evalConforming(node.flow.test, scope, context.definition) : undefined;
    const aliased = node.flow?.kind === "with" ? evalConforming(node.flow.expr, scope, context.definition) : undefined;
    const match = node.flow?.kind === "match" ? prepareMatch(node, scope, context.definition) : undefined;
    if (test === NONCONFORMING || aliased === NONCONFORMING || match === NONCONFORMING) return;
    childOwned?.stop();
    childOwned = undefined;
    const previous = adopting ? rangeNodes(start, end).slice(1, -1) : [];
    if (!adopting) clearRange(start, end);
    childOwned = renderOwned(context.owned);
    const childContext = ownedContext(context, childOwned);
    let rendered: Node[] = [];
    if (node.flow?.kind === "if") {
      if (truthy(test!)) {
        const { flow: _flow, ...body } = node;
        rendered = renderInstance(body, scope, document, passThrough, childContext, previous[0]);
      }
    } else if (node.flow?.kind === "with") {
      const local = typedLayer(scope, { [node.flow.alias]: aliased! }, {
        [node.flow.alias]: declaredExpressionType(node.flow.expressionPlan ?? node.flow.expr, scope),
      });
      const { flow: _flow, ...body } = node;
      rendered = renderInstance(body, local, document, passThrough, childContext, previous[0]);
    } else if (node.flow?.kind === "match") {
      rendered = renderMatch(match!, document, childContext, previous[0]);
    }
    const output = materialize(rendered, document);
    if (adopting) {
      for (const stale of previous) if (!output.includes(stale)) stale.parentNode?.removeChild(stale);
      adopting = false;
    }
    end.before(...output);
    syncContainingSelect(end);
  });
  return fragment === undefined ? rangeNodes(start, end) : [fragment];
}

interface EachBlock {
  readonly start: Comment;
  readonly end: Comment;
  readonly scope: ReactiveScope;
  readonly owned: RenderOwned;
  /** Index in the last completed keyed run; a failed run leaves it as it was. */
  position: number;
}

function existingEachRange(candidate: Node | undefined, kind: "each" | "item"): readonly [Comment, Comment] | undefined {
  if (!(candidate instanceof Comment) || candidate.data !== `html-next:${kind}-start`) return undefined;
  let depth = 1;
  for (let node = candidate.nextSibling; node !== null; node = node.nextSibling) {
    if (!(node instanceof Comment)) continue;
    if (node.data === `html-next:${kind}-start`) depth += 1;
    else if (node.data === `html-next:${kind}-end` && --depth === 0) return [candidate, node];
  }
  return undefined;
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
  block.owned.stop();
  let current: Node | null = block.start;
  while (current !== null) {
    const next: Node | null = current.nextSibling;
    current.parentNode?.removeChild(current);
    if (current === block.end) break;
    current = next;
  }
}

/** Remove only adjacent stale blocks; foreign siblings and retained blocks split a group. */
function removeStaleBlocks(
  blocks: ReadonlyMap<unknown, EachBlock>,
  retained: ReadonlyMap<unknown, EachBlock>,
  start: Comment,
  end: Comment,
): void {
  let group: EachBlock[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    if (group.length === 1) removeBlock(group[0]!);
    else {
      for (const block of group) block.owned.stop();
      const first = group[0]!;
      const last = group.at(-1)!;
      const parent = first.start.parentNode;
      if (parent !== null && last.end.parentNode === parent) {
        // Order needs no sibling walk. Whole-parent anchors place the first start second and the
        // last end second to last, so it follows. Otherwise the range collapses exactly when a
        // foreign move put the first start after the last end, which keeps per-block removal.
        if ((parent instanceof Element || parent instanceof DocumentFragment) &&
            first.start.previousSibling === start && last.end.nextSibling === end &&
            start.previousSibling === null && end.nextSibling === null) {
          // The entire parent is this removed region. Keep its existing outer anchors.
          parent.replaceChildren(start, end);
        } else {
          const range = first.start.ownerDocument.createRange();
          range.setStartBefore(first.start);
          range.setEndAfter(last.end);
          if (range.collapsed) for (const block of group) removeBlock(block);
          else range.deleteContents();
        }
      } else {
        for (const block of group) removeBlock(block);
      }
    }
    group = [];
  };
  for (const [key, block] of blocks) {
    if (retained.has(key)) {
      flush();
      continue;
    }
    if (group.length > 0 && group.at(-1)!.end.nextSibling !== block.start) flush();
    group.push(block);
  }
  flush();
}

/** Mark the longest subsequence of retained blocks that is already in DOM order. */
function stableBlockPositions(previous: readonly number[]): Uint8Array | undefined {
  let last = -1;
  let ordered = true;
  for (let index = 0; index < previous.length; index += 1) {
    const position = previous[index]!;
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
  node: ElementNode | SlotNode,
  scope: ReactiveScope,
  document: Document,
  passThrough: readonly RootAttribute[],
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  const flow = node.flow as Extract<Flow, { kind: "each" }>;
  const listType = declaredExpressionType(flow.listPlan ?? flow.list, scope);
  const itemType = listType?.kind === "list" ? listType.item : undefined;
  const existing = context.committed ? existingEachRange(candidate, "each") : undefined;
  const start = existing?.[0] ?? document.createComment("html-next:each-start");
  const end = existing?.[1] ?? document.createComment("html-next:each-end");
  const fragment = existing === undefined ? document.createDocumentFragment() : undefined;
  fragment?.append(start, end);
  const adopting: (readonly [Comment, Comment])[] = [];
  let adoptionIndex = 0;
  if (existing !== undefined) {
    for (let node = start.nextSibling; node !== null && node !== end;) {
      const block = existingEachRange(node, "item");
      if (block === undefined) break;
      adopting.push(block);
      node = block[1].nextSibling;
    }
  }
  let blocks = new Map<unknown, EachBlock>();
  const { flow: _flow, ...body } = node;
  const bindings = new Map<CompiledExpression, CompiledExpression>();
  if (flow.keyPlan !== undefined && node.kind === "element") {
    const find = (element: ElementNode): void => {
      for (const attribute of element.attributes) {
        if (attribute.kind !== "attribute" || attribute.target !== "class" || attribute.expressionPlan === undefined) continue;
        const root = keyedEquality(attribute.expressionPlan.ast, flow.keyPlan!.ast, flow.item);
        if (root !== undefined && root !== flow.index) {
          // Keep one scheduler group when another binding on this element reads the same root;
          // otherwise routing only the class effect would change authored attribute creation order.
          const shared = element.attributes.some((other) => other.kind !== "literal" &&
            other.expressionPlan?.dependencies.some((path) => path === root || path.startsWith(`${root}.`)) === true &&
            (other.kind !== "attribute" || other.target !== "class" ||
              keyedEquality(other.expressionPlan.ast, flow.keyPlan!.ast, flow.item) !== root));
          if (shared) continue;
          bindings.set(attribute.expressionPlan, compileExpression(`$${root}`));
        }
      }
      for (const child of element.children) if (child.kind === "element" && child.flow === undefined) find(child);
    };
    find(body as ElementNode);
  }
  const roots = new Set([...bindings.values()].map(selectedRoot));
  const selection = bindings.size === 0 ? undefined : { key: flow.keyPlan!, scope, bindings };
  const rowContext = selection === undefined ? context
    : Object.create(context, { selection: { value: selection } }) as RuntimeRenderContext;
  const nativePlan = node.kind === "element" ? nativeTemplatePlan(node as ElementNode, document, context) : undefined;
  ownEffect(context, scope, () => {
    const value = evalConforming(flow.list, scope, context.definition);
    if (value === NONCONFORMING) return;
    const items = Array.isArray(value) ? shapeList(value, flow, scope) : [];
    const next = new Map<unknown, EachBlock>();
    const keyed = flow.key !== undefined;
    const ordered: EachBlock[] | undefined = keyed ? [] : undefined;
    const previous: number[] | undefined = keyed ? [] : undefined;
    let retained = 0;
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
        local = typedLayer(scope, locals, { [flow.item]: itemType });
        key = evalValue(flow.key, local);
      }
      if (next.has(key)) fail("HR004", `A keyed list produced duplicate key \`${toText(key as Value)}\`.`);
      let block = blocks.get(key);
      if (block === undefined) {
        local ??= typedLayer(scope, locals, { [flow.item]: itemType });
        const owned = renderOwned(context.owned);
        const blockContext = ownedContext(rowContext, owned);
        const adopted = adopting[adoptionIndex++];
        const rendered = materialize(node.kind === "slot"
          ? renderSlot(body as SlotNode, local, document, blockContext)
          : nativePlan !== undefined && adopted === undefined
            ? instantiateNativeTemplate(nativePlan, body as ElementNode, local, document, passThrough, blockContext)
            : renderInstance(body as ElementNode, local, document, passThrough, blockContext, adopted?.[0].nextSibling ?? undefined), document);
        const blockStart = adopted?.[0] ?? document.createComment("html-next:item-start");
        const blockEnd = adopted?.[1] ?? document.createComment("html-next:item-end");
        end.before(blockStart, ...rendered, blockEnd);
        block = {
          start: blockStart,
          end: blockEnd,
          scope: local,
          owned,
          position: -1,
        };
        previous?.push(-1);
      } else {
        retained += 1;
        previous?.push(block.position);
        block.scope.set(flow.item, item);
        if (flow.index !== undefined) block.scope.set(flow.index, index);
        block.scope.set("loop", locals.loop!);
      }
      next.set(key, block);
      ordered?.push(block);
    }
    for (const [blockStart, blockEnd] of adopting.slice(adoptionIndex)) {
      clearRange(blockStart, blockEnd);
      blockStart.remove();
      blockEnd.remove();
    }
    adopting.length = 0;
    adoptionIndex = 0;
    removeStaleBlocks(blocks, next, start, end);
    if (ordered !== undefined && previous !== undefined) {
      // With no retained block every position is -1, which is already ordered.
      const stable = retained === 0 ? undefined : stableBlockPositions(previous);
      let reference: Node = end;
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const block = ordered[index]!;
        if (previous[index]! < 0 || stable !== undefined && stable[index] !== 1) {
          moveBlockBefore(block, reference);
        }
        reference = block.start;
      }
    }
    if (ordered !== undefined) for (let index = 0; index < ordered.length; index += 1) ordered[index]!.position = index;
    blocks = next;
    syncContainingSelect(end);
  });
  for (const root of roots) {
    let previous: Value | typeof NONCONFORMING | undefined = ABSENT;
    ownEffect(context, scope, () => {
      const value = scope.read(root);
      const type = scope.typeOfDeclaredPath?.(root);
      // Routing does not evaluate a row binding or emit its diagnostics while the list is empty.
      const next = type !== undefined && value !== undefined && value !== ABSENT &&
        !conformsAtReference(value, type) ? NONCONFORMING : value;
      if (previous === NONCONFORMING || next === NONCONFORMING) {
        for (const block of blocks.values()) block.owned.select(root);
      } else visitSelected(blocks, previous, next, (block) => block.owned.select(root));
      previous = next;
    }, 0);
  }
  return fragment === undefined ? rangeNodes(start, end) : [fragment];
}

function renderNode(
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
  passThrough: readonly RootAttribute[],
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  if (node.flow?.kind === "match" && node.name !== "template") {
    if (context.committed && context.frameworkOwned && candidate !== undefined) return [candidate];
    return renderInstance(elementMatchRoot(node), scope, document, passThrough, context, candidate);
  }
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
    return renderDynamicNode(node, scope, document, passThrough, context, candidate);
  }
  // Only `$when`/`$else` arms remain; outside a `$match` their marker is ignored.
  return renderInstance(node, scope, document, passThrough, context, candidate);
}

/** The root element to render: the definition's own, or the root `$match` arm its props choose. */
function componentRoot(definition: ComponentDefinition, scope: Scope): ElementNode {
  const arms = rootArms(definition.template);
  if (arms === undefined) return definition.template;
  return arms.find((arm) =>
    arm.flow?.kind === "else" || (arm.flow?.kind === "when" && truthy(evalValue(arm.flow.test, scope)))
  )!;
}

/**
 * The index of the root `$match` arm a generated factory's props choose, read against the same
 * props, state, and computed values the instance starts with.
 */
export function componentRootIndex(
  definition: ComponentDefinition,
  props: Readonly<Record<string, unknown>>,
): number {
  const incoming = Object.create(null) as Record<string, IncomingProp>;
  // Use the same typed prop channel as attachment so explicit null overrides a default.
  for (const name of Object.keys(definition.contract.props)) {
    const input = props[name];
    if (input !== undefined) incoming[name] = { value: input, source: "value", attributePresent: false };
  }
  const values = parseIncomingProps(definition.contract, incoming);
  const { scope, effects } = componentScope(definition, values);
  try {
    return definition.template.children.indexOf(componentRoot(definition, scope));
  } finally {
    for (const effect of effects) effect.stop();
  }
}

function prepareMatch(
  node: ElementNode,
  scope: ReactiveScope,
  definition: ComponentDefinition,
): { chosen: ElementNode | undefined; scope: ReactiveScope } | typeof NONCONFORMING {
  const flow = node.flow as Extract<Flow, { kind: "match" }>;
  const value = flow.expr === undefined ? undefined : evalConforming(flow.expr, scope, definition);
  if (value === NONCONFORMING) return NONCONFORMING;
  const matchScope = flow.expr === undefined ? scope : layer(scope, { [flow.alias!]: value! });

  for (const child of node.children) {
    if (child.kind !== "element") continue;
    if (child.flow?.kind === "when") {
      const test = evalConforming(child.flow.test, matchScope, definition);
      if (test === NONCONFORMING) return NONCONFORMING;
      if (truthy(test)) return { chosen: child, scope: matchScope };
    }
    if (child.flow?.kind === "else") return { chosen: child, scope: matchScope };
  }
  return { chosen: undefined, scope: matchScope };
}

function renderMatch(
  match: { chosen: ElementNode | undefined; scope: ReactiveScope },
  document: Document,
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  if (match.chosen === undefined) return [];

  // Render the winning arm, ignoring its own $when/$else marker.
  const { flow: _armFlow, ...armNode } = match.chosen;
  return renderInstance(armNode, match.scope, document, [], context, candidate);
}

function bindElement(
  element: Element,
  node: ElementNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
): void {
  if (node.ref !== undefined) {
    if (iteratedRefNames(context.definition).has(node.ref)) {
      ((context.refs[node.ref] ??= []) as Element[]).push(element);
    } else context.refs[node.ref] = element;
  }
  bindElementAttributes(element, node, scope, context);
}

/**
 * Bind a template-component invocation through the component that lowers there: props reach the
 * component, and everything else its current root. The component may already own `element` when
 * it was adopted in an earlier pass; otherwise lowering claims these bindings.
 */
function bindInvocation(
  element: Element,
  node: ElementNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
  awaitsLowering: boolean,
): InvocationBinding {
  const invocation: InvocationBinding = {
    tag: node.name, awaitsLowering, component: committedComponent(element, node.name), effects: [],
  };
  if (node.ref !== undefined) {
    const ref = node.ref;
    // Hold the ref's place in render order until the component's root fills it.
    let current = element;
    if (iteratedRefNames(context.definition).has(ref)) ((context.refs[ref] ??= []) as Element[]).push(current);
    else context.refs[ref] = current;
    invocation.effects.push(ownEffect(context, scope, () => {
      const root = rootTarget(element, invocation);
      if (root === undefined || root === current) return;
      const recorded = context.refs[ref];
      if (Array.isArray(recorded)) {
        const index = recorded.indexOf(current);
        if (index >= 0) (recorded as Element[])[index] = root;
      } else if (recorded === current) context.refs[ref] = root;
      current = root;
    }));
  }
  bindElementAttributes(element, node, scope, context, invocation);
  return invocation;
}

/** Hand an invocation's bindings to the component that owns it, or keep them until it lowers. */
function settleInvocation(element: Element, invocation: InvocationBinding): void {
  if (invocation.component !== undefined) followComponent(invocation, invocation.component);
  else pendingInvocationBindings.set(element, [...pendingInvocationBindings.get(element) ?? [], invocation]);
}

/** Attach what parents bound on an invocation to the component that just lowered there. */
function claimInvocationBindings(element: Element, component: RuntimeInstance): boolean {
  const pending = pendingInvocationBindings.get(element);
  if (pending === undefined) return false;
  const tag = component.definition.contract.tag;
  const claimed = pending.filter((invocation) => invocation.tag === tag);
  if (claimed.length === pending.length) pendingInvocationBindings.delete(element);
  else pendingInvocationBindings.set(element, pending.filter((invocation) => invocation.tag !== tag));
  for (const invocation of claimed) followComponent(invocation, component);
  return claimed.length > 0;
}

/** Install the existing attribute/property bindings on an element, or on an invocation's component. */
function bindElementAttributes(
  element: Element,
  node: ElementNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
  invocation?: InvocationBinding,
): void {
  const own = (run: () => void | (() => void), priority?: number): ReactiveEffect => {
    const effect = ownEffect(context, scope, run, priority);
    invocation?.effects.push(effect);
    return effect;
  };
  for (const attribute of node.attributes) {
    if (attribute.kind === "attribute") {
      const selection = invocation === undefined && attribute.target === "class" &&
        scope.parent === context.selection?.scope ? context.selection : undefined;
      const root = attribute.expressionPlan === undefined ? undefined : selection?.bindings.get(attribute.expressionPlan);
      const effect = own(() => {
        let value: Value | typeof NONCONFORMING;
        if (selection === undefined || root === undefined) value = evalConforming(attribute.expression, scope, context.definition);
        else {
          const expression = attribute.expressionPlan!.ast as Extract<ExpressionNode, { kind: "binary" }>;
          const outerFirst = expression.left.kind === "id" && expression.left.name === selectedRoot(root);
          // Validate each operand through the existing evaluator, retaining expression equality.
          let item: Value | typeof NONCONFORMING;
          let outer: Value | typeof NONCONFORMING;
          if (outerFirst) {
            outer = untracked(() => evalConforming(root, scope, context.definition));
            item = evalConforming(selection.key, scope, context.definition);
          } else {
            item = evalConforming(selection.key, scope, context.definition);
            outer = untracked(() => evalConforming(root, scope, context.definition));
          }
          value = item === NONCONFORMING || outer === NONCONFORMING ? NONCONFORMING
            : expression.op === "=" ? item === outer : item !== outer;
        }
        // A reference that broke its declared type writes nothing, so this binding keeps whatever
        // it last rendered rather than showing a value the declaration forbids.
        if (value === NONCONFORMING) return;
        // A component owns its props: write them through the same channel framework adapters use,
        // so the component re-parses the declared type and reflects the value itself.
        const child = invocation?.component;
        const definition = invocation === undefined ? undefined
          : child?.definition ?? registryFor(element.ownerDocument).definitions.get(invocation.tag)?.definition;
        const propName = definition === undefined || attribute.target !== undefined
          ? undefined : propAttributeNames(definition, false)[attribute.name.toLowerCase()];
        if (propName !== undefined) {
          const contract = definition!.contract;
          const prop = contract.props[propName]!;
          const selected = prop.select === undefined ? prop.type : child === undefined ? undefined
            : selectedPropType(contract, prop, { [prop.select.from]: child.scope.get(prop.select.from) });
          if (!conformsAtDestination(value, selected)) return;
          if (child !== undefined) {
            applyComponentProps(child, { [propName]: value });
            return;
          }
          // A server-rendered root carries its serialized props; they replay when it is adopted.
          if (element.localName !== node.name) return;
        }
        const target = valueTarget(element, invocation);
        if (target === undefined) return;
        if (attribute.target === "class") {
          target.classList.toggle(attribute.name, truthy(value));
        } else if (attribute.target === "style") {
          (target as HTMLElement).style.setProperty(attribute.name, toText(value));
        } else if (attribute.twoWay === true && applyBoundControlValue(target, attribute.name, value)) {
          // Native form-control properties carry the live value; no duplicate attribute write.
        } else {
          setAttribute(target, attribute.name, toAttribute(value, attribute.name));
        }
      });
      if (root !== undefined) indexedSelections.set(effect, selectedRoot(root));
      if (attribute.twoWay === true && attribute.writablePath !== undefined) {
        own(() => {
          const target = rootTarget(element, invocation);
          if (target === undefined) return;
          const eventName = target instanceof HTMLSelectElement ||
            (target instanceof HTMLInputElement && ["checkbox", "radio", "file"].includes(target.type))
            ? "change" : "input";
          const listener = (): void => {
            if (target instanceof HTMLInputElement && target.type === "radio" && !target.checked) return;
            setWritablePath(scope, attribute.writablePath!, controlValue(target));
          };
          target.addEventListener(eventName, listener);
          return () => target.removeEventListener(eventName, listener);
        }, 2);
      }
    } else if (attribute.kind === "property") {
      own(() => {
        const property = evalConforming(attribute.expression, scope, context.definition);
        if (property === NONCONFORMING) return;
        const target = rootTarget(element, invocation);
        if (target !== undefined) (target as unknown as Record<string, unknown>)[attribute.name] = property;
      });
    }
    // Content directives are handled by the renderer.
  }
}

/** Bind one authored text node, retaining nonconforming segments exactly as before. */
function bindTemplateText(
  text: Text,
  node: TextNode,
  scope: ReactiveScope,
  context: RuntimeRenderContext,
): void {
  if (node.expressionPlan === undefined && node.segments === undefined) text.data = node.value;
  else {
    const segments = node.segments ?? [node];
    const accepted = segments.map((segment) => segment.expressionPlan === undefined ? segment.value : "");
    ownEffect(context, scope, () => {
      for (const [index, segment] of segments.entries()) {
        if (segment.expressionPlan === undefined) continue;
        const value = evalConforming(segment.expressionPlan.source, scope, context.definition);
        if (value !== NONCONFORMING) accepted[index] = toText(value);
      }
      text.data = accepted.join("");
    });
  }
}

/** Ordinary, inert HTML elements whose prototypes have no form/resource/custom lifecycle. */
const cloneableNativeElements = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br",
  "caption", "cite", "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "i", "ins", "kbd", "li", "main", "mark", "menu", "nav",
  "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small",
  "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "time", "tr", "u", "ul", "var", "wbr",
]);

type NativeTemplateAction =
  | { readonly kind: "attributes" | "events"; readonly path: readonly number[]; readonly node: ElementNode }
  | { readonly kind: "content"; readonly path: readonly number[]; readonly directive: DirectiveAttribute }
  | { readonly kind: "text"; readonly path: readonly number[]; readonly node: TextNode };

interface NativeTemplatePlan {
  readonly prototype: Element;
  readonly actions: readonly NativeTemplateAction[];
}

const nativeTemplatePlans = new WeakMap<ElementNode, WeakMap<Document, NativeTemplatePlan | null>>();

/**
 * Cache only structural preparation. Values, validation, effects, listeners and owners remain
 * instance-local. Native construction avoids an HTML sink and preserves authored DOM shape.
 */
function nativeTemplatePlan(
  node: ElementNode,
  document: Document,
  context: RuntimeRenderContext,
): NativeTemplatePlan | undefined {
  if (context.frameworkOwned || context.namespace !== undefined) return undefined;
  let documents = nativeTemplatePlans.get(node);
  if (documents === undefined) {
    documents = new WeakMap();
    nativeTemplatePlans.set(node, documents);
  }
  const cached = documents.get(document);
  if (cached !== undefined) return cached ?? undefined;
  const eligible = (candidate: TemplateNode): boolean => {
    if (candidate.kind === "text") return true;
    if (candidate.kind !== "element" || (candidate.flow !== undefined && candidate !== node) || candidate.ref !== undefined ||
        !cloneableNativeElements.has(candidate.name)) return false;
    if (candidate.attributes.some((attribute) =>
      attribute.kind === "property" ||
      attribute.kind === "attribute" && (attribute.twoWay === true || attribute.name.toLowerCase() === "is") ||
      attribute.kind === "literal" && (attribute.name.toLowerCase() === "is" || /^on/i.test(attribute.name))
    )) return false;
    const directive = candidate.attributes.find((attribute): attribute is DirectiveAttribute => attribute.kind === "directive");
    // Content directives ignore authored descendants in the ordinary renderer too.
    return directive === undefined ? candidate.children.every(eligible) : directive.name === "value";
  };
  if (!eligible(node)) {
    documents.set(document, null);
    return undefined;
  }
  const actions: NativeTemplateAction[] = [];
  const construct = (candidate: TemplateNode, path: readonly number[]): Node => {
    if (candidate.kind === "text") {
      if (candidate.expressionPlan === undefined && candidate.segments === undefined) {
        return document.createTextNode(candidate.value);
      }
      actions.push({ kind: "text", path, node: candidate });
      return document.createTextNode("");
    }
    // Eligibility has rejected all slots, namespace transitions and structural descendants.
    const elementNode = candidate as ElementNode;
    const element = createTemplateElement(document, elementNode.name, context);
    for (const attribute of elementNode.attributes) {
      if (attribute.kind === "literal") element.setAttribute(attribute.name, attribute.value);
    }
    if (elementNode.attributes.some((attribute) => attribute.kind === "attribute")) {
      actions.push({ kind: "attributes", path, node: elementNode });
    }
    const directive = elementNode.attributes.find((attribute): attribute is DirectiveAttribute => attribute.kind === "directive");
    if (directive !== undefined) actions.push({ kind: "content", path, directive });
    else {
      for (const [index, child] of elementNode.children.entries()) {
        element.append(construct(child, [...path, index]));
      }
    }
    // Event ownership follows the same depth-first order as ordinary rendering.
    if ((elementNode.events?.length ?? 0) > 0) actions.push({ kind: "events", path, node: elementNode });
    return element;
  };
  const prototype = construct(node, []) as Element;
  const plan = { prototype, actions };
  documents.set(document, plan);
  return plan;
}

/** Clone fresh repeated native output, then install the normal per-instance binding semantics. */
function instantiateNativeTemplate(
  plan: NativeTemplatePlan,
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
  passThrough: readonly RootAttribute[],
  context: RuntimeRenderContext,
): Node[] {
  const element = plan.prototype.cloneNode(true) as Element;
  // Resolve every site before content bindings can change any child list.
  const sites = plan.actions.map((action) => {
    let target: Node = element;
    for (const index of action.path) target = target.childNodes[index]!;
    return target;
  });
  if (node === context.rootNode) context.root = element;
  for (const attribute of passThrough) {
    const own = attribute.name === "class" || attribute.name === "style" ? element.getAttribute(attribute.name) : null;
    element.setAttribute(attribute.name, own === null || own === "" ? attribute.value : `${own}${attribute.name === "class" ? " " : "; "}${attribute.value}`);
  }
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index]!;
    const target = sites[index]!;
    if (action.kind === "attributes") bindElementAttributes(target as Element, action.node, scope, context);
    else if (action.kind === "events") bindEvents(target as Element, action.node, scope, context);
    else if (action.kind === "text") bindTemplateText(target as Text, action.node, scope, context);
    else if (action.kind === "content") ownEffect(context, scope, () => applyContent(target as Element, action.directive, scope, document, context.definition));
  }
  return [element];
}

/** Render one instance of a node (its structural flow already resolved) into 0+ nodes. */
function renderInstance(
  node: ElementNode,
  scope: ReactiveScope,
  document: Document,
  passThrough: readonly RootAttribute[],
  context: RuntimeRenderContext,
  candidate?: Node,
): Node[] {
  const contentDirective = node.attributes.find(
    (attribute): attribute is DirectiveAttribute => attribute.kind === "directive",
  );

  // A <template> is a fragment carrier: it contributes no wrapper element to the output.
  if (node.name === "template") {
    const slot = node.attributes.find((attribute): attribute is LiteralAttribute =>
      attribute.kind === "literal" && attribute.name === "slot");
    if (slot !== undefined) {
      // A consumer's slot template stays inert until the receiving outlet supplies its props.
      const carrier = candidate instanceof HTMLTemplateElement && candidate.getAttribute("slot") === slot.value
        ? candidate : document.createElement("template");
      carrier.setAttribute("slot", slot.value);
      projectedTemplates.set(carrier, { children: node.children, scope, context });
      return [carrier];
    }
    if (contentDirective !== undefined) {
      if (contentDirective.name === "value") {
        const text = document.createTextNode("");
        ownEffect(context, scope, () => {
          const value = evalConforming(contentDirective.expression, scope, context.definition);
          if (value !== NONCONFORMING) text.data = toText(value);
        });
        return [text];
      }
      const start = document.createComment("html-next:html-start");
      const end = document.createComment("html-next:html-end");
      const fragment = document.createDocumentFragment();
      fragment.append(start, end);
      ownEffect(context, scope, () => {
        const value = evalConforming(contentDirective.expression, scope, context.definition);
        if (value === NONCONFORMING) return;
        clearRange(start, end);
        end.before(sanitizeFragment(toText(value), document, markContentOnly));
      });
      return [fragment];
    }
    return renderChildren(node.children, scope, document, context);
  }

  const elementName = node.name;
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
    const invocation = bindInvocation(candidate, node, scope, context, false);
    bindEvents(candidate, node, scope, context, invocation);
    settleInvocation(candidate, invocation);
    return [candidate];
  }
  if (
    context.committed &&
    !context.frameworkOwned &&
    candidate instanceof Element &&
    candidate.localName !== elementName &&
    (candidate.getAttribute("data-component") ?? "").split(/\s+/).includes(node.name)
  ) {
    // A nested component the server already lowered. Keep its root, and bind this
    // definition's nodes that were projected into it: they sit in the nested root's slot ranges (or its
    // carrier), exactly where lowering put them.
    const invocation = bindInvocation(candidate, node, scope, context, false);
    bindEvents(candidate, node, scope, context, invocation);
    settleInvocation(candidate, invocation);
    const nested = serverRanges(candidate, false);
    const slotOf = (child: TemplateNode): string => child.kind === "element"
      ? child.attributes.find((attribute): attribute is LiteralAttribute => attribute.kind === "literal" && attribute.name === "slot")?.value ?? ""
      : "";
    const scopedTemplate = (child: TemplateNode): child is ElementNode => child.kind === "element" && child.name === "template" &&
      child.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "slot");
    const rendered = nested?.ranges.filter((range) => !range.fallback) ?? [];
    const walk = (children: readonly TemplateNode[], existing: readonly Node[]): void => {
      let cursor = 0;
      for (const child of children) cursor += renderTemplateNode(child, scope, document, context, existing[cursor]).length;
    };
    for (const child of node.children) {
      if (!scopedTemplate(child)) continue;
      const carrier = nested?.carried.find((candidate): candidate is HTMLTemplateElement =>
        candidate instanceof HTMLTemplateElement && candidate.getAttribute("slot") === slotOf(child));
      if (carrier !== undefined) renderTemplateNode(child, scope, document, context, carrier);
    }
    for (const range of rendered) walk(node.children.filter((child) => !scopedTemplate(child) && slotOf(child) === range.slot), range.content);
    const renderedSlots = new Set(rendered.map((range) => range.slot));
    walk(node.children.filter((child) => !scopedTemplate(child) && !renderedSlots.has(slotOf(child))), nested?.carried ?? []);
    return [candidate];
  }
  const adopted = candidate instanceof Element && candidate.localName === elementName;
  const element = adopted ? candidate : createTemplateElement(document, elementName, context);
  if (node === context.rootNode) {
    context.root = element;
    if (node.name.includes("-")) whenLowered(element, (root) => { context.root = root; });
  }
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
  // An adopted root already holds its literals merged with its invocation's attributes, which win
  // (class and style combine), so only a literal it lacks is written. A root control's default
  // value and checkedness are the template's again once adopted (below), so those are written.
  const adoptedRoot = adopted && node === context.rootNode;
  const resetDefault = (name: string): boolean => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    (name === "value" || name === "checked");
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal" && !(adoptedRoot && element.hasAttribute(attribute.name) && !resetDefault(attribute.name))) {
      element.setAttribute(attribute.name, attribute.value);
    }
  }
  // Serialized live control values use HTML's default-value attributes until hydration. Once
  // adopted, the authored template regains ownership of reset defaults; the captured live value
  // below is restored separately so pre-hydration edits survive.
  if (adopted && context.committed && !context.frameworkOwned) {
    if (element instanceof HTMLInputElement) {
      if (!node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "value") &&
          node.attributes.some((attribute) => attribute.kind !== "literal" && attribute.name === "value")) {
        element.removeAttribute("value");
      }
      if (!node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "checked") &&
          node.attributes.some((attribute) => attribute.kind !== "literal" && attribute.name === "checked")) {
        element.removeAttribute("checked");
      }
    } else if (element instanceof HTMLOptionElement &&
        !node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "selected")) {
      element.removeAttribute("selected");
    }
  }
  // The invocation's attributes win over the template's literals; class and style combine. Bound
  // attributes, applied next, are the component's own output.
  for (const attribute of passThrough) {
    const own = attribute.name === "class" || attribute.name === "style" ? element.getAttribute(attribute.name) : null;
    element.setAttribute(attribute.name, own === null || own === "" ? attribute.value : `${own}${attribute.name === "class" ? " " : "; "}${attribute.value}`);
  }
  // A component may lower onto any custom-element name. Lowering replaces a registered component's
  // invocation, so nothing attaches to it; an unregistered one keeps its bindings until claimed.
  const invocation = elementName.includes("-") && document.defaultView?.customElements.get(elementName) === undefined
    ? bindInvocation(element, node, scope, context, registryFor(document).definitions.has(elementName)) : undefined;
  if (invocation === undefined) bindElement(element, node, scope, context);

  if (contentDirective !== undefined) {
    ownEffect(context, scope, () => applyContent(element, contentDirective, scope, document, context.definition));
    bindEvents(element, node, scope, context, invocation);
    if (invocation !== undefined) settleInvocation(element, invocation);
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
  // A select's bound value cannot select options until its authored or projected children exist.
  // The binding effect above handles later state changes; this repeats only its initial write.
  // Hydrated controls restore their pre-existing value below, preserving user edits.
  if (element instanceof HTMLSelectElement) {
    const selectBindings = node.attributes.filter((attribute): attribute is AttributeBinding | PropertyBinding =>
      (attribute.kind === "attribute" && attribute.twoWay === true && attribute.name === "value") ||
      (attribute.kind === "property" && attribute.name === "value"));
    if (selectBindings.length > 0) {
      const applySelection = (): void => {
        for (const attribute of selectBindings) {
          const value = evalConforming(attribute.expression, scope, context.definition);
          if (value === NONCONFORMING) continue;
          if (attribute.kind === "property") element.value = value as string;
          else applyBoundControlValue(element, "value", value);
        }
      };
      applySelection();
      selectValueBindings.set(element, applySelection);
      // Projection is moved from the invocation only when its slot anchor is committed.
      if (!context.committed) context.selectBindings.push(applySelection);
    }
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
  bindEvents(element, node, scope, context, invocation);
  if (invocation !== undefined) settleInvocation(element, invocation);
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
  const props = node.props ?? [];
  const carrier = assigned.find((candidate): candidate is HTMLTemplateElement => candidate instanceof HTMLTemplateElement);
  // A consumer's <template slot> renders lazily, like an $if body: only while this outlet renders,
  // in the consumer's scope, and afresh each time. Plain projection stays eager.
  const lazy = props.length > 0 || carrier !== undefined;
  const renderScoped = (existing?: readonly Node[]): Node[] => {
    if (carrier === undefined) fail("HR007", `Scoped slot \`${name}\` requires a consumer <template slot="${name}">.`);
    const authored = projectedTemplates.get(carrier);
    if (authored === undefined && projectedSlotParser === undefined) {
      fail("HR007", "Scoped projection requires the live delivery's parser or a compiled consumer template.");
    }
    const content = authored?.children ?? projectedSlotParser!(carrier, context.definition, props.map((prop) => prop.name));
    const projectedScope = new ReactiveScope([], scope.scheduler, authored?.scope);
    const projectionContext = authored === undefined ? context : Object.create(context, {
      definition: { value: authored.context.definition, enumerable: true },
      refs: { value: authored.context.refs, enumerable: true },
    }) as RuntimeRenderContext;
    for (const prop of props) {
      ownEffect(context, scope, () => {
        const value = evalConforming(prop.expression, scope, context.definition);
        if (value !== NONCONFORMING) projectedScope.set(prop.name, value);
      });
    }
    const rendered = existing === undefined ? renderChildren(content, projectedScope, document, projectionContext) : (() => {
      const adopted: Node[] = [];
      let cursor = 0;
      for (const child of content) {
        const nodes = materialize(renderTemplateNode(child, projectedScope, document, projectionContext, existing[cursor]), document);
        adopted.push(...nodes);
        cursor += nodes.length;
      }
      return adopted;
    })();
    for (const child of rendered) markProjectedRoot(child);
    // host.slots lists these roots while this outlet renders them, following a component's lowered root.
    const roots = rendered.filter((child): child is Element => child.nodeType === 1);
    roots.forEach((root, index) => { if (root.localName.includes("-")) whenLowered(root, (lowered) => { roots[index] = lowered; }); });
    ownEffect(context, scope, () => {
      let renderings = templateRenderings.get(carrier);
      if (renderings === undefined) templateRenderings.set(carrier, renderings = new Set());
      renderings.add(roots);
      return () => { renderings.delete(roots); };
    });
    return rendered;
  };
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
    if (lazy) {
      const adopted = renderScoped(hydrating.content);
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
    const data = `slot=${quoted(name)}${fallback ? ' fallback=""' : ""}${lazy ? ' scoped=""' : ""}`;
    return [instruction("start", data), ...nodes, instruction("end", "")];
  };
  if (assigned.length === 0) {
    return ranged(renderChildren(node.fallback ?? [], scope, document, context), true);
  }
  if (lazy) {
    return ranged(renderScoped(), false);
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
function serverRanges(root: Element, consume = true, tag?: string): { ranges: HydrationRange[]; carried: Node[] } | undefined {
  const ranges: HydrationRange[] = [];
  const inRanges = new Set<Node>();
  const lineage = (root.getAttribute(COMPONENT_ATTRIBUTE) ?? "").split(/\s+/);
  const tagIndex = tag === undefined ? -1 : lineage.indexOf(tag);
  // The innermost delegated component wraps the outer component's projection in its own ranges.
  const delegatedDepth = tagIndex < 0 ? 0 : lineage.length - tagIndex - 1;
  const collect = (nodes: readonly Node[], into: HydrationRange[], depth = delegatedDepth): void => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const mark = serverMark(node);
      if (mark?.target === "marker" && mark.attributes.has("slot")) {
        if (depth === 0) into.push({ slot: mark.attributes.get("slot")!, fallback: false, markers: [node], content: [] });
        continue;
      }
      if (mark?.target === "start") {
        let nesting = 1;
        const content: Node[] = [];
        let end: Node | undefined;
        for (index += 1; index < nodes.length; index += 1) {
          const inner = serverMark(nodes[index]!);
          if (inner?.target === "start") nesting += 1;
          else if (inner?.target === "end" && --nesting === 0) { end = nodes[index]; break; }
          content.push(nodes[index]!);
        }
        if (mark.attributes.has("slot")) {
          if (depth > 0) collect(content, into, depth - 1);
          else into.push({ slot: mark.attributes.get("slot")!, fallback: mark.attributes.has("fallback"), scoped: mark.attributes.has("scoped"), markers: end ? [node, end] : [node], content });
          for (const child of content) inRanges.add(child);
        } else collect(content, into, depth);   // a page's own range is transparent
        continue;
      }
      if (!(node instanceof Element)) continue;
      if (node !== root && node.hasAttribute("data-component")) {
        const nested = serverRanges(node, false);
        for (const range of nested?.ranges ?? []) collect(range.content, into, depth);
      } else collect(Array.from(node.childNodes), into, depth);
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
const FORM_DEFAULTS_ATTRIBUTE = "data-html-next-form-defaults";
const INSTANCE_ATTRIBUTE = "data-html-next-instance";

interface RenderedInstanceRecord {
  readonly explicit: readonly string[];
  readonly inputs: Readonly<Record<string, PropInput>>;
  readonly props: Readonly<Record<string, unknown>>;
  readonly state: Readonly<Record<string, unknown>>;
}

const renderedInstanceRecords = new WeakMap<Element, Readonly<Record<string, RenderedInstanceRecord>>>();

function renderedInstanceRecord(element: Element, tag: string): RenderedInstanceRecord | undefined {
  let records = renderedInstanceRecords.get(element);
  if (records === undefined) {
    const serialized = element.getAttribute(INSTANCE_ATTRIBUTE);
    if (serialized === null) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); }
    catch { fail("HR010", "Malformed rendered component instance record."); }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 1) {
      fail("HR010", "Unsupported rendered component instance record.");
    }
    const decoded = decodeHydrationValue(parsed[1]);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      fail("HR010", "Malformed rendered component instance record.");
    }
    records = decoded as Readonly<Record<string, RenderedInstanceRecord>>;
    for (const record of Object.values(records)) {
      if (record === null || typeof record !== "object" || !Array.isArray(record.explicit) ||
        record.explicit.some((name) => typeof name !== "string") ||
        [record.inputs, record.props, record.state].some((value) => value === null || typeof value !== "object" || Array.isArray(value)) ||
        Object.values(record.inputs).some((input) => input === null || typeof input !== "object" ||
          typeof input.present !== "boolean" || input.source !== "html" && input.source !== "value")) {
        fail("HR010", "Malformed rendered component instance record.");
      }
    }
    renderedInstanceRecords.set(element, records);
    element.removeAttribute(INSTANCE_ATTRIBUTE);
  }
  return Object.hasOwn(records, tag) ? records[tag] : undefined;
}

function instanceRecord(instance: RuntimeInstance): RenderedInstanceRecord {
  return {
    explicit: [...instance.explicit],
    inputs: Object.fromEntries(Object.entries(instance.propInputs).map(([name, signal]) => [name, signal.get()])),
    props: Object.fromEntries(Object.keys(instance.definition.contract.props).map((name) => [name, instance.scope.get(name)])),
    state: Object.fromEntries((instance.definition.declarations ?? [])
      .filter((declaration) => declaration.kind === "state")
      .map((declaration) => [declaration.name, instance.scope.get(declaration.name)])),
  };
}

interface SerializedFormDefaults {
  readonly value?: string;
  readonly valuePresent?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
}

function restoreSerializedFormDefaults(root: Element): void {
  const controls = [root, ...Array.from(root.querySelectorAll(`[${FORM_DEFAULTS_ATTRIBUTE}]`))];
  for (const element of controls) {
    const serialized = element.getAttribute(FORM_DEFAULTS_ATTRIBUTE);
    if (serialized === null) continue;
    element.removeAttribute(FORM_DEFAULTS_ATTRIBUTE);
    let defaults: SerializedFormDefaults;
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      defaults = parsed as SerializedFormDefaults;
    }
    catch { continue; }
    if (element instanceof HTMLInputElement) {
      const value = element.value;
      const checked = element.checked;
      if (typeof defaults.value === "string") {
        element.defaultValue = defaults.value;
        if (defaults.valuePresent === false) element.removeAttribute("value");
      }
      if (typeof defaults.checked === "boolean") element.defaultChecked = defaults.checked;
      element.value = value;
      element.checked = checked;
    } else if (element instanceof HTMLTextAreaElement && typeof defaults.value === "string") {
      const value = element.value;
      element.defaultValue = defaults.value;
      element.value = value;
    } else if (element instanceof HTMLOptionElement && typeof defaults.selected === "boolean") {
      const selected = element.selected;
      element.defaultSelected = defaults.selected;
      element.selected = selected;
    }
  }
}

export function serializeRenderedForm(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  const originals = [container, ...Array.from(container.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  originals.forEach((original, index) => {
    const copy = copies[index]!;
    if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      const defaults: { value?: string; valuePresent?: boolean; checked?: boolean } = {};
      if (original.type !== "file" && original.value !== original.defaultValue) {
        defaults.value = original.defaultValue;
        defaults.valuePresent = original.hasAttribute("value");
        copy.setAttribute("value", original.value);
      }
      if (original.checked !== original.defaultChecked) {
        defaults.checked = original.defaultChecked;
        if (original.checked) copy.setAttribute("checked", "");
        else copy.removeAttribute("checked");
      }
      if (Object.keys(defaults).length > 0) copy.setAttribute(FORM_DEFAULTS_ATTRIBUTE, JSON.stringify(defaults));
    } else if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      if (original.value !== original.defaultValue) {
        copy.textContent = original.value;
        copy.setAttribute(FORM_DEFAULTS_ATTRIBUTE, JSON.stringify({ value: original.defaultValue }));
      }
    } else if (original instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      for (let optionIndex = 0; optionIndex < original.options.length; optionIndex += 1) {
        const option = original.options[optionIndex]!;
        const copiedOption = copy.options[optionIndex]!;
        if (option.selected !== option.defaultSelected) {
          copiedOption.setAttribute(FORM_DEFAULTS_ATTRIBUTE, JSON.stringify({ selected: option.defaultSelected }));
        }
        if (option.selected) copiedOption.setAttribute("selected", "");
        else copiedOption.removeAttribute("selected");
      }
    }
    const instance = runtimeInstance(original);
    const compiled = instance === undefined ? compiledHandle(original) : undefined;
    if (instance !== undefined) {
      const records = Object.fromEntries([instance, ...instance.delegates].map((entry) => [entry.definition.contract.tag, instanceRecord(entry)]));
      copy.setAttribute(INSTANCE_ATTRIBUTE, JSON.stringify([1, encodeHydrationValue(records)]));
    } else if (compiled !== undefined) {
      const records = Object.fromEntries([compiled, ...compiled.D ?? []].map((entry) => [entry.S.g, compiledRecord(entry)]));
      copy.setAttribute(INSTANCE_ATTRIBUTE, JSON.stringify([1, encodeHydrationValue(records)]));
    }
    const projected = instance?.projection?.nodes ?? compiled?.J?.map(([node]) => node);
    if (projected === undefined) return;
    const unrendered = projected.filter((node) => !original.contains(node));
    if (unrendered.length === 0) return;
    const carrier = clone.ownerDocument.createElement("template");
    for (const node of unrendered) carrier.content.append(node.cloneNode(true));
    copies[index]!.append(renderedFormMark(clone.ownerDocument, "carrier", ""), carrier);
  });
  // Compiled keyed rows are their element, without item markers (owner decision 2a). Hydration
  // adopts rows by their markers, so a region whose first child is not one gets them back here.
  const regions = clone.ownerDocument.createTreeWalker(clone, 128 /* SHOW_COMMENT */);
  for (let node = regions.nextNode(); node !== null; node = regions.nextNode()) {
    if ((node as Comment).data !== "html-next:each-start") continue;
    const first = node.nextSibling;
    if (first === null || first.nodeType === 8 && /^html-next:(?:item-start|each-end)$/.test((first as Comment).data)) continue;
    for (let row: ChildNode | null = first; row !== null && !(row.nodeType === 8 && (row as Comment).data === "html-next:each-end");) {
      const next: ChildNode | null = row.nextSibling;
      row.before(clone.ownerDocument.createComment("html-next:item-start"));
      row.after(clone.ownerDocument.createComment("html-next:item-end"));
      row = next;
    }
  }
  // Serialize marks in the HTML spelling every parser accepts: a PI in supporting browsers and
  // the fallback comment elsewhere. Node's DOM and a browser need not support the same node type.
  const marks: string[] = [];
  let prefix = "html-next:serialized-mark:";
  const existingMarkup = clone.innerHTML;
  while (existingMarkup.includes(prefix)) prefix += ":";
  const walker = clone.ownerDocument.createTreeWalker(clone, 64 | 128 /* SHOW_PROCESSING_INSTRUCTION | SHOW_COMMENT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const mark = serverMark(node);
    if (mark === undefined || !["start", "end", "marker", "carrier"].includes(mark.target)) continue;
    if ((mark.target === "start" || mark.target === "marker") && !mark.attributes.has("slot")) continue;
    const attributes = [...mark.attributes].map(([name, value]) =>
      `${name}="${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"`).join(" ");
    marks.push(`<?${mark.target}${attributes === "" ? "" : ` ${attributes}`}?>`);
    const placeholder = clone.ownerDocument.createComment(`${prefix}${marks.length - 1}`);
    node.parentNode!.replaceChild(placeholder, node);
    walker.currentNode = placeholder;
  }
  return clone.innerHTML.replace(new RegExp(`<!--${prefix}(\\d+)-->`, "g"), (source, index: string) => marks[Number(index)] ?? source);
}

/**
 * Diagnostic: an instance's internal shape (definition, explicit props, prop values, projected nodes per
 * slot). Two instances with equal shapes behave identically; conformance tests compare them.
 */
export function inspectInstance(element: Element): unknown {
  const instance = runtimeInstance(element);
  if (instance !== undefined) return inspectRuntimeInstance(instance);
  const handle = compiledHandle(element);
  return handle === undefined ? undefined : inspectCompiled(handle, handle.D ?? []);
}

function inspectCompiled(handle: CompiledHandle, delegates: readonly CompiledHandle[]): unknown {
  const record = compiledRecord(handle);
  return { tag: handle.S.g, explicit: [...record.explicit].sort(), props: record.props, state: record.state,
    slots: inspectedSlots(handle.J ?? []), delegates: delegates.map((delegate) => inspectCompiled(delegate, [])) };
}

/** Each slot's projected nodes, as inspection shows them. */
function inspectedSlots(projected: readonly (readonly [Node, string])[]): Record<string, string[]> {
  const slots: Record<string, string[]> = {};
  for (const [node, slot] of projected) {
    (slots[slot] ??= []).push(node instanceof Element ? node.outerHTML.replace(/ data-slotted=""/g, "") : node.textContent ?? "");
  }
  // Order across slots is not observable; order within a slot is.
  return Object.fromEntries(Object.entries(slots).sort(([a], [b]) => a.localeCompare(b)));
}

function inspectRuntimeInstance(instance: RuntimeInstance): unknown {
  const props: Record<string, unknown> = {};
  for (const name of Object.keys(instance.definition.contract.props)) props[name] = instance.scope.get(name);
  const slots = inspectedSlots((instance.projection?.nodes ?? []).map((node) => [node,
    instance.projection!.slotNames.get(node) ?? (node instanceof Element ? node.getAttribute("slot") ?? "" : "")]));
  return { tag: instance.definition.contract.tag, explicit: [...instance.explicit].sort(), props,
    state: instanceRecord(instance).state, slots, delegates: instance.delegates.map(inspectRuntimeInstance) };
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
    bindTemplateText(text, node, scope, context);
    return [text];
  }
  if (node.kind === "slot") return node.flow === undefined
    ? renderSlot(node, scope, document, context)
    : renderEachRegion(node, scope, document, [], context, candidate);
  return renderNode(node, scope, document, [], context, candidate);
}

/**
 * Keeps `data-<tag>-state` in step with the resolved props and state the definition's `:host-state()`
 * rules test, so styles see defaults and state as well as explicit props.
 */
function installStateAttribute(instance: RuntimeInstance): void {
  const names = stateNamesByDefinition.get(instance.definition) ?? [];
  if (names.length === 0) return;
  const attribute = stateAttribute(instance.definition.contract.tag);
  instance.effects.push(createEffect(instance.scope.scheduler, () => {
    const root = instance.rootElement.get();
    if (root === undefined) return;
    const value = stateAttributeValue(names, (name) => instance.scope.get(name));
    if (value === "") root.removeAttribute(attribute);
    else if (root.getAttribute(attribute) !== value) root.setAttribute(attribute, value);
  }, 2));
}

/**
 * Records the author's explicit props on the lowered root as `data-<name>` so the element shows
 * which options produced it and server output can be hydrated. Defaults are not written unless the
 * template binds the attribute itself, and no JavaScript properties are added. The record is output:
 * props change through bindings and framework adapters, never by writing these attributes.
 */
function installPropReflection(instance: RuntimeInstance): void {
  // `data-<name>` records the configuration; it is output, never read back after lowering.
  for (const [name, prop] of Object.entries(instance.definition.contract.props)) {
    const attributeName = `data-${kebabCase(name)}`;
    instance.effects.push(createEffect(instance.scope.scheduler, () => {
      const root = instance.rootElement.get();
      if (root === undefined) return;
      // When the template binds this attribute itself it is template output and always shows the
      // effective value (defaults included), matching the compiled runtime's `bound` props.
      const bound = instance.rootNode.attributes.some((binding) =>
        binding.kind === "attribute" && binding.name === attributeName
      );
      const value = instance.scope.get(name);
      if (!bound && !instance.explicit.has(name)) return;
      // Null is "no value" at the attribute boundary: it removes the attribute rather than
      // writing text that would not parse back.
      const selected = selectedPropType(instance.definition.contract, prop,
        prop.select === undefined ? {} : { [prop.select.from]: instance.scope.get(prop.select.from) });
      const serialized = value === undefined || value === ABSENT || value === null
        ? null : reflectedPropValue(value, selected);
      if (serialized === null) root.removeAttribute(attributeName);
      else root.setAttribute(attributeName, serialized);
    }, 2));
  }

}

function prepareRuntimeInvocation(
  invocation: Element,
  definition: ComponentDefinition,
  hydration: boolean,
  projectedNodes?: readonly Node[],
  projectedSlotNames = new WeakMap<Node, string>(),
  frameworkOwned = false,
  parent?: RuntimeInstance,
  frameworkProps?: Readonly<Record<string, unknown>>,
): PreparedInvocation {
  const focusedControl = hydration && invocation.contains(invocation.ownerDocument.activeElement)
    ? invocation.ownerDocument.activeElement
    : null;
  const focusedSelection = focusedControl instanceof HTMLInputElement || focusedControl instanceof HTMLTextAreaElement
    ? [focusedControl.selectionStart, focusedControl.selectionEnd] as const
    : undefined;
  const { scope, passThrough, effects, explicit, propInputs } = readInvocation(invocation, definition, hydration, parent, frameworkProps);
  const rootNode = elementMatchRoot(componentRoot(definition, scope));
  const rootWith = rootNode.flow?.kind === "with" ? rootNode.flow : undefined;
  const renderScope = rootWith === undefined ? scope : scope.fork();
  const instanceEffects = [...effects];
  if (rootWith !== undefined) {
    let previous: Value = null;
    instanceEffects.push(renderScope.defineComputed(rootWith.alias, () => {
      const next = evalConforming(rootWith.expr, scope, definition);
      if (next !== NONCONFORMING) previous = next;
      return previous;
    }));
  }
  let hydratedNodes = projectedNodes;
  let hydrationRanges: HydrationRange[] | undefined;
  if (hydration && hydratedNodes === undefined) {
    const server = serverRanges(invocation, true, definition.contract.tag);
    if (server !== undefined) {
      // The rendered form names every slot range, and the serializer carried the
      // projected nodes no slot currently renders. Together they are the authored projection.
      hydrationRanges = server.ranges;
      const nodes: Node[] = [];
      for (const range of server.ranges) {
        if (range.fallback || range.scoped) continue;
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
  const children: Node[] = hydration ? [...hydratedNodes!] : Array.from(invocation.childNodes);
  const projected = hydration ? children : Array.from(invocation.childNodes);
  const replaceProjected = (current: Node, next: Node): void => {
    for (const nodes of [children, projected]) {
      const index = nodes.indexOf(current);
      if (index >= 0) nodes[index] = next;
    }
    const slot = projectedSlotNames.get(current);
    if (slot !== undefined) projectedSlotNames.set(next, slot);
  };
  // A projected component invocation lowers to its own root, perhaps only once a slot renders it.
  // The projection follows that root, so a slot that renders again inserts it, not the invocation
  // element lowering replaced. A later root switch calls the same rebind with the new root.
  for (const node of children) {
    if (node.nodeType !== 1 || !(node as Element).localName.includes("-")) continue;
    let current: Node = node;
    whenLowered(node as Element, (root) => {
      replaceProjected(current, root);
      current = root;
    });
  }
  const instance: RuntimeInstance = {
    definition,
    ...(parent === undefined ? {} : { parent }),
    scope,
    propInputs,
    refs: {},
    effects: instanceEffects,
    connected: false,
    explicit,
    frameworkOwned,
    delegates: [],
    followers: [],
    owned: renderOwned(),
    rootNode,
    rootElement: createSignal<Element | undefined>(undefined),
    projection: { nodes: projected, slotNames: projectedSlotNames, replace: replaceProjected },
  };
  if (Object.keys(definition.contract.props).length > 0) {
    instance.effects.push(createEffect(scope.scheduler, () => {
      const root = instance.rootElement.get();
      if (root !== undefined) setElementValidity(root, rootPropValidity(runtimeInstance(root) ?? instance));
    }, 2));
  }
  const context: RuntimeRenderContext = {
    definition,
    owned: instance.owned,
    refs: instance.refs,
    projectedNodes: children,
    projectedSlotNames,
    slotInsertions: [],
    selectBindings: [],
    rootNode,
    frameworkOwned,
    committed: hydration,
    hydrationRanges,
  };
  const renderRootNode: ElementNode = rootWith === undefined
    ? rootNode
    : (({ flow: _flow, ...body }) => body)(rootNode);
  const rendered = renderNode(
    renderRootNode,
    renderScope,
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
  if (rootArms(definition.template) !== undefined) installRootSwitch(instance, context);
  return {
    invocation,
    nativeRoot,
    context,
    definition,
    instance,
    replace: !hydration,
  };
}

/** Capture the closest component owner while an invocation still sits in its authored tree. */
function invocationParent(element: Element, pending: WeakMap<Element, RuntimeInstance>): RuntimeInstance | undefined {
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const prepared = pending.get(ancestor);
    if (prepared !== undefined) return prepared;
    const existing = runtimeInstance(ancestor);
    if (existing !== undefined) return existing;
  }
  return undefined;
}

/** An attribute a root receives from outside its template: the invocation, a factory, or page code. */
type RootAttribute = Pick<Attr, "name" | "value">;

/**
 * Ties an instance to its root element. Lowering and every later replacement of the root come here,
 * and the effects tied to the root read `rootElement`, so they move to the new element too.
 */
function attachRoot(instance: RuntimeInstance, element: Element): void {
  const previous = instance.rootElement.get();
  if (previous !== undefined && previous !== element) {
    // The replaced element keeps resolving to this instance, so a reference a caller kept, such
    // as the element a factory returned, still reaches the component.
    const lifecycle = (previous as RuntimeElement)[lifecycleKey];
    if (lifecycle !== undefined) {
      delete (previous as RuntimeElement)[lifecycleKey];
      (element as RuntimeElement)[lifecycleKey] = lifecycle;
      lifecycle.element = element;
    }
    documentState(element.ownerDocument).move?.(previous, element);
  }
  instance.element = element;
  instance.validityCleanup?.();
  if (Object.keys(instance.definition.contract.props).length > 0) {
    instance.validityCleanup = manageDerivedValidity(element, () => rootPropValidity(instance));
  }
  for (const delegate of instance.delegates) {
    delegate.element = element;
    delegate.rootElement.set(element);
  }
  runtimeInstances.set(element, instance);
  instance.rootElement.set(element);
  // A delegated root may already have followers before its first native root is installed.
  if (previous !== element) followRoot(instance, element);
}

/**
 * A root `$match` follows its props like any other `$match`: when they choose another arm, the new
 * native root takes the old one's place. It keeps every attribute the old arm's template did not
 * write, so the invocation's, a factory's, and page code's attributes carry over.
 */
function installRootSwitch(instance: RuntimeInstance, context: RuntimeRenderContext): void {
  const { definition, scope } = instance;
  const tag = definition.contract.tag;
  instance.effects.push(createEffect(scope.scheduler, () => {
    const next = componentRoot(definition, scope);
    const previous = instance.element;
    if (next === instance.rootNode || !context.committed || previous === undefined) return;
    // Reflected props, the state attribute, and bound attributes are rewritten by their own effects.
    // A literal is the old arm's only when it still holds the arm's value; a different value is the
    // consumer's override, which carries over as it would have applied to any arm.
    const literals = new Map<string, string>();
    const written = new Set([
      stateAttribute(tag),
      ...Object.keys(definition.contract.props).map((name) => `data-${kebabCase(name)}`),
    ]);
    // Class tokens and style properties are shared with the consumer, so only the old arm's own go.
    // The browser's CSS parser names the properties its style writes, shorthands as their longhands.
    const ownClasses = new Set<string>();
    const ownStyle = (previous.ownerDocument.createElement("div")).style;
    for (const attribute of instance.rootNode.attributes) {
      if (attribute.kind === "literal" && attribute.name === "class") {
        for (const token of attribute.value.split(/\s+/)) ownClasses.add(token);
      } else if (attribute.kind === "attribute" && attribute.target === "class") {
        ownClasses.add(attribute.name);
      } else if (attribute.kind === "literal" && attribute.name === "style") {
        ownStyle.cssText += `;${attribute.value}`;
      } else if (attribute.kind === "attribute" && attribute.target === "style") {
        ownStyle.setProperty(attribute.name, "initial");
      } else if (attribute.kind === "literal") {
        literals.set(attribute.name, attribute.value);
      } else if (attribute.kind === "attribute") {
        written.add(attribute.name);
      } else if (attribute.kind === "property") {
        // A reflecting property writes its attribute: `.disabled` writes `disabled`.
        // ponytail: lowercase plus htmlFor; a property whose attribute differs otherwise carries over.
        written.add(attribute.name === "htmlFor" ? "for" : attribute.name.toLowerCase());
      }
    }
    const ownStyles = new Set(Array.from(ownStyle));
    const carried: RootAttribute[] = [];
    for (const attribute of Array.from(previous.attributes)) {
      if (attribute.name === "class") {
        const value = attribute.value.split(/\s+/).filter((token) => token !== "" && !ownClasses.has(token)).join(" ");
        if (value !== "") carried.push({ name: "class", value });
      } else if (attribute.name === "style") {
        const style = (previous as HTMLElement).style;
        const value = Array.from(style).filter((property) => !ownStyles.has(property)).map((property) =>
          `${property}: ${style.getPropertyValue(property)}${style.getPropertyPriority(property) === "" ? "" : " !important"}`
        ).join("; ");
        if (value !== "") carried.push({ name: "style", value });
      } else if (!written.has(attribute.name) && literals.get(attribute.name) !== attribute.value) {
        carried.push({ name: attribute.name, value: attribute.value });
      }
    }

    instance.owned.stop();
    instance.owned = context.owned = renderOwned();
    for (const ref of Object.keys(instance.refs)) delete instance.refs[ref];
    context.rootNode = instance.rootNode = next;
    const document = previous.ownerDocument;
    const active = document.activeElement;
    const focusIndex = active !== null && active !== previous && previous.contains(active)
      ? Array.from(previous.querySelectorAll(FOCUSABLE)).indexOf(active)
      : -1;
    const element = renderNode(next, scope, document, carried, context)[0] as Element;
    previous.replaceWith(element);
    // When this component is another's root, the instance registered on the element is that one.
    attachRoot(runtimeInstances.get(previous) ?? instance, element);
    // Focus stays where it was: on the root, on moved projected content, or on the template's
    // control in the same position among the root's focusable elements.
    const target = active === previous ? element
      : active?.isConnected === true && element.contains(active) ? active
      : focusIndex >= 0 ? element.querySelectorAll(FOCUSABLE)[focusIndex]
      : undefined;
    (target as HTMLElement | undefined)?.focus?.({ preventScroll: true });
  }, 0));
}

// ponytail: a focusability approximation for restoring focus across a root switch.
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]";

function commitRuntimeInvocations(
  registry: DocumentRegistry,
  prepared: PreparedInvocation[],
): void {
  // Commit ancestors first so their slot insertion moves nested live invocations before
  // descendants replace themselves. Discovery order does not determine nested survival.
  prepared.sort((left, right) => {
    if (left.invocation === right.invocation) return 0;
    if (left.invocation.contains(right.invocation)) return -1;
    if (right.invocation.contains(left.invocation)) return 1;
    return 0;
  });
  // A delegated root renders another component's invocation, which this same pass lowers to its
  // own root. Follow that chain so every instance installs on, and is rooted at, the element that
  // actually survives in the document.
  const byInvocation = new Map(prepared.map((entry) => [entry.invocation, entry]));
  const hostRootFor = (entry: PreparedInvocation): Element => {
    let root = entry.nativeRoot;
    const seen = new Set<Element>([entry.invocation]);
    for (let next = byInvocation.get(root); next !== undefined; next = byInvocation.get(root)) {
      if (seen.has(root)) break;
      seen.add(root);
      root = next.nativeRoot;
    }
    return root;
  };

  for (const invocation of prepared) {
    for (const insertion of invocation.context.slotInsertions) {
      for (const child of insertion.nodes) markProjectedRoot(child);
      insertion.anchor.replaceWith(...insertion.nodes);
    }
    for (const applySelection of invocation.context.selectBindings) applySelection();
    invocation.context.selectBindings.length = 0;
    const host = hostRootFor(invocation);
    invocation.host = host;
    if (invocation.replace) {
      supersededInvocations.add(invocation.invocation);
      invocation.invocation.replaceWith(invocation.nativeRoot);
      runtimeInstances.delete(invocation.invocation);
      // Whatever a parent deferred for this invocation now has the element it was waiting for.
      for (const rebind of rebindOnLower.get(invocation.invocation) ?? []) {
        rebind(host);
        invocation.instance.followers.push(rebind);
      }
      rebindOnLower.delete(invocation.invocation);
    }
    invocation.context.committed = true;
    invocation.instance.element = host;
    if (invocation.replace && host === invocation.nativeRoot && invocation.definition.root?.kind === "component") {
      // This component delegates its root to a component that has not lowered yet. Claim the
      // element so discovery does not lower this component onto it a second time, but install
      // nothing: reflection and the host belong on the root that survives.
      // An earlier rebind may already have carried an outer owner onto this intermediate root.
      const owner = runtimeInstances.get(host) ?? invocation.instance;
      runtimeInstances.set(host, owner);
      whenLowered(host, (finalRoot) => {
        if (runtimeInstances.get(host) === owner) runtimeInstances.delete(host);
        if (owner !== invocation.instance) runtimeInstances.set(finalRoot, owner);
        adoptComponentRoot(invocation.instance, finalRoot);
        if (owner !== invocation.instance) attachRoot(owner, finalRoot);
      });
    } else {
      adoptComponentRoot(invocation.instance, host);
    }
    if (claimInvocationBindings(invocation.invocation, invocation.instance)) {
      const root = untracked(() => invocation.instance.rootElement.get());
      // A delegate claims after the component it serves attached the root; keep inner before outer.
      if (root !== undefined) followRoot(runtimeInstances.get(root) ?? invocation.instance, root);
    }
    connectRuntimeInstance(invocation.instance);
  }
}

/**
 * Binds an instance to the root it ends up sharing. The component the author invoked claims the
 * root, so page code reaches its host and reflected props; a component it
 * delegates to shares the element and rides the owner's connection lifecycle.
 */
/**
 * Lowers the components a committed batch rendered, and the components those render in turn.
 *
 * A component's invocations only exist once it renders, so one lowering call has to follow them.
 * Otherwise nested components stay inert until something else observes the document, which a build
 * -time delivery has no reason to do.
 */
function lowerRenderedComponents(
  root: Document,
  registry: DocumentRegistry,
  committed: readonly PreparedInvocation[],
  shouldLower?: (element: Element, definition: ComponentDefinition, hydration: boolean) => boolean,
): Element[] {
  const lowered: Element[] = [];
  let batch = committed;
  for (let pass = 0; ; pass += 1) {
    // Only a component whose template can invoke another is worth rescanning.
    const rendered = batch.filter((invocation) => mayInvokeComponents(invocation.definition));
    if (rendered.length === 0) return lowered;
    if (pass >= maximumNestedLoweringPasses) {
      fail("HR008", "Component invocations nested deeper than the lowering limit.");
    }
    const nested = new Set<Element>();
    const selector = discoverySelector(registry);
    for (const invocation of rendered) {
      collectWithin(invocation.host ?? invocation.nativeRoot, selector, nested);
    }
    const prepared: PreparedInvocation[] = [];
    const pendingOwners = new WeakMap<Element, RuntimeInstance>();
    const unrendered = new Set<Node>();
    for (const element of nested) {
      const live = registry.definitions.get(element.localName);
      if (live === undefined) continue;
      const { definition } = live;
      if (
        isContentOnly(element) ||
        withinUnrendered(element, unrendered) ||
        supersededInvocations.has(element) ||
        alreadyLowered(element, definition.contract.tag) ||
        root.defaultView?.customElements.get(definition.contract.tag) !== undefined ||
        shouldLower?.(element, definition, false) === false
      ) continue;
      const invocation = prepareRuntimeInvocation(element, definition, false, undefined, undefined, false, invocationParent(element, pendingOwners));
      prepared.push(invocation);
      pendingOwners.set(element, invocation.instance);
      recordUnrendered(invocation, unrendered);
    }
    if (prepared.length === 0) return lowered;
    commitRuntimeInvocations(registry, prepared);
    for (const invocation of prepared) lowered.push(invocation.host ?? invocation.nativeRoot);
    batch = prepared;
  }
}

/**
 * Whether a definition can invoke another component, which decides whether lowering it is worth
 * rescanning its output for. A component tag always contains a hyphen, and a delegated root names
 * one outright, so this answers from the definition alone. Cached: templates do not change.
 */
const componentInvokers = new WeakMap<ComponentDefinition, boolean>();

function mayInvokeComponents(definition: ComponentDefinition): boolean {
  let known = componentInvokers.get(definition);
  if (known !== undefined) return known;
  known = definitionMayInvokeComponents(definition);
  componentInvokers.set(definition, known);
  return known;
}

/** Whether this element is already the lowered root of the named component. */
function alreadyLowered(element: Element, tag: string): boolean {
  const claimed = runtimeInstances.get(element);
  if (claimed === undefined) return false;
  return claimed.definition.contract.tag === tag ||
    claimed.delegates.some((delegate) => delegate.definition.contract.tag === tag);
}

function adoptComponentRoot(instance: RuntimeInstance, root: Element): void {
  instance.element = root;
  const owner = runtimeInstances.get(root);
  if (owner === undefined) {
    attachRoot(instance, root);
    installPropReflection(instance);
    installStateAttribute(instance);
    return;
  }
  if (owner !== instance && !owner.delegates.includes(instance)) {
    owner.delegates.push(instance);
    instance.rootElement.set(root);
    installPropReflection(instance);
    installStateAttribute(instance);
    if (owner.validityCleanup === undefined && Object.keys(instance.definition.contract.props).length > 0) {
      owner.validityCleanup = manageDerivedValidity(root, () => rootPropValidity(owner));
    }
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
    if (element.localName === "template" && element.hasAttribute("component") && !isContentOnly(element)) {
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

  // Parent bindings can run while their child invocations are being prepared. Make every newly
  // parsed contract available for the bound-value type check before preparing any parent.
  const existingDefinitions = new Map(registry.definitions);
  for (const live of definitions) registerDefinition(registry, live.definition.contract.tag, live);

  const roots = new Set<Element>();
  const lowered: Element[] = [];
  const prepared: PreparedInvocation[] = [];
  const pendingOwners = new WeakMap<Element, RuntimeInstance>();
  const unrendered = new Set<Node>();
  const prepare = (live: LiveDefinition, element: Element, hydration: boolean): boolean => {
    const { definition } = live;
    if (
      isContentOnly(element) ||
      !hydration && withinUnrendered(element, unrendered) ||
      supersededInvocations.has(element) ||
      // Already lowered here: a repeat pass must not build this component onto its own root a
      // second time. Another component still may, which is how a delegated root lowers.
      alreadyLowered(element, definition.contract.tag) ||
      root.defaultView?.customElements.get(definition.contract.tag) !== undefined ||
      shouldLower?.(element, definition, hydration) === false
    ) return false;
    if (hydration) restoreSerializedFormDefaults(element);
    const invocation = prepareRuntimeInvocation(element, definition, hydration, undefined, undefined, false, invocationParent(element, pendingOwners));
    prepared.push(invocation);
    pendingOwners.set(element, invocation.instance);
    if (!hydration) recordUnrendered(invocation, unrendered);
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
      // Generated output registered this root's lifecycle itself; it is rendered and owned, not server markup.
      if ((element as RuntimeElement)[lifecycleKey] !== undefined) continue;
      let accepted = false;
      for (const tag of new Set((element.getAttribute("data-component") ?? "").split(/\s+/))) {
        const owner = byTag.get(tag);
        if (owner !== undefined && prepare(owner, element, true)) accepted = true;
      }
      if (accepted) roots.add(element);
    }
  };
  collect(existingDefinitions, discovered);
  // A newly discovered definition also applies to matching invocations that predate it.
  if (newDefinitions.size > 0) {
    const pendingSelector = [
      "[data-component]",
      ...Array.from(newDefinitions.keys()),
    ].join(",");
    const existing = new Set<Element>();
    collectWithin(root, pendingSelector, existing);
    collect(newDefinitions, existing);
  }

  for (const live of definitions) {
    const style = installComponentStyles(live.definition, live.wrapper!.ownerDocument,
      live.style?.localName === "style" ? live.style as HTMLStyleElement : undefined);
    registry.definitions.set(live.definition.contract.tag, { ...live, style });
    live.wrapper!.remove();
  }

  commitRuntimeInvocations(registry, prepared);
  for (const invocation of prepared) {
    const element = invocation.host ?? invocation.nativeRoot;
    lowered.push(element);
    roots.add(element);
  }
  for (const element of lowerRenderedComponents(root, registry, prepared, shouldLower)) {
    lowered.push(element);
    roots.add(element);
  }

  return { lowered, roots: Array.from(roots) };
}

/**
 * Performs one explicit lowering pass, retaining definitions in a document registry for
 * later passes. It does not observe mutations or register Custom Elements.
 */
export interface DocumentRenderingOptions {
  /** Render the declarative baseline without starting reads or connecting browser lifecycle. */
  readonly connect?: boolean;
}

export function lowerDocument(root: Document = document, options: DocumentRenderingOptions = {}): number {
  const state = documentState(root);
  const wasStatic = state.staticRendering;
  state.staticRendering = options.connect === false;
  const result = lowerScopes(root, [root]);
  if (wasStatic && !state.staticRendering) {
    for (const element of result.roots) {
      const instance = runtimeInstance(element);
      if (instance !== undefined) connectRuntimeInstance(instance);
    }
  }
  return result.lowered.length;
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
  /** The element that carries the record; a root switch moves it. */
  element: Element;
  /** A compiled root's handle (see `CompiledHandle`). */
  readonly h?: unknown;
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
    connect: (current) => attachRuntimeComponent(current, definition, options, false),
    disconnect: undefined,
    element,
  };
  coordinator.add(element, record);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    coordinator.remove(record.element, record);
  };
}

/** Registers already parsed package definitions without manufacturing live `<template>` nodes. */
export function registerComponentDefinitions(
  definitions: readonly ComponentDefinition[],
  root: Document = document,
  styleCompiler?: (css: string, definition: ComponentDefinition) => CompiledComponentStyles,
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
      style: installComponentStyles(definition, root, undefined, styleCompiler),
    });
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
  return attachRuntimeComponent(element, definition, options, true);
}

/** Native factories own their structural bindings; framework adapters own their renderer's DOM. */
function attachRuntimeComponent(
  element: Element,
  definition: ComponentDefinition,
  options: ComponentAttachmentOptions,
  frameworkOwned: boolean,
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
  if (frameworkOwned && observed !== undefined && !observed.frameworkOwned) {
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
      if (value !== undefined && value !== null) {
        if (prop.select !== undefined && definition.contract.props[prop.select.from] === undefined) continue;
        const selected = selectedPropType(definition.contract, prop, options.props ?? {});
        element.setAttribute(`data-${kebabCase(name)}`, reflectedPropValue(value, selected));
      }
    }
    const attaching = [
      prepareRuntimeInvocation(element, definition, true, projected, projectedSlotNames, frameworkOwned, invocationParent(element, new WeakMap()), options.props),
    ];
    commitRuntimeInvocations(registry, attaching);
    // Generated output attaches its own root, so nothing else will lower the components this
    // template invokes; they lower here, from the definitions the graph registered.
    lowerRenderedComponents(root, registry, attaching);
  }

  const attached = runtimeInstance(element);
  if (attached === undefined) fail("HR005", `Could not attach <${definition.contract.tag}> to its native root.`);
  // The options' props are the instance's initial input; a reconnect keeps whatever they became since.
  if (instance === undefined) updateComponentProps(element, options.props ?? {});
  connectRuntimeInstance(attached);

  let controllerCleanup: void | (() => void);
  let disposed = false;
  if (options.controller !== undefined && !attached.controllerInitialized) {
    attached.controllerInitialized = true;
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
  // A compiled root takes them through its own prop channel, which applies them as below.
  if (instance === undefined) compiledHandle(element)?.B?.u?.(props);
  else applyComponentProps(instance, props);
}

/**
 * Replaces a node in the document, as a framework changes the content it passes a kept component:
 * when a live component projects `current` into a slot, `next` takes its place there too, so the
 * slot renders it again, `host.slots` and the rendered form list it, and slotted styles reach it.
 */
export function replaceProjectedNode(current: ChildNode, next: ChildNode): void {
  for (let element = current.parentElement; element !== null; element = element.parentElement) {
    const instance = runtimeInstance(element);
    const owner = instance === undefined ? undefined
      : [instance, ...instance.delegates].find((candidate) => candidate.projection?.nodes.includes(current));
    if (owner === undefined) continue;
    owner.projection!.replace(current, next);
    markProjectedRoot(next);
    break;
  }
  current.replaceWith(next);
}

/**
 * Carries a fresh server rendering's props onto a live instance that a framework keeps, through
 * the same channel as `updateComponentProps`: `rendered` is that component's root in the new
 * server output, not yet hydrated. The instance keeps its DOM, state, and controller; props the
 * rendering left implicit return to their defaults.
 */
export function adoptRenderedProps(element: Element, rendered: Element): void {
  const instance = runtimeInstance(element);
  const record = instance === undefined ? undefined : renderedInstanceRecord(rendered, instance.definition.contract.tag);
  if (instance === undefined || record === undefined) {
    fail("HR005", "The rendered element records no props for this element's component.");
  }
  applyComponentProps(instance, Object.fromEntries(Object.keys(instance.definition.contract.props)
    .map((name) => [name, record.explicit.includes(name) ? record.props[name] : undefined])));
}

/** Applies props to one named instance, which a shared root makes explicit. */
function applyComponentProps(
  instance: RuntimeInstance,
  props: Readonly<Record<string, unknown>>,
): void {
  // The current root: a root `$match` may have replaced the element a caller last saw.
  const element = instance.element!;
  const contract = instance.definition.contract;
  // Source validation stays tracked; reading the child's current model is write bookkeeping.
  const next = untracked(() => {
    const values = Object.fromEntries(Object.keys(contract.props).map((name) => [name, instance.scope.get(name)]));
    for (const prop of Object.values(contract.props)) {
      if (prop.select !== undefined && contract.props[prop.select.from] === undefined) {
        values[prop.select.from] = instance.scope.get(prop.select.from);
      }
    }
    return values;
  });
  for (const [name, input] of Object.entries(props)) {
    const prop = contract.props[name];
    if (prop !== undefined && prop.select === undefined) {
      const accepted = assignedPropValue(prop, input) as Value | undefined;
      if (accepted !== undefined) next[name] = accepted;
    }
  }
  for (const [name, input] of Object.entries(props)) {
    const prop = contract.props[name];
    if (prop !== undefined && prop.select !== undefined) {
      const accepted = assignedPropValue(prop, input, selectedPropType(contract, prop, next)) as Value | undefined;
      if (accepted !== undefined) next[name] = accepted;
    }
  }
  for (const [name, input] of Object.entries(props)) {
    const prop = contract.props[name];
    if (prop === undefined) continue;
    instance.propInputs[name]!.set({ value: input === undefined ? null : input, source: "value", present: input !== undefined });
    const attributeName = `data-${kebabCase(name)}`;
    const value = next[name] as Value;
    // A bound data-* attribute is template output. Direct input still updates the prop handle,
    // but only the binding may write that output (and an invalid input cannot trigger it).
    const bound = instance.rootNode.attributes.some((binding) =>
      binding.kind === "attribute" && binding.name === attributeName);
    // Null has no attribute form, but remains the effective in-memory prop value.
    if (input === undefined || input === null) {
      instance.explicit.delete(name);
      // An attribute the template binds is its own output (it shows the default); leave it be.
      if (!bound) element.removeAttribute(attributeName);
    } else {
      instance.explicit.add(name);
      const selected = selectedPropType(contract, prop, next);
      if (!bound) element.setAttribute(attributeName, reflectedPropValue(input, selected));
    }
    if (!Object.is(untracked(() => instance.scope.get(name)), value)) instance.scope.set(name, value);
  }
}

/**
 * Capabilities owned by one component instance. Properties and methods are receiver-independent,
 * so controllers may destructure only the capabilities they use in their parameter list.
 */
export interface ComponentHost {
  /** The component's root element. Its connection owns this controller's lifetime. */
  readonly root: Element;
  /** Alias for the rendered root used by generated component controllers. */
  readonly element: Element;
  /** Mutable state, readonly computed state and inherited context; never props or resources. */
  readonly state: Record<string, unknown>;
  /** Declared resource handles; response and status fields are readonly. */
  readonly data: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Subscribe to a connection lifecycle or DOM event, with lifecycle-owned cleanup. */
  on(type: string, callback: (event: Event) => void | (() => void)): () => void;
  /** Per-prop handles for accepted values, latest input, and validity. */
  readonly props: Readonly<Record<string, ComponentProp>>;
  readonly refs: Readonly<Record<string, Element | readonly Element[]>>;
  /**
   * The elements a consumer projected, by slot name, in document order; `default` reads the
   * unnamed slot. Empty while a slot shows its fallback. A consumer's `<template slot>` contributes
   * the elements it renders while its slot renders, and nothing otherwise. A component lowers into
   * one tree with no shadow boundary, so a query rooted at `root` cannot tell projected content
   * from the component's own output: this is the only way to enumerate it.
   */
  readonly slots: Readonly<Record<string, readonly Element[]>>;
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
  dispatch(event: string, detail?: unknown): boolean;
}

export interface ComponentProp {
  /** The accepted typed value read by template expressions. */
  readonly value: unknown;
  /** The latest directly supplied input, before type conversion. */
  readonly inputValue: unknown;
  /** Validity of that input against this prop's declared type and constraints. */
  readonly validity: GeneralizedValidityState;
  /** Recompute and return this prop's current validity. */
  validate(): GeneralizedValidityState;
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
  if (instance.element !== undefined && documentState(instance.element.ownerDocument).staticRendering) return;
  if (instance.connected) return;
  instance.connected = true;
  for (const effect of instance.effects) effect.resume();
  for (const effect of instance.owned.effects) effect.resume();
  // A delegated component shares this root and is not separately discoverable.
  for (const delegate of instance.delegates) connectRuntimeInstance(delegate);
}

function disconnectRuntimeInstance(instance: RuntimeInstance): void {
  if (!instance.connected) return;
  instance.connected = false;
  for (const effect of instance.effects) effect.pause();
  for (const effect of instance.owned.effects) effect.pause();
  for (const delegate of instance.delegates) disconnectRuntimeInstance(delegate);
}

/** Returns the private lifecycle host for a lowered root; page code normally never needs it. */
export function getComponentHost(element: Element): ComponentHost | undefined {
  const instance = runtimeInstance(element);
  if (instance === undefined) return compiledHandle(element)?.H;
  if (instance.host !== undefined) return instance.host;
  const writable = new Set(
    (instance.definition.declarations ?? [])
      .filter((declaration) => declaration.kind === "state")
      .map((declaration) => declaration.name),
  );
  const declarations = instance.definition.declarations ?? [];
  const stateNames = new Set(declarations.flatMap((declaration) =>
    declaration.kind === "state" || declaration.kind === "computed" ? [declaration.name]
      : declaration.kind === "context" ? [declaration.as ?? declaration.name] : []));
  const dataNames = new Set(declarations.filter((declaration) => declaration.kind === "data").map((declaration) => declaration.name));
  const nested = new WeakMap<object, Map<string, object>>();
  const write = (path: string, value: unknown, readonly: boolean, apply: () => void): boolean => {
    if (readonly) {
      warnAuthored(instance.definition, `controller:${path}`, `Destination \`${path}\` is read-only.`);
    } else if (!conformsAtDestination(value as Value, declaredTypeAt(instance.definition, path, instance.scope))) {
      warnAuthored(instance.definition, `controller:${path}`, `State \`${path}\` does not satisfy its declared type.`);
    } else apply();
    return true;
  };
  const wrap = (value: unknown, path: string, readonly: boolean): unknown => {
    if (value === null || typeof value !== "object" || isNativeEvent(value)) return value;
    let paths = nested.get(value);
    if (paths === undefined) nested.set(value, paths = new Map());
    const known = paths.get(path);
    if (known !== undefined) return known;
    const surface = readonly ? (Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))) : value;
    if (readonly && Array.isArray(value)) surface.length = value.length;
    const proxy = new Proxy(surface, {
      get: (_target, key) => wrap(Reflect.get(value, key), `${path}.${String(key)}`, readonly),
      set: (_target, key, next) => write(`${path}.${String(key)}`, next, readonly, () => { Reflect.set(value, key, next); }),
      has: (_target, key) => Reflect.has(value, key),
      ownKeys: () => Reflect.ownKeys(value),
      getOwnPropertyDescriptor: (_target, key) => {
        if (readonly && Array.isArray(value) && key === "length") { surface.length = value.length; return Reflect.getOwnPropertyDescriptor(surface, key); }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined ? undefined : readonly ? { ...descriptor, configurable: true } : descriptor;
      },
      deleteProperty: (_target, key) => write(`${path}.${String(key)}`, undefined, readonly, () => { Reflect.deleteProperty(value, key); }),
      defineProperty: (_target, key, descriptor) => {
        const destination = `${path}.${String(key)}`;
        if (readonly || !("value" in descriptor) || !conformsAtDestination(descriptor.value as Value, declaredTypeAt(instance.definition, destination, instance.scope))) {
          write(destination, descriptor.value, readonly, () => {}); return false;
        }
        return Reflect.defineProperty(value, key, descriptor);
      },
    });
    // Storage retains reactive identity, while controller reads install the destination's guard.
    // Readonly facades must keep their write barrier even when assigned into writable state.
    if (!readonly) registerReactiveAlias(proxy, value);
    paths.set(path, proxy);
    return proxy;
  };
  const state = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string" || !stateNames.has(key)) return undefined;
      const value = instance.scope.get(key);
      return value === ABSENT ? undefined : wrap(value, key, !writable.has(key));
    },
    set: (_target, key, value) => write(String(key), value, typeof key !== "string" || !writable.has(key),
      () => instance.scope.set(key as string, value as Value)),
    deleteProperty: (_target, key) => write(String(key), undefined, true, () => {}),
    defineProperty: (_target, key) => { write(String(key), undefined, true, () => {}); return false; },
    has: (_target, key) => typeof key === "string" && stateNames.has(key),
  });
  const data = new Proxy({}, {
    get: (_target, key) => typeof key === "string" && dataNames.has(key) ? wrap(instance.scope.get(key), key, true) : undefined,
    set: (_target, key, value) => write(`data.${String(key)}`, value, true, () => {}),
    deleteProperty: (_target, key) => write(`data.${String(key)}`, undefined, true, () => {}),
    defineProperty: (_target, key) => { write(`data.${String(key)}`, undefined, true, () => {}); return false; },
    has: (_target, key) => typeof key === "string" && dataNames.has(key),
  }) as ComponentHost["data"];
  const props = Object.create(null) as Record<string, ComponentProp>;
  for (const name of Object.keys(instance.definition.contract.props)) {
    const validity = (): GeneralizedValidityState => {
      const errors = propValidity(instance).errors.filter((error) => error.path === name);
      return validityState(errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors });
    };
    props[name] = Object.freeze({
      get value() { return instance.scope.get(name); },
      get inputValue() { return instance.propInputs[name]!.get().value; },
      get validity() { return validity(); },
      validate: validity,
    });
  }
  const projectedInto = (key: string): readonly Element[] => {
    const projection = instance.projection;
    if (projection === undefined) return [];
    // The rendered form names the unnamed slot `""`; `default` is the authoring spelling.
    const slot = key === "default" ? "" : key;
    // Hydration records each node's slot; a client-rendered instance carries the author's own
    // `slot` attribute instead, and an unmarked node belongs to the unnamed slot either way.
    // A consumer's <template slot> contributes what its outlets render now, in document order.
    return projection.nodes.flatMap((node): Element[] =>
      node.nodeType !== 1 || (projection.slotNames.get(node) ?? (node as Element).getAttribute("slot") ?? "") !== slot ? []
        : !(node instanceof HTMLTemplateElement) ? [node as Element]
          : [...templateRenderings.get(node) ?? []].flat().sort((a, b) =>
            (a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */) !== 0 ? -1 : 1)
    );
  };
  const slots = new Proxy({}, {
    get: (_target, key) => typeof key === "string" ? projectedInto(key) : undefined,
    has: (_target, key) => typeof key === "string" && projectedInto(key).length > 0,
  }) as Record<string, readonly Element[]>;
  const refs = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      const recorded = instance.refs[key];
      if (!Array.isArray(recorded)) return recorded;
      // Rows come and go, so the list is what the iteration still renders, in document order.
      const live = recorded.filter((element) => element.isConnected);
      if (live.length !== recorded.length) instance.refs[key] = live;
      return [...live].sort((a, b) =>
        (a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */) !== 0 ? -1 : 1
      );
    },
    has: (_target, key) => typeof key === "string" && instance.refs[key] !== undefined,
  }) as Readonly<Record<string, Element | readonly Element[]>>;
  const host: ComponentHost = {
    get root() { return instance.rootElement.get()!; },
    get element() { return instance.rootElement.get()!; },
    state,
    data,
    on(type, callback) {
      let stopped = false;
      const stop = host.effect(() => {
        if (type === "connect") return untracked(() => callback(new Event(type)));
        if (type === "disconnect") return () => { if (!stopped) untracked(() => callback(new Event(type))); };
        const root = host.root;
        const listener = (event: Event): void => { callback(event); };
        root.addEventListener(type, listener);
        return () => root.removeEventListener(type, listener);
      });
      return () => { stopped = true; stop(); };
    },
    props: Object.freeze(props),
    refs,
    slots,
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
    dispatch(event, detail) {
      return dispatchComponentEvent(instance.element!, event, detail, eventDeclaration(instance.definition, event));
    },
  };
  instance.host = Object.freeze(host);
  return instance.host;
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
  /** Called with each element added to the document after observation starts. */
  readonly onAdded?: (element: Element) => void;
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
  state.staticRendering = false;
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
  /**
   * Collects the connected roots a removed node held, in the order its marker query reports them.
   * `contains` and `querySelectorAll` share light-DOM scope, so testing the few connected roots
   * replaces querying every removed row.
   */
  const collectRemoved = (node: Element, removed: Element[]): void => {
    // ponytail: O(removed nodes × connected roots); above 8 roots the subtree query is cheaper.
    if (connected.size > 8) {
      visitComponentRoots(node, (element) => {
        if (connected.has(element)) removed.push(element);
      });
      return;
    }
    const start = removed.length;
    for (const [element] of connected) {
      if (node.contains(element) && element.matches("[data-component]")) removed.push(element);
    }
    if (removed.length - start > 1) {
      removed.push(...removed.splice(start).sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1));
    }
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
          if (node.nodeType === 1) collectRemoved(node as Element, removed);
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          scopes.push(node as QueryRoot);
          if (options.onAdded !== undefined) {
            try { options.onAdded(node as Element); } catch (error) { report(error); }
          }
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
  state.move = (from, to) => {
    if (!connected.has(from)) return;
    connected.set(to, connected.get(from));
    connected.delete(from);
  };
  state.rescan = () => synchronize();
  const stopObservation = subscribeDocumentMutations(root, synchronize);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopObservation();
    delete state.observer;
    delete state.release;
    delete state.move;
    delete state.rescan;
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
