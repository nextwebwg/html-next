/**
 * Requests: behavior a component asks its consumer for, answered through a native event's
 * `respondWith` (https://nextwebwg.org/declarative-components/javascript#requests).
 *
 * Every HTML Next bundle on a page (the live runtime, compiled modules and framework helpers) keeps
 * its requests in one record on the document, so any consumer answers any component, and one
 * document listener relays late responders. Converted framework components carry this module's
 * source (scripts/generate-literal-source.ts), so it imports nothing.
 */

/** What `host.request` takes besides the name and detail. */
export interface RequestOptions {
  /** Abort to withdraw the request. */
  readonly signal?: AbortSignal | undefined;
  /** Receives the responder's progress while the request is pending. */
  readonly progress?: ((loaded: number, total: number) => void) | undefined;
}

/** What a responder function receives besides the detail. */
export interface ResponderInit {
  readonly signal: AbortSignal;
  readonly progress: (loaded: number, total: number) => void;
}

/** A function that always answers: the answer, `null` for none, or a promise of either. */
export type Responder<Detail = unknown, Answer = unknown> =
  (detail: Detail, init: ResponderInit) => Answer | null | PromiseLike<Answer | null>;

/** A declared request's detail and answer checks, built from its `type` and `returns`. */
export type RequestChecks = readonly [detail: (value: unknown) => boolean, answer: (value: unknown) => boolean];

export interface RequestEventInit<Detail> extends CustomEventInit<Detail> {
  readonly signal: AbortSignal;
}

/** An event's recorded answer, and the asker's progress callback while the request is pending. */
interface Port { a?: readonly [unknown]; p?: ((loaded: number, total: number) => void) | undefined }
const ports = new WeakMap<Event, Port>();
const port = (event: Event): Port => {
  let found = ports.get(event);
  if (found === undefined) ports.set(event, found = {});
  return found;
};

/** A request as its responders receive it: the nearest one answers with `respondWith`. */
export class RequestEvent<Detail = unknown, Answer = unknown> extends CustomEvent<Detail> {
  /** Aborts when the asker no longer needs the answer, or its component disconnects. */
  readonly signal: AbortSignal;

  constructor(type: string, init: RequestEventInit<Detail>) {
    super(type, init);
    this.signal = init.signal;
  }

  /** Answer the request with a value or a promise of one; the event stops propagating. */
  respondWith(answer: Answer | null | PromiseLike<Answer | null>): void {
    const recorded = port(this);
    if (this.eventPhase === 0 || recorded.a !== undefined) {
      throw new DOMException(recorded.a === undefined ? "A request is answered while it is dispatched." : "The request already has an answer.", "InvalidStateError");
    }
    recorded.a = [answer];
    this.stopImmediatePropagation();
  }

  /** Report progress to the asker while the request is pending. */
  progress(loaded: number, total: number): void {
    const report = this.signal.aborted ? undefined : ports.get(this)?.p;
    // The asker's exception is reported as a listener's is, and never reaches the responder.
    try { report?.(loaded, total); } catch (error) { reportError(error); }
  }
}

/** Answers a request event with a responder function, as `respond()` and framework function props do. */
export function answerRequest(event: Event, responder: Responder<any, any>): void {
  const request = event as RequestEvent;
  request.respondWith(responder(request.detail, { signal: request.signal, progress: (loaded, total) => request.progress(loaded, total) }));
}

/**
 * The record every HTML Next bundle in the realm keeps on the document. Its `requests` hold the roots
 * whose controller has not yet run its synchronous body (`g`) and the remembered unanswered requests
 * (`m`). Its `relay` is installed by the first bundle that remembers a request, so a host that only
 * answers calls it when present and bundles none of this module.
 */
interface DocumentRecord {
  requests?: RequestState;
  relay?: (from: Node, name: string) => void;
}
export interface RequestState {
  readonly g: WeakMap<Node, Promise<void>>;
  m?: Map<Element, Set<string>>;
}
const runtimeKey = Symbol.for("@nextwebwg/html-next.runtime.v1");
const documentRecord = (document: Document): DocumentRecord => (document as Document & { [runtimeKey]?: DocumentRecord })[runtimeKey] ??= {};
const requestState = (document: Document): RequestState => documentRecord(document).requests ??= { g: new WeakMap() };

/**
 * Marks a root whose controller is about to run, so requests from inside it wait for its
 * synchronous body (step 4). The returned release runs once the body returns or fails to load.
 */
export function holdController(root: Element): () => void {
  const { g: gates } = requestState(root.ownerDocument);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  gates.set(root, gate);
  return () => {
    if (gates.get(root) === gate) gates.delete(root);
    release();
  };
}

/** A responder the runtime registers on `from` for `name` relays as an announcement from there would. */
export function relayResponders(from: Element, name: string): void {
  documentRecord(from.ownerDocument).relay?.(from, name);
}

/**
 * What `host.on(type, …)` adds: a `responder` listener hears only the runtime's relay to its own
 * root. The relay does not bubble, so it reaches a root's listener only when the root is its target;
 * an announcement that bubbles through the root is someone else's.
 */
export function hostListener(type: string, callback: (event: Event) => unknown): (event: Event) => void {
  return (event) => { if (type !== "responder" || !event.bubbles) callback(event); };
}

