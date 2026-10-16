/**
 * Head declarations: what a component adds to `document.head` while an instance is connected
 * (https://nextwebwg.org/declarative-components/components#head-management).
 *
 * Every HTML Next bundle on a page (the live runtime, compiled modules and converted framework
 * components) keeps one head manager on the document record, so one reconciliation covers every
 * contribution. Converted framework components carry this module's source, so it imports nothing.
 */

/** The attribute on every element in `document.head` the component runtime manages. */
export const HEAD_MARKER = "data-component-head";

/** A contribution's element: its tag, its attributes in order, and its text. */
export type HeadEntry = readonly [tag: string, attributes: readonly (readonly [name: string, value: string])[], text?: string];

/** One connected instance's evaluated head declarations, in declared order; undefined omits one. */
interface Contributor {
  readonly root: () => Element | undefined;
  readonly entries: readonly (HeadEntry | undefined)[];
  /** When it connected: between instances at one depth, the later one wins. */
  readonly order: number;
  /** Server rendering without a document tree gives the depth itself; its order is then tree order. */
  readonly depth?: number;
}

interface HeadManager {
  readonly contributors: Set<Contributor>;
  /** Declared scripts by key: resolved URL and classic or module. */
  scripts?: Map<string, ScriptEntry>;
  /** The document's import map, read once, for bare script names. */
  imports?: Readonly<Record<string, string>>;
  lazy?: IntersectionObserver;
  near?: WeakMap<Element, Set<Binding>>;
  /** Each competing family's authored elements, set aside while a contribution replaces them. */
  readonly setAside: Map<string, Element[]>;
  /** Contributors' roots, so a root without a component marker still counts toward depth. */
  readonly roots: WeakSet<Element>;
  /** Preload links that declared scripts own; reconciliation never removes them. */
  readonly preloads: Set<string>;
  scheduled: boolean;
  connections: number;
}

const runtimeKey = Symbol.for("@nextwebwg/html-next.runtime.v1");
type DocumentRecord = { head?: HeadManager };
const documentRecord = (document: Document): DocumentRecord =>
  (document as unknown as Record<symbol, DocumentRecord>)[runtimeKey] ??= {};

/**
 * The key of a head element or an entry, and the top-level competing key of its family. A shared
 * key has no family. Keys are prefixed by kind: `t` title, `c` canonical, `n` meta name, `p` meta
 * property, `l` other links, `j` JSON-LD.
 */
function keyOf(document: Document, tag: string, read: (name: string) => string | null, text: () => string): readonly [string, string?] | undefined {
  if (tag === "title") return ["t", "t"];
  if (tag === "meta") {
    const name = read("name");
    const property = name === null ? read("property") : null;
    const value = name?.toLowerCase() ?? property;
    if (value == null) return undefined;
    const kind = name === null ? "p" : "n";
    // Three or more colon-separated parts make a sub-property of the key without its last part.
    const parts = value.split(":");
    return [`${kind}${value}`, `${kind}${parts.length < 3 ? value : `${parts[0]}:${parts[1]}`}`];
  }
  if (tag === "link") {
    const rel = read("rel")?.trim().toLowerCase();
    if (rel === undefined) return undefined;
    if (rel === "canonical") return ["c", "c"];
    const href = read("href");
    if (href === null) return undefined;
    let resolved = href;
    try { resolved = new URL(href, document.baseURI).href; } catch { /* kept as written */ }
    return [`l${rel} ${resolved}`];
  }
  if (tag === "script" && read("type")?.trim().toLowerCase() === "application/ld+json") return [`j${text()}`];
  return undefined;
}

function elementKey(element: Element): readonly [string, string?] | undefined {
  return keyOf(element.ownerDocument, element.localName, (name) => element.getAttribute(name), () => element.textContent ?? "");
}

function entryKey(document: Document, [tag, attributes, text]: HeadEntry): readonly [string, string?] | undefined {
  return keyOf(document, tag, (name) => attributes.find(([attribute]) => attribute === name)?.[1] ?? null, () => text ?? "");
}

