/** Native lifecycle and prop wiring shared by ahead-of-time generated components. */

import { fail } from "./diagnostics.js";
import { parseTypedValue, parseTypeExpression } from "./type-system.js";

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
): () => void {
  const coordinator = coordinatorFor(element.ownerDocument);
  const record: ManagedComponentLifecycle = {
    connect: () => {
      connect();
      return disconnect;
    },
    disconnect: undefined,
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
