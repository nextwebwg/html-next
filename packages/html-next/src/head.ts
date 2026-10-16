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
}

interface HeadManager {
  readonly contributors: Set<Contributor>;
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
  const manager: HeadManager = { contributors: new Set(), setAside: new Map(), roots: new WeakSet(), preloads: new Set(), scheduled: false, connections: 0 };
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
    .filter((item): item is { contributor: Contributor; root: Element } => item.root !== undefined);
  // Tree order of instances orders new elements; precedence picks each competing family's winner.
  const treeOrder = new Map(contributors.toSorted((a, b) => a.root === b.root ? 0
    : a.root.compareDocumentPosition(b.root) & 4 /* FOLLOWING */ ? -1 : 1).map((item, index) => [item.contributor, index]));
  const depths = new Map(contributors.map((item) => [item.contributor, depthOf(item.root, manager)]));
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