function create(document: Document, [tag, attributes, text]: HeadEntry): Element {
  const element = document.createElement(tag);
  for (const [name, value] of attributes) element.setAttribute(name, value);
  if (text !== undefined) element.textContent = text;
  element.setAttribute(HEAD_MARKER, "");
  return element;
}

/** Sets attributes and text, changing only values that differ. */
function patch(element: Element, [, attributes, text]: HeadEntry): void {
  for (const { name } of Array.from(element.attributes)) {
    if (name !== HEAD_MARKER && !attributes.some(([attribute]) => attribute === name)) element.removeAttribute(name);
  }
  for (const [name, value] of attributes) if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  if (text !== undefined && element.textContent !== text) element.textContent = text;
}

function managerFor(document: Document): HeadManager {
  const record = documentRecord(document);
  if (record.head !== undefined) return record.head;
  const manager: HeadManager = { contributors: new Set(), setAside: new Map(), roots: new WeakSet(),
    preloads: new Set(), scheduled: false, connections: 0 };
  record.head = manager;
  // Server output carries the authored elements a family set aside, to restore as the same nodes.
  for (const template of Array.from(document.head?.querySelectorAll(`template[${HEAD_MARKER}="set-aside"]`) ?? [])) {
    const nodes = Array.from((template as HTMLTemplateElement).content.children).map((node) => document.adoptNode(node));
    const family = nodes[0] === undefined ? undefined : elementKey(nodes[0])?.[1];
    if (family !== undefined) manager.setAside.set(family, nodes);
    template.remove();
  }
  return manager;
}

/** How many component roots enclose `root`: its depth in the component tree. */
function depthOf(root: Element, manager: HeadManager): number {
  let depth = 0;
  // `data-component` marks live, compiled and React roots, `data-hn` converted Vue roots.
  for (let element = root.parentElement; element !== null; element = element.parentElement) {
    if (element.hasAttribute("data-component") || element.hasAttribute("data-hn") || manager.roots.has(element)) depth += 1;
  }
  return depth;
}

