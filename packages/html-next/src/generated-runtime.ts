/** Native lifecycle and prop wiring shared by ahead-of-time generated components. */

import { fail } from "./diagnostics.js";
import { ABSENT } from "./expression.js";
import { isNativeEvent } from "./freeze.js";
import { NESTED, raw, RAW } from "./keyed.js";
import {
  createComputed,
  createEffect,
  createSignal,
  notifyPropertyDelete,
  notifyPropertySet,
  ReactiveEffect,
  ReactiveScheduler,
  trackProperty,
  untracked,
  type ReactiveOwner,
} from "./reactivity.js";
import { parseTypedValue, parseTypeExpression } from "./type-system.js";

export { toAttribute, toText, truthy } from "./expression.js";
export { KeyedList } from "./keyed.js";

export interface GeneratedEvent {
  readonly name: string;
  readonly type: string;
  readonly detail: unknown;
  readonly bubbles: boolean;
  readonly composed: boolean;
  readonly cancelable: boolean;
}

/** Validates and dispatches an event emitted by target-native generated code. */
export function dispatchGeneratedEvent(target: EventTarget | null | undefined, event: GeneratedEvent): boolean {
  if (event.detail !== undefined) {
    const parsed = parseTypedValue(event.detail, parseTypeExpression(event.type));
    if (!parsed.ok) fail("HR002", `Event \`${event.name}\` detail does not satisfy its declared type.`);
  }
  return target?.dispatchEvent(new CustomEvent(event.name, {
    detail: event.detail,
    bubbles: event.bubbles,
    composed: event.composed,
    cancelable: event.cancelable,
  })) ?? false;
}

