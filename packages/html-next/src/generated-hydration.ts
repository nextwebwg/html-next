/**
 * Adoption of server output by compiled components (`hydrate: true`): each block binds the server
 * nodes that stand for its prototype instead of cloning it. Only hydrating modules import these.
 */

import { fail } from "./diagnostics.js";
import { lifecycleKey, type ManagedComponentLifecycle, type RuntimeElement } from "./generated-lifecycle.js";
import { manageIndexedLifecycle } from "./generated-lifecycle-index.js";
import { raw, type KeyedList, type KeyedRow } from "./keyed.js";
import { restoreSerializedFormDefaults, serverMark, serverRanges, type RenderedInstanceRecord } from "./rendered-form.js";

export { renderedInstanceRecord } from "./rendered-form.js";

/** A prototype spec, as `buildTemplate` reads it. */
type Spec = readonly unknown[];

const REGION_MARKS = ["html-next:", "html-next:each-", "html-next:html-"] as const;

/** A comment mark's prefix (`html-next:` for `html-next:start`), or undefined for any other node. */
function commentMark(node: Node, side: "start" | "end"): string | undefined {
  if (node.nodeType !== 8) return undefined;
  const data = (node as Comment).data;
  return data.startsWith("html-next:") && data.endsWith(side) ? data.slice(0, -side.length) : undefined;
}

/**
 * The mark that closes the region `start` opens: the matching `…-end` comment, the matching `<?end?>`
 * of a slot range, or the mark itself for an empty slot's single `<?marker?>`. Undefined when unclosed.
 */
export function regionEnd(start: Node): Node | undefined {
  const prefix = commentMark(start, "start");
  if (prefix === undefined && serverMark(start)?.target === "marker") return start;
  let depth = 1;
  for (let node = start.nextSibling; node !== null; node = node.nextSibling) {
    if (prefix !== undefined) {
      if (commentMark(node, "start") === prefix) depth += 1;
      else if (commentMark(node, "end") === prefix && --depth === 0) return node;
      continue;
    }
    const mark = serverMark(node)?.target;
    if (mark === "start") depth += 1;
    else if (mark === "end" && --depth === 0) return node;
  }
  return undefined;
}

/** Whether `node` opens the region a prototype's code stands for (1 `$if`, 2 `$each`, 3 `$html`, 4 a slot). */
function opens(node: Node | null, code: number): boolean {
  if (node === null) return false;
  if (code === 4) {
    const mark = serverMark(node);
    return (mark?.target === "start" || mark?.target === "marker") && mark.attributes.has("slot");
  }
  return node.nodeType === 8 && (node as Comment).data === `${REGION_MARKS[code - 1]}start`;
}

/** A region a block adopts on its first render, rather than one it renders afresh. */
export const ADOPT = {};

/** Where an adopting walk is: the next server node, where the run ends, and the parent to insert into. */
interface Cursor { node: Node | null; readonly end: Node | null; readonly parent: Node }

/**
 * Adopts one prototype child at `at`, pushing the server nodes that stand for it to `nodes` and
 * moving `at` past them; false when they do not match. Region contents are stepped over (each region
 * is its two marks), an empty Text a `""` value left out is inserted, and an invoked component's root
 * keeps its content, which is that component's.
 */
function adoptChild(child: unknown, at: Cursor, nodes: Node[], invoked: readonly number[]): boolean {
  const cursor = at.node === at.end ? null : at.node;
  if (invoked.includes(nodes.length)) {
    if (cursor === null || cursor.nodeType !== 1) return false;
    nodes.push(cursor);
    at.node = cursor.nextSibling;
  } else if (typeof child === "string" || child === 0) {
    if (cursor !== null && cursor.nodeType === 3) {
      if (typeof child === "string" && (cursor as Text).data !== child) (cursor as Text).data = child;
      nodes.push(cursor);
      at.node = cursor.nextSibling;
    } else {
      // The serializer writes no node for empty text.
      const text = at.parent.ownerDocument!.createTextNode(child === 0 ? "" : child);
      at.parent.insertBefore(text, cursor ?? at.end);
      nodes.push(text);
    }
  } else if (typeof child === "number") {
    const close = cursor !== null && opens(cursor, child) ? regionEnd(cursor) : undefined;
    if (close === undefined) return false;
    nodes.push(cursor!, close);
    at.node = close.nextSibling;
  } else {
    const element = child as Spec;
    if (cursor === null || cursor.nodeType !== 1 || (cursor as Element).localName.toLowerCase() !== (element[0] as string).toLowerCase()) return false;
    nodes.push(cursor);
    if (!adoptChildren(element, { node: cursor.firstChild, end: null, parent: cursor }, nodes, invoked)) return false;
    at.node = cursor.nextSibling;
  }
  return true;
}

