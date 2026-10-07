/**
 * The direct-extend lifecycle coordinator: the generated coordinator plus a weak index of its roots,
 * so a mutation batch that reaches no registered root costs no subtree query. Only direct-extend
 * output imports it, so other generated output never pays for it. It occupies the one document
 * slot every coordinator shares: whichever installs first serves every root in that document (older
 * generated and live roots too), so two coordinators never disagree. It indexes lifecycle records,
 * not elements, so a live root whose record moves to a replacement element stays indexed. When
 * another one installed first, it serves direct-extend roots as well (exact walk, no fast path).
 */

import {
  documentState,
  lifecycleKey,
  subscribeDocumentMutations,
  type ManagedComponentLifecycle,
  type RuntimeElement,
} from "./generated-lifecycle.js";

// ponytail: `synchronize` and the walk repeat the generated coordinator's; sharing them as top-level
// helpers grows other generated output (7 B gzip on prop-button). A direct-extend graph that also
// holds older direct output with a lifecycle bundles both (~180 B gzip) until M3 routes that output here.
function indexedCoordinatorFor(root: Document) {
  const state = documentState(root);
  const installed = state.lifecycle;
  if (installed !== undefined) return installed;
  /**
   * Every registered root's record, held weakly: the coordinator retains nothing the document
   * dropped (006). Records, not elements, so a root the live runtime switches to another element
   * (`attachRoot` moves the record and its `element`) stays indexed.
   */
  const roots = new Set<WeakRef<ManagedComponentLifecycle>>();
  const collected = new FinalizationRegistry<WeakRef<ManagedComponentLifecycle>>((reference) => roots.delete(reference));
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
    // ponytail: the walk only acts on a root whose connection no longer matches its record and that
    // the batch reaches. Up to 32 roots, find those directly: one is synchronized here, two or more
    // keep the walk's mutation-order sequencing. Above 32 roots the walk runs (M3: index by subtree).
    if (roots.size <= 32) {
      let next: Element | undefined;
      let several = false;
      for (const reference of roots) {
        const record = reference.deref();
        const element = record?.element;
        if (element !== undefined && element.isConnected !== (record!.disconnect !== undefined) && reaches(mutations, element)) {
          if (next !== undefined) { several = true; break; }
          next = element;
        }
      }
      if (!several) {
        if (next !== undefined) synchronize(next);
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
  return state.lifecycle = {
    add(element, record) {
      const target = element as RuntimeElement;
      const previous = target[lifecycleKey];
      if (previous === record) return;
      previous?.disconnect?.();
      roots.delete(previous?.w as WeakRef<ManagedComponentLifecycle>);
      target[lifecycleKey] = record;
      record.element = element;
      collected.register(record, record.w = new WeakRef(record));
      roots.add(record.w);
      synchronize(element);
    },
    remove(element, record) {
      const target = element as RuntimeElement;
      if (target[lifecycleKey] !== record) return;
      record.disconnect?.();
      delete target[lifecycleKey];
      roots.delete(record.w!);
      // Every registered root stays indexed until it is removed or collected, so an empty index
      // means nothing left to connect.
      if (roots.size === 0) {
        stopObservation();
        delete state.lifecycle;
      }
    },
  };
}

/**
 * @internal Registers a direct-extend root with the indexed coordinator (installed when none is
 * yet). `connect` runs on every connection and returns that connection's disconnect; `handle` is
 * what the instance exposes to the runtime (state, values, host), kept for inspection (M3).
 */
export function manageIndexedLifecycle(element: Element, connect: () => () => void, handle: unknown): void {
  indexedCoordinatorFor(element.ownerDocument).add(element, { connect, disconnect: undefined, h: handle });
}