interface ManagedComponentLifecycle {
  readonly connect: (element: Element) => () => void;
  disconnect: undefined | (() => void);
  /** What the instance exposes to the runtime (state, values, host); read by inspection (M3). */
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

const runtimeKey = Symbol.for("@nextwebwg/html-next.runtime.v1");
const lifecycleKey = Symbol.for("@nextwebwg/html-next.lifecycle.v1");

interface DocumentState {
  mutationHub?: DocumentMutationHub;
  lifecycle?: LifecycleCoordinator;
}

type RuntimeDocument = Document & { [runtimeKey]?: DocumentState };
type RuntimeElement = Element & { [lifecycleKey]?: ManagedComponentLifecycle };

function documentState(root: Document): DocumentState {
  return (root as RuntimeDocument)[runtimeKey] ??= {};
}

function subscribeDocumentMutations(root: Document, subscriber: DocumentMutationSubscriber): () => void {
  const state = documentState(root);
  let hub = state.mutationHub;
  if (hub === undefined) {
    const Observer = root.defaultView?.MutationObserver ?? MutationObserver;
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
  const installed = state.lifecycle;
  if (installed !== undefined) return installed;
  let size = 0;
  /** Registered roots that are connected and were in the document's light tree when last synchronized. */
  const connected = new Set<Element>();
  const synchronize = (element: Element): void => {
    const record = (element as RuntimeElement)[lifecycleKey];
    if (record === undefined) return;
    if (element.isConnected && record.disconnect === undefined) {
      record.disconnect = record.connect(element);
    } else if (!element.isConnected && record.disconnect !== undefined) {
      record.disconnect();
      record.disconnect = undefined;
    }
    const current = (element as RuntimeElement)[lifecycleKey];
    // Hosts without getRootNode (minimal test DOMs) simply stay on the full walk.
    if (current?.disconnect !== undefined && element.getRootNode?.() === root) connected.add(element);
    else connected.delete(element);
  };
  /** Whether the walk below reaches `element` from this batch: the same light-DOM scope. */
  const reaches = (mutations: readonly MutationRecord[], element: Element): boolean => {
    const within = (nodes: NodeList): boolean => {
      for (const node of nodes) {
        if (node === element || node.nodeType === 1 && node.contains(element) && element.matches("[data-component]")) return true;
      }
      return false;
    };
    return mutations.some((mutation) => within(mutation.removedNodes) || within(mutation.addedNodes));
  };
  const stopObservation = subscribeDocumentMutations(root, (mutations) => {
    // ponytail: with every registered root connected and indexed (at most 32), only roots that
    // left the document can need work; two or more keep the walk's mutation-order sequencing.
    if (connected.size === size && size <= 32) {
      let left: Element | undefined;
      let several = false;
      for (const element of connected) {
        if (element.isConnected) continue;
        if (left !== undefined) { several = true; break; }
        left = element;
      }
      if (!several) {
        if (left !== undefined && reaches(mutations, left)) synchronize(left);
        return;
      }
    }
    const changed: Element[] = [];
    const collect = (node: Node): void => {
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if ((element as RuntimeElement)[lifecycleKey] !== undefined) changed.push(element);
      if (element.childElementCount === 0) return;
      for (const descendant of element.querySelectorAll("[data-component]")) {
        if ((descendant as RuntimeElement)[lifecycleKey] !== undefined) changed.push(descendant);
      }
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
      connected.delete(element);
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
 * Connects generated behavior while its native root is in the document. Every generated
 * bundle in the realm shares the same browser-owned document observer and coordinator.
 */
export function manageGeneratedLifecycle(
  element: Element,
  connect: () => void,
  disconnect: () => void,
  handle?: unknown,
): () => void {
  const coordinator = coordinatorFor(element.ownerDocument);
  const record: ManagedComponentLifecycle = {
    connect: () => {
      connect();
      return disconnect;
    },
    disconnect: undefined,
    h: handle,
  };
  coordinator.add(element, record);
  return () => coordinator.remove(element, record);
}

export type GeneratedPropType = "string" | "boolean" | "number" | readonly string[];

export interface GeneratedProp {
  readonly name: string;
  /** The `data-<name>` attribute that records an explicit value on the root. */
  readonly attribute: string;
  /** The value the author or framework supplied; `undefined` when the prop was not set. */
  readonly value: unknown;
  /** The declared default, used for rendering but never reflected. */
  readonly default?: unknown;
  /**
   * The template itself binds this attribute on the root, so it is template output and always shows
   * the effective value (defaults included). Otherwise it only records explicit values.
   */
  readonly bound?: boolean;
  readonly type: GeneratedPropType;
  readonly required: boolean;
}

const generatedPropUpdaters = new WeakMap<Element, (props: Readonly<Record<string, unknown>>) => void>();

interface ChoiceIssue { readonly path: string; readonly message: string; readonly reason: "valueMissing" | "typeMismatch" }

function managedChoiceValidity(element: Element, issues: () => readonly ChoiceIssue[]): { refresh(): void; stop(): void } {
  const target = element as Element & { validity?: ValidityState; validationMessage?: string; checkValidity?: () => boolean; reportValidity?: () => boolean; setCustomValidity?: (message: string) => void };
  const ownValidity = !('validity' in target);
  const ownCheck = !('checkValidity' in target);
  const ownMessage = !('validationMessage' in target);
  const ownReport = !('reportValidity' in target);
  let failures: readonly ChoiceIssue[] = [];
  let mirroredAria = false;
  if (ownValidity) Object.defineProperty(target, "validity", { configurable: true, get: () => ({
    valid: failures.length === 0,
    valueMissing: failures.some((failure) => failure.reason === "valueMissing"),
    typeMismatch: failures.some((failure) => failure.reason === "typeMismatch"),
    patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false,
    rangeOverflow: false, stepMismatch: false, badInput: false, customError: false,
    errors: failures,
  }) });
  if (ownCheck) Object.defineProperty(target, "checkValidity", { configurable: true, value: () => failures.length === 0 });
  if (ownMessage) Object.defineProperty(target, "validationMessage", { configurable: true, get: () => failures[0]?.message ?? "" });
  if (ownReport) Object.defineProperty(target, "reportValidity", { configurable: true, value: () => failures.length === 0 });
  const refresh = (): void => {
    failures = issues();
    target.setCustomValidity?.(failures[0]?.message ?? "");
    if (!('setCustomValidity' in target)) {
      if (failures.length > 0) {
        element.setAttribute("data-invalid", "");
        element.removeAttribute("data-valid");
      } else {
        element.removeAttribute("data-invalid");
        element.setAttribute("data-valid", "");
      }
      if (failures.length > 0 && (!element.hasAttribute("aria-invalid") || mirroredAria)) {
        element.setAttribute("aria-invalid", "true");
        mirroredAria = true;
      } else if (failures.length === 0 && mirroredAria) {
        element.removeAttribute("aria-invalid");
        mirroredAria = false;
      }
    }
  };
  return { refresh, stop: () => {
    target.setCustomValidity?.("");
    if (ownValidity) delete target.validity;
    if (ownCheck) delete target.checkValidity;
    if (ownMessage) delete target.validationMessage;
    if (ownReport) delete target.reportValidity;
    element.removeAttribute("data-invalid");
    element.removeAttribute("data-valid");
    if (mirroredAria) element.removeAttribute("aria-invalid");
  } };
}

function propValue(input: unknown, type: GeneratedPropType): unknown {
  if (type === "string" && typeof input === "string") return input;
  if (type === "boolean" && typeof input === "boolean") return input;
  if (type === "number" && typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(type) && typeof input === "string") return input;
  return input;
}

function generatedPropIssues(prop: GeneratedProp, value: unknown): readonly ChoiceIssue[] {
  if (value === null || value === undefined || value === "") {
    return prop.required ? [{ path: prop.name, reason: "valueMissing", message: `\`${prop.name}\` is required.` }] : [];
  }
  const type = prop.type;
  const valid = type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === "string" && (type as readonly string[]).includes(value);
  return valid ? [] : [{ path: prop.name, reason: "typeMismatch", message: `Value does not satisfy \`${prop.name}\`.` }];
}

function assignedGeneratedProp(
  prop: GeneratedProp,
  input: unknown,
): unknown {
  if (input === null) {
    return null;
  }
  if (input !== undefined) return propValue(input, prop.type);
  return undefined;
}

/**
 * Installs the scalar prop boundary used by a directly compiled component. Explicit values are
 * reflected as `data-<name>` (defaults never are); that record is output, never read back. No
 * JavaScript properties are added to the element.
 */
export function manageGeneratedProps(
  element: Element,
  props: readonly GeneratedProp[],
  apply?: (name: string, value: unknown) => void,
): () => void {
  // `explicit` holds the supplied value (or undefined); `effective` adds the declared default.
  const explicit = props.map((prop) => assignedGeneratedProp(prop, prop.value));
  const effective = (index: number): unknown => explicit[index] === undefined
    ? (props[index]!.default ?? null) : explicit[index];
  const validity = props.length > 0
    ? managedChoiceValidity(element, () => props.flatMap((prop, index) => generatedPropIssues(prop, effective(index))))
    : undefined;
  const byName = new Map(props.map((prop, index) => [prop.name, index]));
  const dirty = new Set(props.map((_, index) => index));
  let connected = false;
  let pending = false;

  const flush = (): void => {
    pending = false;
    if (!connected) return;
    for (const index of dirty) {
      const prop = props[index]!;
      const value = prop.bound ? effective(index) : explicit[index];
      const serialized = value === undefined || value === null ? null : String(value);
      if (serialized === null) element.removeAttribute(prop.attribute);
      else element.setAttribute(prop.attribute, serialized);
      apply?.(prop.name, effective(index));
    }
    dirty.clear();
    validity?.refresh();
  };
  const schedule = (index: number): void => {
    dirty.add(index);
    if (connected && !pending) {
      pending = true;
      queueMicrotask(flush);
    }
  };
  generatedPropUpdaters.set(element, (next) => {
    for (const [name, input] of Object.entries(next)) {
      const index = byName.get(name);
      if (index === undefined) continue;
      const value = assignedGeneratedProp(props[index]!, input);
      if (Object.is(explicit[index], value)) continue;
      explicit[index] = value;
      schedule(index);
    }
  });

  const stopLifecycle = manageGeneratedLifecycle(
    element,
    () => {
      connected = true;
      for (let index = 0; index < props.length; index += 1) dirty.add(index);
      flush();
    },
    () => {
      connected = false;
    },
  );
  return () => { stopLifecycle(); validity?.stop(); };
}

/** A compact equivalent of manageGeneratedProps for generated components with exactly one scalar prop. */
export function manageGeneratedProp(
  element: Element,
  prop: GeneratedProp,
  apply?: (value: unknown) => void,
): () => void {
  let explicit = assignedGeneratedProp(prop, prop.value);
  let dirty = true;
  let connected = false;
  let pending = false;
  const effective = (): unknown => explicit === undefined ? (prop.default ?? null) : explicit;
  const validity = managedChoiceValidity(element, () => generatedPropIssues(prop, effective()));
  const flush = (): void => {
    pending = false;
    if (!connected || !dirty) return;
    dirty = false;
    const value = prop.bound ? effective() : explicit;
    const serialized = value === undefined || value === null ? null : String(value);
    if (serialized === null) element.removeAttribute(prop.attribute);
    else element.setAttribute(prop.attribute, serialized);
    apply?.(effective());
    validity?.refresh();
  };
  const schedule = (): void => {
    dirty = true;
    if (connected && !pending) {
      pending = true;
      queueMicrotask(flush);
    }
  };
  generatedPropUpdaters.set(element, (next) => {
    if (!Object.hasOwn(next, prop.name)) return;
    const value = assignedGeneratedProp(prop, next[prop.name]);
    if (!Object.is(explicit, value)) {
      explicit = value;
      schedule();
    }
  });
  const stopLifecycle = manageGeneratedLifecycle(
    element,
    () => {
      connected = true;
      dirty = true;
      flush();
    },
    () => { connected = false; },
  );
  return () => { stopLifecycle(); validity?.stop(); };
}

/** The framework-adapter prop channel for directly compiled components; not a page-authoring API. */
export function updateGeneratedProps(element: Element, props: Readonly<Record<string, unknown>>): void {
  generatedPropUpdaters.get(element)?.(props);
}

/**
 * A prototype for cloning: `[tag, [name, value, ...], ...children]`, where an empty tag is a
 * fragment, a string is text, 0 is an empty Text a `$value` writes, 1 is a `$if` anchor pair and
 * 2 is a `$each` anchor pair.
 */
export type TemplateSpec = readonly [tag: string, attributes: readonly string[], ...children: readonly unknown[]];
type TemplateChild = string | 0 | 1 | 2 | TemplateSpec;

/** Builds a prototype once with createElement/setAttribute: no HTML parser or sink. */
export function buildTemplate(spec: TemplateSpec, doc: Document = document): Node {
  const node = spec[0] === "" ? doc.createDocumentFragment() : doc.createElement(spec[0]);
  const attributes = spec[1];
  for (let index = 0; index < attributes.length; index += 2) {
    (node as Element).setAttribute(attributes[index]!, attributes[index + 1]!);
  }
  for (let index = 2; index < spec.length; index += 1) {
    const child = spec[index] as TemplateChild;
    if (typeof child === "object") node.append(buildTemplate(child, doc));
    else if (typeof child === "string" || child === 0) node.append(doc.createTextNode(child === 0 ? "" : child));
    else {
      const prefix = child === 2 ? "html-next:each-" : "html-next:";
      node.append(doc.createComment(`${prefix}start`), doc.createComment(`${prefix}end`));
    }
  }
  return node;
}

/** The expression interpreter's member read, over raw values; object results are canonical raw objects. */
export const readMember = (object: unknown, key: string): unknown =>
  key === "length" && (Array.isArray(object) || typeof object === "string") ? (object as { length: number }).length
    : object === null || typeof object !== "object" || Array.isArray(object) ? ABSENT
    : (object = (object as Record<string, unknown>)[key]) === undefined ? ABSENT : raw(object);

/** Writes `$value` text: the sole Text child's data, or `textContent` for "" and foreign content (decision 2b). */
export function writeText(element: Element, text: string): void {
  const node = element.firstChild;
  if (text !== "" && node !== null && node.nodeType === 3 && node.nextSibling === null) (node as Text).data = text;
  else element.textContent = text;
}

/** Writes a converted attribute value; null removes it. */
export function writeAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Removes everything between two region anchors, node by node, as the live `$if` teardown does. */
export function clearRegion(start: Comment, end: Comment): void {
  let current = start.nextSibling;
  while (current !== null && current !== end) {
    const next: ChildNode | null = current.nextSibling;
    current.remove();
    current = next;
  }
}

/**
 * A declared type in generated form: 0 none, "?" unknown, "s" string, "b" boolean, "n" number,
 * "i" integer, "z" null, "a" absent, ["l", item], ["r", value], ["o", [field, type, ...], open?],
 * ["u", ...members]. Constrained types are written as their base.
 */
export type CompactType = 0 | "?" | "s" | "b" | "n" | "i" | "z" | "a" | readonly unknown[];

const acceptsNull = (type: CompactType): boolean =>
  type === "?" || type === "z" || typeof type === "object" && type[0] === "u" &&
    type.some((member, index) => index > 0 && acceptsNull(member as CompactType));

const conformsAtReference = (value: unknown, type: CompactType): boolean => {
  switch (typeof type === "object" ? type[0] : type) {
    case "?": return true;
    case "s": return typeof value === "string";
    case "b": return typeof value === "boolean";
    case "n": return Number.isFinite(value);
    case "i": return Number.isInteger(value);
    case "a": return value === undefined;
    case "l": return Array.isArray(value);
    case "r":
    case "o": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "u": return (type as readonly unknown[]).some((member, index) => index > 0 && conformsAtReference(value, member as CompactType));
  }
  return false;
};

/** @internal The destination check (`conformsAtDestination`) on a compact type. */
export const conforms = (value: unknown, type: CompactType): boolean =>
  type === 0 || (value === null ? acceptsNull(type) : conformsAtReference(value, type));

/** @internal The declared type one step into `type` (`typeAtKey`); 0 when nothing describes it. */
export function compactTypeAt(type: CompactType, key: PropertyKey): CompactType {
  if (typeof type !== "object") return 0;
  switch (type[0]) {
    case "l": {
      if (typeof key !== "string" || key === "") return 0;
      for (let index = 0; index < key.length; index += 1) {
        const code = key.charCodeAt(index);
        if (code < 48 || code > 57) return 0;
      }
      return type[1] as CompactType;
    }
    case "r": return type[1] as CompactType;
    case "o": {
      const fields = type[1] as readonly unknown[];
      const name = String(key);
      for (let index = 0; index < fields.length; index += 2) if (fields[index] === name) return fields[index + 1] as CompactType;
      return type[2] === 1 ? 0 : "a";
    }
    case "u": {
      const described: CompactType[] = [];
      for (let index = 1; index < type.length; index += 1) {
        const member = compactTypeAt(type[index] as CompactType, key);
        if (member !== 0) described.push(member);
      }
      return described.length === 0 ? 0 : described.length === 1 ? described[0]! : ["u", ...described];
    }
  }
  return 0;
}

/** A generated component's declared state: names, compact types, and its source for warnings. */
export interface GeneratedStateSpec {
  readonly n: readonly string[];
  readonly t: readonly CompactType[];
  readonly f: string;
}

/** The changed-roots bits plus the raw objects written since the last render (see `DirtyObjects`). */
export type GeneratedUpdate = (changed: number, dirty: Map<unknown, 1 | 2>) => void;

interface Facade extends ProxyHandler<object> {
  /** Declared type, raw target, proxy, next facade of the same target with another type. */
  t: CompactType;
  r: object;
  p: object;
  n: Facade | undefined;
  /** The last path that reached it: parent facade (undefined for a root) and key. */
  u: Facade | undefined;
  k: PropertyKey;
}

const reportedWarnings = new WeakMap<GeneratedStateSpec, Set<string>>();

/**
 * Attaches the controller contract to a generated root and renders its initial state. Template
 * reads stay raw; writes through `host.state` are validated, stored raw, and mark the roots and
 * objects that changed for one priority-1 render per flush on the instance's scheduler.
 */
export function attachGeneratedController(
  root: Element,
  spec: GeneratedStateSpec,
  values: unknown[],
  update: GeneratedUpdate,
  controller: { readonly default: (host: never) => unknown },
): void {
  const { n: names, t: types, f: file } = spec;
  const scheduler = new ReactiveScheduler();
  const entries: ReactiveOwner[] = [];
  const facades = new WeakMap<object, Facade>();
  // Root reads and writes track this target, so controller effects see root replacement.
  const roots = {};
  let dirty = 0;
  let objects = new Map<unknown, 1 | 2>();
  let spare = new Map<unknown, 1 | 2>();
  let connected = false;
  let started = false;
  let gone = false;
  let cleanup: (() => void) | undefined;
  const render = (changed: number): void => {
    const written = objects;
    objects = spare;
    try { untracked(() => update(changed, written)); }
    finally { written.clear(); spare = written; }
  };
  const job = new ReactiveEffect(scheduler, () => {
    // Bits wait while disconnected; a reconnect's full render may already have taken them.
    if (!connected || dirty === 0) return;
    const changed = dirty;
    dirty = 0;
    render(changed);
  }, 1);
  const warn = (path: string, message: string): void => {
    let reported = reportedWarnings.get(spec);
    if (reported === undefined) reportedWarnings.set(spec, reported = new Set());
    if (reported.has(path)) return;
    reported.add(path);
    console.warn(`${file}: HR007: ${message}`);
  };
  const readOnly = (path: string): void => warn(path, `Destination \`${path}\` is read-only.`);
  const mismatch = (path: string): void => warn(path, `State \`${path}\` does not satisfy its declared type.`);
  const pathOf = (facade: Facade | undefined, key: PropertyKey): string => {
    let path = String(key);
    for (; facade !== undefined; facade = facade.u) path = `${String(facade.k)}.${path}`;
    return path;
  };
  /** Marks a written object (1) and the objects on its last path (2), then schedules a render. */
  const written = (facade: Facade): void => {
    // A reconnect renders everything, so nothing written while disconnected needs keeping.
    if (!connected) return;
    objects.set(facade.r, 1);
    for (let parent = facade.u; parent !== undefined; parent = parent.u) {
      if (!objects.has(parent.r)) objects.set(parent.r, 2);
    }
    dirty |= NESTED;
    job.schedule();
  };
  const same = (left: CompactType, right: CompactType): boolean =>
    left === right || typeof left === "object" && JSON.stringify(left) === JSON.stringify(right);
  const wrap = (value: unknown, type: CompactType, parent: Facade | undefined, key: PropertyKey): unknown => {
    if (value === null || typeof value !== "object" || isNativeEvent(value)) return value;
    const target = raw(value) as object;
    const first = facades.get(target);
    let facade = first;
    while (facade !== undefined && !same(facade.t, type)) facade = facade.n;
    if (facade === undefined) {
      facade = Object.create(traps) as Facade;
      facade.t = type;
      facade.r = target;
      facade.p = new Proxy(target, facade);
      facade.n = first;
      facades.set(target, facade);
    }
    // The last path that reached it, unless that path runs through it (cyclic data): chains stay
    // acyclic, so walking one always ends.
    let above = parent;
    while (above !== undefined && above !== facade) above = above.u;
    if (above === undefined) {
      facade.u = parent;
      facade.k = key;
    }
    return facade.p;
  };
  const traps: ThisType<Facade> & ProxyHandler<object> = {
    get(target, key, receiver) {
      if (key === RAW) return target;
      trackProperty(target, key);
      const value: unknown = Reflect.get(target, key, receiver);
      return value !== null && typeof value === "object" ? wrap(value, compactTypeAt(this.t, key), this, key) : value;
    },
    set(target, key, value) {
      if (!conforms(value, compactTypeAt(this.t, key))) {
        mismatch(pathOf(this, key));
        return true;
      }
      const length = Array.isArray(target) ? target.length : undefined;
      const previous: unknown = Reflect.get(target, key);
      const next = raw(value);
      Reflect.set(target, key, next);
      if (!Object.is(previous, next) || length !== undefined && length !== (target as unknown[]).length) written(this);
      notifyPropertySet(target, key, previous, next, length);
      return true;
    },
    deleteProperty(target, key) {
      if (!conforms(undefined, compactTypeAt(this.t, key))) {
        mismatch(pathOf(this, key));
        return true;
      }
      const had = Reflect.has(target, key);
      Reflect.deleteProperty(target, key);
      if (had) written(this);
      notifyPropertyDelete(target, key, had);
      return true;
    },
    defineProperty(target, key, descriptor) {
      const type = compactTypeAt(this.t, key);
      if ("value" in descriptor && conforms(descriptor.value, type)) return Reflect.defineProperty(target, key, descriptor);
      if (!conforms(descriptor.value, type)) mismatch(pathOf(this, key));
      return false;
    },
  };
  const state = new Proxy({}, {
    get: (_target, key) => {
      const index = typeof key === "string" ? names.indexOf(key) : -1;
      if (index < 0) return undefined;
      trackProperty(roots, key);
      return wrap(values[index], types[index]!, undefined, key);
    },
    set: (_target, key, value) => {
      const index = typeof key === "string" ? names.indexOf(key) : -1;
      if (index < 0) readOnly(String(key));
      else if (!conforms(value, types[index]!)) mismatch(String(key));
      else {
        const previous = values[index];
        const next = raw(value);
        if (!Object.is(previous, next)) {
          values[index] = next;
          dirty |= 1 << index;
          job.schedule();
          notifyPropertySet(roots, key, previous, next, undefined);
        }
      }
      return true;
    },
    deleteProperty: (_target, key) => (readOnly(String(key)), true),
    defineProperty: (_target, key) => (readOnly(String(key)), false),
    has: (_target, key) => typeof key === "string" && names.includes(key),
  });
  const dataPath = (key: PropertyKey): string => `data.${String(key)}`;
  const data = new Proxy({}, {
    get: () => undefined,
    set: (_target, key) => (readOnly(dataPath(key)), true),
    deleteProperty: (_target, key) => (readOnly(dataPath(key)), true),
    defineProperty: (_target, key) => (readOnly(dataPath(key)), false),
    has: () => false,
  });
  // The live host reads refs from an ordinary object, so inherited names answer as they do there.
  const recorded: Record<string, unknown> = {};
  const host = Object.freeze({
    get root() { return root; },
    get element() { return root; },
    state,
    data,
    on(type: string, callback: (event: Event) => void | (() => void)) {
      let stopped = false;
      const stop = host.effect(() => {
        if (type === "connect") return untracked(() => callback(new Event(type))) as void | (() => void);
        if (type === "disconnect") return () => { if (!stopped) untracked(() => callback(new Event(type))); };
        const listener = (event: Event): void => { callback(event); };
        root.addEventListener(type, listener);
        return () => root.removeEventListener(type, listener);
      });
      return () => { stopped = true; stop(); };
    },
    props: Object.freeze(Object.create(null) as object),
    refs: new Proxy({}, {
      get: (_target, key) => typeof key === "string" ? recorded[key] : undefined,
      has: (_target, key) => typeof key === "string" && recorded[key] !== undefined,
    }),
    slots: new Proxy({}, {
      get: (_target, key) => typeof key === "string" ? [] : undefined,
      has: () => false,
    }),
    signal: <T>(initialValue: T) => createSignal(initialValue),
    computed<T>(compute: () => T) {
      const computed = createComputed(scheduler, compute);
      if (!connected) computed.pause();
      entries.unshift(computed);
      return computed;
    },
    effect(run: () => void | (() => void)) {
      const effect = createEffect(scheduler, run, 2, connected);
      entries.push(effect);
      return () => effect.stop();
    },
    dispatch: (event: string, detail?: unknown): boolean =>
      root.dispatchEvent(new CustomEvent(event, { detail, bubbles: true, composed: true, cancelable: false })),
  });
  render(-1);
  manageGeneratedLifecycle(root, () => {
    connected = true;
    for (const entry of entries) entry.resume();
    if (started) {
      // Live resumes its template effects after the controller's: every binding re-renders.
      dirty = 0;
      render(-1);
      return;
    }
    started = true;
    void Promise.resolve(controller.default(host as never)).then((result) => {
      if (typeof result !== "function") return;
      if (gone) (result as () => void)();
      else cleanup = result as () => void;
    });
  }, () => {
    if (!gone) {
      gone = true;
      const finish = cleanup;
      cleanup = undefined;
      finish?.();
    }
    connected = false;
    objects.clear();
    for (const entry of entries) entry.pause();
  }, { S: spec, v: values, H: host });
}
