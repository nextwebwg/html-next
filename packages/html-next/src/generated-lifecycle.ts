/** The document-level lifecycle coordinator every generated (and live) bundle in a realm shares. */

export interface ManagedComponentLifecycle {
  readonly connect: (element: Element) => () => void;
  disconnect: undefined | (() => void);
  /** What the instance exposes to the runtime (state, values, host); read by inspection (M3). */
  readonly h?: unknown;
  /** The generated coordinator's weak reference to the root. */
  w?: WeakRef<Element>;
}

export interface LifecycleCoordinator {
  add(element: Element, record: ManagedComponentLifecycle): void;
  remove(element: Element, record: ManagedComponentLifecycle): void;
}

type DocumentMutationSubscriber = (mutations: readonly MutationRecord[]) => void;

interface DocumentMutationHub {
  readonly observer: MutationObserver;
  readonly subscribers: Set<DocumentMutationSubscriber>;
}

const runtimeKey = Symbol.for("@nextwebwg/html-next.runtime.v1");
export const lifecycleKey = Symbol.for("@nextwebwg/html-next.lifecycle.v1");

interface DocumentState {
  mutationHub?: DocumentMutationHub;
  lifecycle?: LifecycleCoordinator;
}

type RuntimeDocument = Document & { [runtimeKey]?: DocumentState };
export type RuntimeElement = Element & { [lifecycleKey]?: ManagedComponentLifecycle };

export function documentState(root: Document): DocumentState {
  return (root as RuntimeDocument)[runtimeKey] ??= {};
}

export function subscribeDocumentMutations(root: Document, subscriber: DocumentMutationSubscriber): () => void {
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