/** Adopts a prototype's children in a run of siblings; what follows the last of them is stale, as live's adoption leaves none. */
function adoptChildren(spec: Spec, at: Cursor, nodes: Node[], invoked: readonly number[]): boolean {
  for (let index = 2; index < spec.length; index += 1) if (!adoptChild(spec[index], at, nodes, invoked)) return false;
  while (at.node !== null && at.node !== at.end) {
    const next: ChildNode | null = at.node.nextSibling;
    (at.node as ChildNode).remove();
    at.node = next;
  }
  return true;
}

/**
 * The server nodes standing for a block's prototype, in the prototype's document order, or undefined
 * when they do not match it. `base` is the block's element; for a fragment it is the element whose
 * children the fragment's are (named `tag`), or the mark its content follows. `invoked` lists the
 * positions where an invoked component's root stands.
 */
export function adoptTree(spec: Spec | 5, base: Node, invoked: readonly number[] = [], tag?: string): Node[] | undefined {
  if (spec === 5) return base.nodeType === 1 ? [base] : undefined;
  const nodes: Node[] = [];
  const named = (name: string): boolean => base.nodeType === 1 && (base as Element).localName.toLowerCase() === name.toLowerCase();
  if (spec[0] !== "") {
    if (!named(spec[0] as string)) return undefined;
    nodes.push(base);
    return adoptChildren(spec, { node: base.firstChild, end: null, parent: base }, nodes, invoked) ? nodes : undefined;
  }
  if (base.nodeType === 1) {
    return (tag === undefined || named(tag)) && adoptChildren(spec, { node: base.firstChild, end: null, parent: base }, nodes, invoked) ? nodes : undefined;
  }
  const end = regionEnd(base);
  // An empty slot's single mark is its own end: nothing follows it that it owns.
  return end !== undefined && adoptChildren(spec, { node: end === base ? null : base.nextSibling, end, parent: base.parentNode! }, nodes, invoked)
    ? nodes : undefined;
}

/**
 * The server nodes standing for content a block projected into component `tag`, whose root is `root`:
 * each top-level node is in the slot range its slot rendered, or carried when none did, as live's
 * hydration binds a consumer's projected nodes.
 */
export function adoptProjection(spec: Spec, root: Element, tag: string, invoked: readonly number[] = []): Node[] | undefined {
  const server = serverRanges(root, false, tag);
  const runs = new Map<string, Cursor>();
  for (const range of server?.ranges ?? []) {
    if (range.fallback || range.scoped || runs.has(range.slot)) continue;
    runs.set(range.slot, { node: range.markers[0]!.nextSibling, end: range.markers[1] ?? range.markers[0]!, parent: range.markers[0]!.parentNode! });
  }
  const carried = server?.carried ?? [];
  const rest: Cursor = { node: carried[0] ?? null, end: null, parent: carried[0]?.parentNode ?? root };
  const nodes: Node[] = [];
  for (let index = 2; index < spec.length; index += 1) {
    const child = spec[index];
    const slot = Array.isArray(child) ? slotOf(child[1] as readonly string[]) : "";
    if (!adoptChild(child, runs.get(slot) ?? rest, nodes, invoked)) return undefined;
  }
  return nodes;
}

/** The `slot` literal among a prototype element's attributes, or the unnamed slot. */
function slotOf(attributes: readonly string[]): string {
  for (let index = 0; index < attributes.length; index += 2) if (attributes[index] === "slot") return attributes[index + 1]!;
  return "";
}

/** A restored instance's prop inputs from one source, as the factory's inputs or its HTML input. */
export function recordInputs(record: RenderedInstanceRecord, source: "value" | "html"): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(record.inputs)) if (input.present && input.source === source) inputs[name] = input.value;
  return inputs;
}

/**
 * Restores a server instance's state and props into a compiled root's values, as the live runtime's
 * hydration restores them; their inputs were given to its prop boundary (`recordInputs`).
 */
export function restoreInstance(record: RenderedInstanceRecord, spec: { readonly n: readonly string[]; readonly k?: number },
  values: unknown[], props?: { readonly props: object }): void {
  const { n: names, k = names.length } = spec;
  for (let index = 0; index < k; index += 1) if (Object.hasOwn(record.state, names[index]!)) values[index] = record.state[names[index]!];
  if (props !== undefined) Object.keys(props.props).forEach((name, index) => {
    if (Object.hasOwn(record.props, name)) values[names.length + index] = record.props[name];
  });
}

/** How many factories are adopting, one inside another's first render; their roots connect when the outermost finishes. */
let adopting = 0;
const adopted: ManagedComponentLifecycle[] = [];

/**
 * An adopted root's lifecycle: its record is on the element at once, where inspection, a delegating
 * owner and a context's reader find it, and the root connects once the outermost adoption finished,
 * in document order, as live hydration connects what it lowered.
 */
