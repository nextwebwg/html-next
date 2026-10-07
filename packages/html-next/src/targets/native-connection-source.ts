/**
 * Native DOM connection observation; framework ownership stays with each target. A document has one
 * MutationObserver for every HTML Next runtime and generated module on it: the hub lives on the
 * document under the shared runtime key, in the shape the live runtime and compiled roots use.
 */
export const NATIVE_CONNECTION_SOURCE = `type DocumentMutationSubscriber = (mutations: readonly MutationRecord[]) => void;
interface DocumentMutationHub {
  readonly observer: MutationObserver;
  readonly subscribers: Set<DocumentMutationSubscriber>;
}

const runtimeKey = Symbol.for('@nextwebwg/html-next.runtime.v1');

function observeConnection(element: Element, check: () => void): () => void {
  const document = element.ownerDocument;
  const state = ((document as unknown as Record<symbol, { mutationHub?: DocumentMutationHub }>)[runtimeKey] ??= {});
  let hub = state.mutationHub;
  if (hub === undefined) {
    const Observer = document.defaultView?.MutationObserver ?? MutationObserver;
    const subscribers = new Set<DocumentMutationSubscriber>();
    const observer = new Observer((mutations) => { for (const notify of Array.from(subscribers)) notify(mutations); });
    hub = { observer, subscribers };
    state.mutationHub = hub;
    observer.observe(document, { childList: true, subtree: true });
  }
  const shared = hub;
  const subscriber: DocumentMutationSubscriber = () => check();
  shared.subscribers.add(subscriber);
  return () => {
    shared.subscribers.delete(subscriber);
    if (shared.subscribers.size === 0 && state.mutationHub === shared) {
      shared.observer.disconnect();
      delete state.mutationHub;
    }
  };
}

`;