/** Reconciliation: brings `document.head` to the target state of the current contributions, once. */
function reconcile(document: Document, manager: HeadManager): void {
  manager.scheduled = false;
  const head = document.head;
  if (head === null) return;
  const contributors = Array.from(manager.contributors, (contributor) => ({ contributor, root: contributor.root() }))
    .filter((item) => item.root !== undefined || item.contributor.depth !== undefined);
  // Tree order of instances orders new elements; precedence picks each competing family's winner.
  const treeOrder = new Map(contributors.toSorted((a, b) => a.root === undefined || b.root === undefined ? a.contributor.order - b.contributor.order
    : a.root === b.root ? 0 : a.root.compareDocumentPosition(b.root) & 4 /* FOLLOWING */ ? -1 : 1).map((item, index) => [item.contributor, index]));
  const depths = new Map(contributors.map((item) => [item.contributor, item.contributor.depth ?? depthOf(item.root!, manager)]));
  const ranked = contributors.map((item) => item.contributor)
    .sort((a, b) => depths.get(b)! - depths.get(a)! || b.order - a.order);

  // 1. Target state.
  type Placed = readonly [entry: HeadEntry, tree: number, declared: number];
  const families = new Map<string, Placed[]>();
  const shared = new Map<string, Placed>();
  for (const contributor of ranked) {
    const tree = treeOrder.get(contributor)!;
    contributor.entries.forEach((entry, declared) => {
      if (entry === undefined) return;
      const [key, family] = entryKey(document, entry) ?? [];
      if (key === undefined) return;
      if (family === undefined) {
        const known = shared.get(key);
        if (known === undefined || tree < known[1]) shared.set(key, [entry, tree, declared]);
      } else if (key === family && !families.has(family)) {
        // The first contributor of the top-level key, by precedence, wins its whole family.
        families.set(family, contributor.entries.flatMap((candidate, index): Placed[] =>
          candidate !== undefined && entryKey(document, candidate)?.[1] === family ? [[candidate, tree, index]] : []));
      }
    });
  }

  const marked = new Map<string, Element[]>();
  const authored = new Map<string, Element[]>();
  for (const element of Array.from(head.children)) {
    const [key, family] = elementKey(element) ?? [];
    if (key === undefined) continue;
    const bucket = element.hasAttribute(HEAD_MARKER) ? marked : authored;
    const known = bucket.get(family ?? key);
    if (known === undefined) bucket.set(family ?? key, [element]);
    else known.push(element);
  }
  const appended: [tree: number, declared: number, element: Element][] = [];
  const competing = (key: string): boolean => "tcnp".includes(key[0]!);

  // 2 and 3. Competing families.
  for (const family of new Set([...families.keys(), ...manager.setAside.keys(), ...Array.from(marked.keys()).filter(competing)])) {
    const target = families.get(family);
    const elements = marked.get(family) ?? [];
    if (target !== undefined) {
      if (elements.length > 0) {
        let last = elements.at(-1)!;
        target.forEach(([entry], index) => {
          const element = elements[index];
          if (element !== undefined) patch(element, entry);
          else last.after(last = create(document, entry));
        });
        for (const element of elements.slice(target.length)) element.remove();
      } else if ((authored.get(family)?.length ?? 0) > 0) {
        const aside = authored.get(family)!;
        manager.setAside.set(family, aside);
        for (const [entry] of target) head.insertBefore(create(document, entry), aside[0]!);
        for (const element of aside) element.remove();
      } else {
        for (const [entry, tree, declared] of target) appended.push([tree, declared, create(document, entry)]);
      }
    } else {
      const aside = manager.setAside.get(family);
      if (aside !== undefined) {
        for (const element of aside) head.insertBefore(element, elements[0] ?? null);
        manager.setAside.delete(family);
      }
      for (const element of elements) element.remove();
    }
  }

  // 4 and 5. Shared keys: one element per key, marked or authored.
  for (const [key, [entry, tree, declared]] of shared) {
    if (!marked.has(key) && !authored.has(key)) appended.push([tree, declared, create(document, entry)]);
  }
  for (const [key, elements] of marked) {
    if (competing(key) || shared.has(key)) continue;
    for (const element of elements) {
      const rel = element.localName === "link" ? element.getAttribute("rel")?.trim().toLowerCase() : undefined;
      if ((rel === "preload" || rel === "modulepreload") && manager.preloads.has((element as HTMLLinkElement).href)) continue;
      element.remove();
    }
  }

  // 6. New elements in tree order of their instances, then declared order.
  appended.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, , element] of appended) head.append(element);
}

/** Reconciles now if a change is waiting, as an update's last step. */
export function flushHead(document: Document): void {
  const manager = documentRecord(document).head;
  if (manager?.scheduled) reconcile(document, manager);
}

/** Records a change: the head reconciles once, after this update's connections and disconnections. */
export function scheduleHead(document: Document): void {
  const manager = managerFor(document);
  if (manager.scheduled) return;
  manager.scheduled = true;
  queueMicrotask(() => flushHead(document));
}

/**
 * Connects one instance's head declarations: `entries` holds their evaluated elements, which the
 * caller updates in place before calling `scheduleHead`. Returns the disconnection.
 */
export function joinHead(document: Document, root: () => Element | undefined, entries: readonly (HeadEntry | undefined)[]): () => void {
  const manager = managerFor(document);
  const contributor: Contributor = { root, entries, order: ++manager.connections };
  manager.contributors.add(contributor);
  const element = root();
  if (element !== undefined) manager.roots.add(element);
  scheduleHead(document);
  return () => {
    if (manager.contributors.delete(contributor)) scheduleHead(document);
  };
}

/** A declared `<script src>` as an implementation passes it (components#declared-scripts). */
export interface DeclaredScript {
  /** As written: URL-like, resolved against `base`, or bare, resolved through the document's import map. */
  readonly src: string;
  /** The definition's URL. */
  readonly base: string;
  readonly type?: "module" | undefined;
  readonly loading: "eager" | "lazy" | "manual";
  readonly integrity?: string | undefined;
  readonly crossorigin?: string | undefined;
  readonly referrerpolicy?: string | undefined;
  readonly fetchpriority?: string | undefined;
  /** The application's nonce on the import that reached the definition. */
  readonly nonce?: string | undefined;
  /** Where diagnostics point. */
  readonly source: string;
}