export function adoptLifecycle(element: Element, connect: () => () => void, handle: unknown): void {
  const record: ManagedComponentLifecycle = { connect, disconnect: undefined, h: handle, element };
  (element as RuntimeElement)[lifecycleKey] = record;
  adopted.push(record);
}

/**
 * Captures what a reader may have changed in the server root's controls before startup, after the
 * serialized form defaults are restored, and starts an adoption. The returned function puts the
 * controls back once the root has rendered, with focus and selection, as the live runtime's hydration
 * does, and the outermost adoption's then connects every root it adopted.
 */
export function holdControls(root: Element): () => void {
  adopting += 1;
  restoreSerializedFormDefaults(root);
  const active = root.ownerDocument.activeElement;
  const controls = "input, textarea, select";
  const held = [...root.matches(controls) ? [root] : [], ...root.querySelectorAll(controls)].map((control) => {
    const element = control as HTMLInputElement;
    const selection = element.localName === "select" ? undefined : [element.selectionStart, element.selectionEnd] as const;
    return [element, element.value, element.checked, selection] as const;
  });
  return () => {
    for (const [element, value, checked, selection] of held) {
      if (element.value !== value) element.value = value;
      if (element.localName === "input" && element.checked !== checked) element.checked = checked;
      if (typeof selection?.[0] === "number" && typeof selection[1] === "number") {
        if (element === active) element.focus({ preventScroll: true });
        element.setSelectionRange(selection[0], selection[1]);
      }
    }
    if (--adopting > 0) return;
    const records = adopted.splice(0).sort((a, b) => a.element === b.element ? 0 : a.element!.compareDocumentPosition(b.element!) & 4 ? -1 : 1);
    for (const record of records) {
      // A root switch may have moved the record to another element since.
      const element = record.element!;
      if ((element as RuntimeElement)[lifecycleKey] !== record) continue;
      delete (element as RuntimeElement)[lifecycleKey];
      manageIndexedLifecycle(element, () => record.connect(element), record.h);
    }
  };
}

/** A row maker that adopts the server nodes at `base` when given one. */
type AdoptingMaker<R> = (item: unknown, index: number, count: number, owner: unknown, base?: Node) => R;

/**
 * A list's first render over server rows: each item adopts the row the server rendered at its
 * position (between item marks; a compiled row of one element keeps no marks), surplus server rows
 * are removed and further items get fresh rows, so no adopted row moves.
 */
export function adoptRows<R extends KeyedRow>(list: KeyedList<R>, items: unknown, ranged: boolean): void {
  list.a = items;
  const values = Array.isArray(items) ? items as readonly unknown[] : [];
  const count = values.length;
  const make = list.mk as AdoptingMaker<R>;
  const next = values.map((value) => {
    const item = raw(value);
    if (item === undefined) fail("HB001", `\`${list.alias}\` is not declared in scope.`);
    return item;
  });
  const keys = list.key === undefined ? undefined : next.map((item, index) => list.key!(item, index, count, list.u));
  if (keys !== undefined && new Set(keys).size !== keys.length) {
    const seen = new Set<unknown>();
    for (const key of keys) {
      if (seen.has(key)) fail("HR004", `A keyed list produced duplicate key \`${String(key)}\`.`);
      seen.add(key);
    }
  }
  const parent = list.e.parentNode!;
  const rows: R[] = [];
  for (let node = list.s.nextSibling; node !== null && node !== list.e;) {
    const end = commentMark(node, "start") === "html-next:item-" ? regionEnd(node) : undefined;
    if (end === undefined) {
      const stray: ChildNode | null = node.nextSibling;
      (node as ChildNode).remove();
      node = stray;
      continue;
    }
    const after = end.nextSibling;
    const index = rows.length;
    if (index < count) {
      const base = ranged ? node : node.nextSibling!;
      const row = make(next[index], index, count, list.u, base);
      if (keys !== undefined) list.m.set(row.k = keys[index], row);
      rows.push(row);
      if (row.n !== base) {
        // The server row did not match the template: a fresh row takes its place.
        clearBetween(node, end);
        list.put(parent, row, end, false);
      }
      if (row.n !== base || !ranged) {
        (node as ChildNode).remove();
        (end as ChildNode).remove();
      }
    } else {
      clearBetween(node, end);
      (node as ChildNode).remove();
      (end as ChildNode).remove();
    }
    node = after;
  }
  for (let index = rows.length; index < count; index += 1) {
    const row = make(next[index], index, count, list.u);
    if (keys !== undefined) list.m.set(row.k = keys[index], row);
    rows.push(row);
    list.put(parent, row, list.e, false);
  }
  list.r = rows;
}

function clearBetween(start: Node, end: Node): void {
  for (let node = start.nextSibling; node !== null && node !== end;) {
    const next: ChildNode | null = node.nextSibling;
    (node as ChildNode).remove();
    node = next;
  }
}
