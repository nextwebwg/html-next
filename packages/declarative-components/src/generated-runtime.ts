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

const runtimeKey = Symbol.for("@nextwebwg/declarative-components.runtime.v1");
const lifecycleKey = Symbol.for("@nextwebwg/declarative-components.lifecycle.v1");

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
      for (const descendant of element.querySelectorAll("[data-component-root]")) {
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
  readonly attribute: string;
  readonly value: unknown;
  readonly type: GeneratedPropType;
  readonly required: boolean;
}

function propValue(input: unknown, type: GeneratedPropType, attributePresent = false): unknown {
  if (type === "string" && typeof input === "string") return input;
  if (type === "boolean") {
    if (attributePresent) return true;
    if (typeof input === "boolean") return input;
    if (input === "" || input === "true") return true;
    if (input === "false") return false;
  }
  if (type === "number") {
    const value = typeof input === "number" ? input
      : typeof input === "string" && input.trim() !== "" ? Number(input) : Number.NaN;
    if (Number.isFinite(value)) return value;
  }
  if (Array.isArray(type) && type.includes(input as string)) return input;
  throw new TypeError("HR002: A prop invocation value does not satisfy its declared type.");
}

/** Installs the scalar prop boundary used by a directly compiled component. */
export function manageGeneratedProps(
  element: Element,
  props: readonly GeneratedProp[],
  apply?: (name: string, value: unknown) => void,
): () => void {
  const values = props.map((prop) => {
    if (prop.value === undefined) {
      if (prop.required) throw new TypeError(`HC020: Required prop \`${prop.name}\` was not provided.`);
      return undefined;
    }
    return propValue(prop.value, prop.type);
  });
  const byAttribute = new Map(props.map((prop, index) => [prop.attribute, index]));
  const reflected = new Map<string, string | null>();
  const dirty = new Set(props.map((_, index) => index));
  let connected = false;
  let pending = false;

  const flush = (): void => {
    pending = false;
    if (!connected) return;
    for (const index of dirty) {
      const prop = props[index]!;
      const value = values[index];
      const serialized = value === undefined ? null : String(value);
      reflected.set(prop.attribute, serialized);
      if (serialized === null) element.removeAttribute(prop.attribute);
      else element.setAttribute(prop.attribute, serialized);
      apply?.(prop.name, value);
    }
    dirty.clear();
  };
  const schedule = (index: number): void => {
    dirty.add(index);
    if (connected && !pending) {
      pending = true;
      queueMicrotask(flush);
    }
  };
  for (const [index, prop] of props.entries()) {
    Object.defineProperty(element, prop.name, {
      configurable: true,
      enumerable: true,
      get: () => values[index],
      set: (input: unknown) => {
        const value = propValue(input, prop.type);
        if (Object.is(values[index], value)) return;
        values[index] = value;
        schedule(index);
      },
    });
  }

  const Observer = element.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
  const observer = new Observer((mutations) => {
    for (const mutation of mutations) {
      const attribute = mutation.attributeName;
      if (attribute === null) continue;
      const index = byAttribute.get(attribute);
      if (index === undefined) continue;
      const current = element.getAttribute(attribute);
      if (reflected.get(attribute) === current && reflected.delete(attribute)) continue;
      reflected.delete(attribute);
      const prop = props[index]!;
      const present = current !== null;
      const value = propValue(present ? current : undefined, prop.type, present);
      if (Object.is(values[index], value)) continue;
      values[index] = value;
      schedule(index);
    }
  });
  return manageGeneratedLifecycle(
    element,
    () => {
      connected = true;
      for (let index = 0; index < props.length; index += 1) dirty.add(index);
      flush();
      observer.observe(element, {
        attributes: true,
        attributeFilter: props.map((prop) => prop.attribute),
      });
    },
    () => {
      connected = false;
      observer.disconnect();
    },
  );
}