/** A declared script's status, as `$name` and `host.scripts.name` read it. */
export interface ScriptStatus {
  readonly pending: boolean;
  readonly ok: boolean;
  readonly error: Event | TypeError | null;
}

/** One instance's declaration of a script. */
export interface ScriptHandle {
  /** The instance connected: binds it to the script, which an eager declaration calls for. */
  connect(): void;
  disconnect(): void;
  /** Inserts the script's element if it is not inserted yet; returns `ready`. */
  load(): Promise<void>;
  /** Resolves when the script loads and rejects with its `error` event; settles once. */
  readonly ready: Promise<void>;
  status(): ScriptStatus;
}

/** One script per resolved URL and type, for the document's lifetime. */
interface ScriptEntry {
  readonly url: string;
  readonly module: boolean;
  element?: HTMLScriptElement;
  /** The fetch-changing attributes of its first declaration, or of the authored element it uses. */
  readonly fetch: string;
  status: ScriptStatus;
  loaded: boolean;
  event?: Event;
  readonly ready: Promise<void>;
  readonly settle: (loaded: boolean, event: Event) => void;
  readonly bindings: Set<Binding>;
}

interface Binding {
  readonly call: () => void;
  readonly queue: () => void;
  readonly changed: () => void;
  connected: boolean;
  ran: boolean;
}

const BEFORE: ScriptStatus = /* @__PURE__ */ Object.freeze({ pending: false, ok: false, error: null });
const URL_LIKE = /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/;
/** How near the viewport a lazy script's root comes before it loads, as Chromium fetches an `<img loading="lazy">`. */
const LAZY_MARGIN = "1250px";