/** Settles with `value`, or rejects with the signal's reason when it aborts first; a late value is discarded. */
function settle<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => { signal.removeEventListener("abort", abort); resolve(result); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** One record per connected instance and name, kept until answered, relayed, or the instance disconnects. */
function remember(state: RequestState, root: Element, name: string, connection: AbortSignal): void {
  let remembered = state.m;
  if (remembered === undefined) {
    const records = remembered = state.m = new Map();
    const relay = documentRecord(root.ownerDocument).relay = (from: Node, relayed: string): void => {
      const roots = [...records].filter(([candidate, names]) => names.has(relayed) && from.contains(candidate))
        .map(([candidate]) => candidate)
        .sort((a, b) => a.compareDocumentPosition(b) & 4 /* FOLLOWING */ ? -1 : 1);
      for (const target of roots) {
        records.get(target)?.delete(relayed);
        // It does not bubble, so the document never hears it as another announcement.
        target.dispatchEvent(new CustomEvent("responder", { detail: { name: relayed } }));
      }
    };
    // The one listener for announcements: page scripts and `respond()` dispatch a bubbling `responder`.
    root.ownerDocument.addEventListener("responder", (event) => {
      const announced = (event as CustomEvent<{ name?: unknown } | null>).detail?.name;
      if (event.bubbles && typeof announced === "string" && event.target instanceof Node) relay(event.target, announced);
    });
  }
  let names = remembered.get(root);
  if (names === undefined) {
    remembered.set(root, names = new Set());
    connection.addEventListener("abort", () => { if (remembered.get(root) === names) remembered.delete(root); }, { once: true });
  }
  names.add(name);
}

/**
 * Asks a declared request at `root` (the request steps): checks the detail, waits for the
 * controllers of components around it, dispatches the `RequestEvent`, and settles with the answer
 * it receives, checked against `returns`, or `null` when nobody answered. `checks` is undefined when
 * the definition declares no request named `name`.
 */
export async function ask(
  root: Element,
  connection: AbortSignal,
  name: string,
  detail: unknown,
  options: RequestOptions | undefined,
  checks: RequestChecks | undefined,
  warn: (message: string) => void,
): Promise<unknown> {
  if (checks === undefined) throw new TypeError(`No <request> named \`${name}\` is declared.`);
  detail ??= null;
  if (!checks[0](detail)) {
    const message = `Request \`${name}\` detail does not satisfy its declared type.`;
    warn(message);
    throw new TypeError(message);
  }
  const signal = options?.signal === undefined ? connection : AbortSignal.any([options.signal, connection]);
  signal.throwIfAborted();
  const state = requestState(root.ownerDocument);
  // A consumer's controller may load after this one: wait for every one around this root to run.
  for (;;) {
    const waits: Promise<void>[] = [];
    for (let node: Node | null = root.parentNode; node !== null; node = node.parentNode ?? (node as ShadowRoot).host ?? null) {
      const gate = state.g.get(node);
      if (gate !== undefined) waits.push(gate);
    }
    if (waits.length === 0) break;
    await settle(Promise.all(waits), signal);
  }
  const event = new RequestEvent(name, { detail, signal, bubbles: true, composed: true });
  const recorded = port(event);
  recorded.p = options?.progress;
  root.dispatchEvent(event);
  if (recorded.a === undefined) {
    recorded.p = undefined;
    remember(state, root, name, connection);
    return null;
  }
  state.m?.get(root)?.delete(name);
  let answer: unknown;
  try { answer = await settle(recorded.a[0], signal); }
  finally { recorded.p = undefined; }
  if (answer !== null && !checks[1](answer)) {
    const message = `Request \`${name}\` answer does not satisfy its declared type.`;
    warn(message);
    throw new TypeError(message);
  }
  return answer;
}

/**
 * A converted framework component's `host.request`: its declared requests' checks, with the runtime
 * warning (HR007) once per message, as the live runtime warns.
 */
export function frameworkRequest(source: string, checks: Readonly<Record<string, RequestChecks>>) {
  const warned = new Set<string>();
  return (root: Element, connection: AbortSignal, name: string, detail?: unknown, options?: RequestOptions): Promise<unknown> =>
    ask(root, connection, name, detail, options, checks[name], (message) => {
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(`${source}: HR007: ${message}`);
    });
}

/**
 * The listener a framework component adds on its root for a request, read when the request arrives:
 * its function prop answers; otherwise its event form receives the event; otherwise none, and the
 * request bubbles on to the component's ancestors.
 */
export function propResponder(responder: unknown, listener: unknown): ((event: Event) => void) | undefined {
  if (typeof responder === "function") return (event) => answerRequest(event, responder as Responder<any, any>);
  return typeof listener === "function" ? listener as (event: Event) => void : undefined;
}

/**
 * Answers `name` requests that reach `target` with `answer`, then announces the responder so a
 * component whose request went unanswered can ask again. Returns a function that removes it.
 */
export function respond<Detail = any, Answer = unknown>(target: EventTarget, name: string, answer: Responder<Detail, Answer>): () => void {
  const listener = (event: Event): void => {
    if ("respondWith" in event) answerRequest(event, answer);
  };
  target.addEventListener(name, listener);
  target.dispatchEvent(new CustomEvent("responder", { bubbles: true, detail: { name } }));
  return () => target.removeEventListener(name, listener);
}
