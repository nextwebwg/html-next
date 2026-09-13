/** Native lifecycle and prop wiring shared by ahead-of-time generated components. */

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

const mutationHubKey = Symbol.for("@nextwebwg/declarative-components.mutation-hub.v1");
const lifecycleCoordinatorKey = Symbol.for("@nextwebwg/declarative-components.lifecycle.v1");

function globalDocumentMap<T>(key: symbol): WeakMap<Document, T> {
  const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  const installed = host[key];
  if (installed instanceof WeakMap) return installed as WeakMap<Document, T>;
  const documents = new WeakMap<Document, T>();
  Object.defineProperty(host, key, { value: documents });
  return documents;
}

function subscribeDocumentMutations(root: Document, subscriber: DocumentMutationSubscriber): () => void {
  const hubs = globalDocumentMap<DocumentMutationHub>(mutationHubKey);
  let hub = hubs.get(root);
  if (hub === undefined) {
    const Observer = root.defaultView?.MutationObserver ?? MutationObserver;
    const subscribers = new Set<DocumentMutationSubscriber>();
    const observer = new Observer((mutations) => {
      for (const notify of Array.from(subscribers)) notify(mutations);
    });
    hub = { observer, subscribers };
    hubs.set(root, hub);
    observer.observe(root, { childList: true, subtree: true });
  }
  hub.subscribers.add(subscriber);
  return () => hub.subscribers.delete(subscriber);
}

function coordinatorFor(root: Document): LifecycleCoordinator {
  const coordinators = globalDocumentMap<LifecycleCoordinator>(lifecycleCoordinatorKey);
  const installed = coordinators.get(root);
  if (installed !== undefined) return installed;
  const records = new WeakMap<Element, ManagedComponentLifecycle>();
  const synchronize = (element: Element): void => {
    const record = records.get(element);
    if (record === undefined) return;
    if (element.isConnected && record.disconnect === undefined) {
      record.disconnect = record.connect(element);
    } else if (!element.isConnected && record.disconnect !== undefined) {
      record.disconnect();
      record.disconnect = undefined;
    }
  };
  subscribeDocumentMutations(root, (mutations) => {
    const changed = new Set<Element>();
    const collect = (node: Node): void => {
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (records.has(element)) changed.add(element);
      if (element.childElementCount === 0) return;
      for (const root of element.querySelectorAll("[data-component-root]")) {
        if (records.has(root)) changed.add(root);
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
      const previous = records.get(element);
      if (previous === record) return;
      previous?.disconnect?.();
      records.set(element, record);
      synchronize(element);
    },
    remove(element, record) {
      if (records.get(element) !== record) return;
      record.disconnect?.();
      records.delete(element);
    },
  };
  coordinators.set(root, coordinator);
  return coordinator;
}

/**
 * Connects generated behavior while its native root is in the document. Every generated
 * bundle in the realm shares the same document observer through the global symbol registry.
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