/** A script's URL: URL-like against the definition, bare through the document's import map. */
function resolveScript(document: Document, manager: HeadManager, src: string, base: string): string {
  if (URL_LIKE.test(src)) return new URL(src, /^https?:/.test(base) ? base : document.baseURI).href;
  if (manager.imports === undefined) {
    const imports: Record<string, string> = {};
    for (const script of Array.from(document.querySelectorAll('script[type="importmap"]'))) {
      try {
        for (const [key, target] of Object.entries((JSON.parse(script.textContent ?? "{}") as { imports?: Record<string, string> }).imports ?? {})) {
          imports[key] ??= new URL(target, document.baseURI).href;
        }
      } catch { /* the browser reports an invalid import map */ }
    }
    manager.imports = imports;
  }
  const exact = manager.imports[src];
  if (exact !== undefined) return exact;
  const prefix = Object.keys(manager.imports).filter((key) => key.endsWith("/") && src.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  if (prefix === undefined) throw new TypeError(`Declared script \`${src}\` is not mapped by the document's import map.`);
  return new URL(src.slice(prefix.length), manager.imports[prefix]).href;
}

/** The attributes that change a script's fetch: declarations of one script must agree on them. */
function fetchOf(integrity: string | null | undefined, crossorigin: string | null | undefined, referrerpolicy: string | null | undefined): string {
  const cors = crossorigin == null ? "" : crossorigin.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous";
  return JSON.stringify([integrity ?? "", cors, referrerpolicy?.toLowerCase() ?? ""]);
}

const isModule = (script: HTMLScriptElement): boolean => script.type.trim().toLowerCase() === "module";

/** S2: the document's entry for a script, using an authored `<script>` for it when there is one. */
function entryFor(document: Document, manager: HeadManager, url: string, module: boolean, fetch: string): ScriptEntry {
  const key = `${module ? "module" : "classic"} ${url}`;
  const known = (manager.scripts ??= new Map()).get(key);
  if (known !== undefined) return known;
  const authored = Array.from(document.scripts).find((script) => !script.hasAttribute(HEAD_MARKER) && script.hasAttribute("src") &&
    script.src === url && isModule(script) === module);
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  // A failure reaches whoever waits on `ready`; nobody waiting is not an unhandled rejection.
  ready.catch(() => {});
  const entry: ScriptEntry = {
    url, module, ready, bindings: new Set(), status: BEFORE, loaded: false,
    fetch: authored === undefined ? fetch
      : fetchOf(authored.getAttribute("integrity"), authored.getAttribute("crossorigin"), authored.getAttribute("referrerpolicy")),
    // S6 and S7: settle once, `ready` first, then each connected instance's handler (S8).
    settle(loaded, event) {
      if (entry.status.ok || entry.status.error !== null) return;
      entry.loaded = loaded;
      entry.event = event;
      entry.status = Object.freeze(loaded ? { pending: false, ok: true, error: null } : { pending: false, ok: false, error: event });
      if (loaded) resolve();
      else reject(event);
      for (const binding of entry.bindings) {
        binding.changed();
        if (binding.connected && !binding.ran) binding.queue();
      }
    },
  };
  manager.scripts!.set(key, entry);
  // A preload link server output wrote for the script belongs to it.
  manager.preloads.add(url);
  if (authored !== undefined) {
    entry.element = authored;
    entry.status = Object.freeze({ pending: true, ok: false, error: null });
    // A parser-inserted classic script without async or defer has run, and so has any script once the document loaded.
    if ((!module && !authored.async && !authored.defer) || document.readyState === "complete") entry.settle(true, new Event("load"));
    else {
      authored.addEventListener("load", (event) => entry.settle(true, event), { once: true });
      authored.addEventListener("error", (event) => entry.settle(false, event), { once: true });
    }
  }
  return entry;
}

/** S4: one new `<script>` element in the document, for the declaration that calls for it first. */
function insertScript(document: Document, entry: ScriptEntry, declaration: DeclaredScript): void {
  if (entry.element !== undefined) return;
  const script = document.createElement("script");
  script.src = entry.url;
  if (entry.module) script.type = "module";
  for (const name of ["integrity", "crossorigin", "referrerpolicy", "fetchpriority"] as const) {
    const value = declaration[name];
    if (value !== undefined) script.setAttribute(name, value);
  }
  if (declaration.nonce !== undefined) script.nonce = declaration.nonce;
  script.setAttribute(HEAD_MARKER, "");
  script.addEventListener("load", (event) => entry.settle(true, event), { once: true });
  script.addEventListener("error", (event) => entry.settle(false, event), { once: true });
  entry.element = script;
  entry.status = Object.freeze({ pending: true, ok: false, error: null });
  for (const binding of entry.bindings) binding.changed();
  document.head.append(script);
}

/** Calls for a lazy script when its root first comes near the viewport. */
function whenNear(document: Document, manager: HeadManager, root: Element, binding: Binding): () => void {
  const Observer = document.defaultView?.IntersectionObserver;
  if (Observer === undefined) {
    binding.call();
    return () => {};
  }
  manager.lazy ??= new Observer((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const waiting = manager.near!.get(record.target);
      manager.near!.delete(record.target);
      manager.lazy!.unobserve(record.target);
      for (const near of waiting ?? []) near.call();
    }
  }, { rootMargin: LAZY_MARGIN });
  const near = manager.near ??= new WeakMap();
  let waiting = near.get(root);
  if (waiting === undefined) {
    near.set(root, waiting = new Set());
    manager.lazy.observe(root);
  }
  waiting.add(binding);
  return () => {
    if (!waiting.delete(binding) || waiting.size > 0) return;
    near.delete(root);
    manager.lazy?.unobserve(root);
  };
}

/**
 * One instance's declared script (S1–S8). `run` runs its `on:load` or `on:error` handler, once per
 * connection, after the script settles; `changed` reports a status change.
 */
