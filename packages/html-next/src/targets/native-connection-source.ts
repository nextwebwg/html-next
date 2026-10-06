/** Shared native DOM connection observation; framework ownership stays with each target. */
export const NATIVE_CONNECTION_SOURCE = `interface ConnectionHub {
  readonly observer: MutationObserver;
  readonly checks: Set<() => void>;
}

const connectionHubs = new WeakMap<Document, ConnectionHub>();

function observeConnection(element: Element, check: () => void): () => void {
  const document = element.ownerDocument;
  let hub = connectionHubs.get(document);
  if (hub === undefined) {
    const checks = new Set<() => void>();
    const observer = new MutationObserver(() => { for (const current of checks) current(); });
    observer.observe(document, { childList: true, subtree: true });
    hub = { observer, checks };
    connectionHubs.set(document, hub);
  }
  hub.checks.add(check);
  return () => {
    hub!.checks.delete(check);
    if (hub!.checks.size === 0) {
      hub!.observer.disconnect();
      connectionHubs.delete(document);
    }
  };
}

`;