export function declareScript(document: Document, declaration: DeclaredScript, root: () => Element | undefined,
  run: (loaded: boolean, event: Event) => void, changed: () => void): ScriptHandle {
  const manager = managerFor(document);
  let entry: ScriptEntry | undefined;
  let failure: { readonly error: TypeError; readonly ready: Promise<void>; readonly event: Event } | undefined;
  let connection = 0;
  let unobserve: (() => void) | undefined;
  const fail = (code: string, error: TypeError): void => {
    const ready = Promise.reject(error);
    ready.catch(() => {});
    const ErrorEvent = document.defaultView?.ErrorEvent;
    failure = { error, ready, event: ErrorEvent === undefined ? new Event("error") : new ErrorEvent("error", { error, message: error.message }) };
    console.error(`${declaration.source}: ${code}: ${error.message}`);
  };
  // S1 and S3: bind to the document's entry; a declaration that disagrees on the fetch fails for this instance.
  const bind = (): void => {
    if (entry !== undefined || failure !== undefined) return;
    let url: string;
    try { url = resolveScript(document, manager, declaration.src, declaration.base); }
    catch (error) { fail("HR012", error as TypeError); return; }
    const fetch = fetchOf(declaration.integrity, declaration.crossorigin, declaration.referrerpolicy);
    const bound = entryFor(document, manager, url, declaration.type === "module", fetch);
    if (bound.fetch !== fetch) {
      fail("HR011", new TypeError(`Script \`${url}\` is declared with different integrity, crossorigin or referrerpolicy attributes.`));
      return;
    }
    entry = bound;
    bound.bindings.add(binding);
  };
  const binding: Binding = {
    connected: false,
    ran: false,
    changed,
    call() {
      bind();
      if (entry !== undefined) insertScript(document, entry, declaration);
    },
    // S8: one handler for this connection, unless it ends first.
    queue() {
      const current = connection;
      queueMicrotask(() => {
        if (!binding.connected || connection !== current || binding.ran) return;
        binding.ran = true;
        if (failure !== undefined) run(false, failure.event);
        else run(entry!.loaded, entry!.event!);
      });
    },
  };
  return {
    connect() {
      if (binding.connected) return;
      bind();
      // Another declaration may have inserted or settled the script already.
      changed();
      binding.connected = true;
      binding.ran = false;
      connection += 1;
      if (failure !== undefined || entry!.status.ok || entry!.status.error !== null) binding.queue();
      if (failure !== undefined || entry!.element !== undefined) return;
      const element = root();
      if (declaration.loading === "eager") binding.call();
      else if (declaration.loading === "lazy" && element !== undefined) unobserve = whenNear(document, manager, element, binding);
    },
    disconnect() {
      binding.connected = false;
      unobserve?.();
      unobserve = undefined;
    },
    load() {
      binding.call();
      return failure?.ready ?? entry!.ready;
    },
    get ready() {
      bind();
      return failure?.ready ?? entry!.ready;
    },
    status: () => failure === undefined ? entry?.status ?? BEFORE : Object.freeze({ pending: false, ok: false, error: failure.error }),
  };
}

/**
 * Server output (H2 and H3): each family's set-aside elements in a `<template data-component-head="set-aside">`
 * after its last marked element, and a preload link for each eager script no authored script satisfies.
 */
export function writeServerHead(document: Document, eager: readonly DeclaredScript[]): void {
  const manager = managerFor(document);
  flushHead(document);
  for (const [family, elements] of manager.setAside) {
    const marked = Array.from(document.head.children).filter((element) => element.hasAttribute(HEAD_MARKER) && elementKey(element)?.[1] === family);
    const template = document.createElement("template");
    template.setAttribute(HEAD_MARKER, "set-aside");
    template.content.append(...elements);
    (marked.at(-1) ?? document.head.lastChild)?.after(template);
  }
  manager.setAside.clear();
  for (const declaration of eager) {
    let url: string;
    try { url = resolveScript(document, manager, declaration.src, declaration.base); } catch { continue; }
    const module = declaration.type === "module";
    const rel = module ? "modulepreload" : "preload";
    if (Array.from(document.scripts).some((script) => script.hasAttribute("src") && script.src === url && isModule(script) === module) ||
      Array.from(document.head.querySelectorAll(`link[${HEAD_MARKER}]`)).some((link) => (link as HTMLLinkElement).rel === rel && (link as HTMLLinkElement).href === url)) continue;
    const link = document.createElement("link");
    link.setAttribute("rel", rel);
    if (!module) link.setAttribute("as", "script");
    // A same-origin script's preload is a path, so it is the same URL wherever the page is served.
    const target = new URL(url);
    link.setAttribute("href", target.origin === new URL(document.baseURI).origin ? target.pathname + target.search + target.hash : url);
    for (const name of ["crossorigin", "integrity", "referrerpolicy", "fetchpriority"] as const) {
      const value = declaration[name];
      if (value !== undefined) link.setAttribute(name, value);
    }
    link.setAttribute(HEAD_MARKER, "");
    document.head.append(link);
  }
}

/**
 * A framework's server rendering, which has no document tree: each head-declaring component adds its
 * evaluated declarations, in render order, with its depth among them, and each eager declared script.
 */
export interface HeadCollector {
  readonly contributions: [depth: number, entries: readonly (HeadEntry | undefined)[]][];
  readonly eager: DeclaredScript[];
}

export function createHeadCollector(): HeadCollector {
  return { contributions: [], eager: [] };
}

/**
 * Writes what a framework's server rendering collected into `document`, which holds the application's
 * own head: the same reconciliation, set-aside templates and preload links as `renderComponents`.
 */
export function writeCollectedHead(document: Document, collector: HeadCollector): void {
  const manager = managerFor(document);
  for (const [depth, entries] of collector.contributions) {
    manager.contributors.add({ root: () => undefined, entries, order: ++manager.connections, depth });
  }
  manager.scheduled = true;
  writeServerHead(document, collector.eager);
}

/** One compiled or converted component instance's head declarations. */
export interface HeadInstance {
  /** The instance connected to a document. */
  connect(): void;
  disconnect(): void;
  /** The declarations' evaluated elements, in declared order; the head reconciles when they change. */
  update(entries: readonly (HeadEntry | undefined)[]): void;
}

export function headInstance(root: () => Element | undefined): HeadInstance {
  const entries: (HeadEntry | undefined)[] = [];
  let text = "[]";
  let leave: (() => void) | undefined;
  const document = (): Document => root()?.ownerDocument ?? globalThis.document;
  return {
    connect() {
      leave ??= joinHead(document(), root, entries);
    },
    disconnect() {
      leave?.();
      leave = undefined;
    },
    update(next) {
      const nextText = JSON.stringify(next);
      if (nextText === text) return;
      text = nextText;
      entries.splice(0, entries.length, ...next);
      if (leave !== undefined) scheduleHead(document());
    },
  };
}

/** A declared script as a compiled or converted component passes it: the script, its name, and its handlers. */
export type InstanceScript = readonly [declaration: DeclaredScript, name: string | undefined,
  run: (loaded: boolean, event: Event) => void, changed: (status: ScriptStatus) => void];

/** One compiled or converted component instance's declared scripts, connected with it. */
export interface InstanceScripts {
  connect(): void;
  disconnect(): void;
  /** Named scripts, for `host.scripts`. */
  readonly scripts: Readonly<Record<string, ScriptHandle>>;
}

export function instanceScripts(root: () => Element | undefined, scripts: readonly InstanceScript[]): InstanceScripts {
  let handles: ScriptHandle[] | undefined;
  const named: Record<string, ScriptHandle> = {};
  // Handles bind to the document's scripts on first use, which is the first connection or `host.scripts`.
  const handlesFor = (): ScriptHandle[] => handles ??= scripts.map(([declaration, name, run, changed]) => {
    const handle: ScriptHandle = declareScript(root()?.ownerDocument ?? globalThis.document, declaration, root, run, () => changed(handle.status()));
    if (name !== undefined) named[name] = handle;
    return handle;
  });
  return {
    connect() { for (const handle of handlesFor()) handle.connect(); },
    disconnect() { for (const handle of handles ?? []) handle.disconnect(); },
    scripts: new Proxy(named, { get: (target, key) => (handlesFor(), Reflect.get(target, key)), has: (target, key) => (handlesFor(), Reflect.has(target, key)) }),
  };
}
