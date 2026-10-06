/**
 * Keyed list reconciliation over element-as-boundary rows (owner decision 2a). Generated
 * components supply `make` and `patch`; the live runtime's row kernel can adopt this same
 * class later, replacing its own reconcile for the rows it covers.
 */

import { fail } from "./diagnostics.js";
import { toText, type Value } from "./expression.js";

/** The change bit for item data and any data reached through a controller facade. */
export const NESTED = 1 << 30;
/** A controller facade answers this key with its raw target; it works across bundle copies. */
export const RAW: unique symbol = Symbol.for("@nextwebwg/html-next.raw.v1") as never;

/** The raw object behind a controller facade, or the value itself. */
export const raw = (value: unknown): unknown =>
  value !== null && typeof value === "object" && (value as { [RAW]?: unknown })[RAW] || value;

/**
 * Raw objects written through facades since the last flush: 1 when the object itself was
 * written, 2 when only something reached through it was.
 */
export type DirtyObjects = ReadonlyMap<unknown, 1 | 2>;

export interface KeyedRow {
  /** Memoized key. */
  k: unknown;
  /** Raw item. */
  i: unknown;
  /** Row element. */
  n: Element;
  /** Reconcile epoch mark. */
  x: number;
  /** Old position, valid while `x` holds the current epoch. */
  y: number;
}

type Move = (parent: Node, node: Node, reference: Node) => void;

const move: Move = (parent, node, reference) => {
  const moveBefore = KeyedList.moveBefore
    ? (parent as Node & { moveBefore?: (node: Node, child: Node) => void }).moveBefore
    : undefined;
  if (moveBefore === undefined) parent.insertBefore(node, reference);
  else moveBefore.call(parent, node, reference);
};

const duplicate = (key: unknown): never =>
  fail("HR004", `A keyed list produced duplicate key \`${toText(key as Value)}\`.`);

/** Marks the longest run of retained positions already in DOM order; undefined when all are. */
function stablePositions(previous: Int32Array): Uint8Array | undefined {
  let last = -1;
  let ordered = true;
  for (const position of previous) {
    if (position < 0) continue;
    if (position < last) { ordered = false; break; }
    last = position;
  }
  if (ordered) return undefined;
  const tails: number[] = [];
  const predecessors = new Int32Array(previous.length).fill(-1);
  for (let index = 0; index < previous.length; index += 1) {
    const position = previous[index]!;
    if (position < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (previous[tails[middle]!]! < position) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const stable = new Uint8Array(previous.length);
  for (let cursor = tails.at(-1) ?? -1; cursor >= 0; cursor = predecessors[cursor]!) stable[cursor] = 1;
  return stable;
}

export class KeyedList<R extends KeyedRow> {
  /** Screening knob: insert each run of fresh rows as one fragment (owner Q5) or row by row. */
  static fragment = true;
  /** Screening knob (D1): move retained rows with `moveBefore` where the browser has it. */
  static moveBefore = true;

  /** Rows in DOM order. */
  r: R[] = [];
  /** Rows by key. */
  readonly m = new Map<unknown, R>();
  /** Reconcile epoch. */
  x = 0;
  /** The last list value; starts as the list itself so the first update always reconciles. */
  a: unknown = this;

  constructor(
    readonly s: Comment,
    readonly e: Comment,
    readonly mk: (item: unknown) => R,
    readonly p: (row: R, changed: number) => void,
    readonly key: (item: unknown) => unknown,
    readonly alias: string,
  ) {
    // Lets serialization find the rows this region owns (M3); the cycle is with DOM it owns.
    (s as Comment & { [key: symbol]: unknown })[Symbol.for("@nextwebwg/html-next.region.v1")] = this;
  }

  /** Reconciles when the list value or its array changed (or `changed` is -1); else touches dirty rows. */
  update(items: unknown, dirty: DirtyObjects, changed: number): void {
    if (changed === -1 || items !== this.a || dirty.get(items) === 1 ||
      (changed & NESTED) !== 0 && this.touch(dirty)) {
      this.set(items, dirty, changed === -1);
    }
  }

  /** Patches every row with `changed`: an outer value its bindings read changed. */
  each(changed: number): void {
    for (const row of this.r) this.p(row, changed);
  }

  /** Patches rows whose item was written; true, before writing that row, when a key moved. */
  touch(dirty: DirtyObjects): boolean {
    for (const row of this.r) {
      if (!dirty.has(row.i)) continue;
      if (this.key(row.i) !== row.k) return true;
      this.p(row, NESTED);
    }
    return false;
  }

  /** Reconciles the rows with `items`; `full` re-reads every key and patches every row. */
  set(items: unknown, dirty: DirtyObjects, full: boolean): void {
    this.a = items;
    const list = Array.isArray(items) ? items as readonly unknown[] : [];
    const old = this.r;
    const map = this.m;
    const start = this.s;
    const end = this.e;
    const parent = end.parentNode!;
    const count = list.length;
    const next: unknown[] = [];
    // Rows are placed from both ends, so the array is sized once up front.
    // oxlint-disable-next-line unicorn/no-new-array
    const rows = new Array<R>(count);
    for (let index = 0; index < count; index += 1) {
      const item = raw(list[index]);
      if (item === undefined) fail("HB001", `\`${this.alias}\` is not declared in scope.`);
      next.push(item);
    }
    const changed = dirty.size > 0 ? dirty : undefined;
    const same = (row: R, item: unknown): boolean => row.i === item && changed?.has(item) !== true;

    // 1. Trim common ends and swapped ends without touching the DOM. Trimmed rows keep their key.
    let oldStart = 0;
    let oldEnd = old.length;
    let newStart = 0;
    let newEnd = count;
    const swaps: R[] = [];
    if (!full) for (;;) {
      while (oldStart < oldEnd && newStart < newEnd && same(old[oldStart]!, next[newStart])) rows[newStart++] = old[oldStart++]!;
      while (oldStart < oldEnd && newStart < newEnd && same(old[oldEnd - 1]!, next[newEnd - 1])) rows[--newEnd] = old[--oldEnd]!;
      if (oldEnd - oldStart < 2 || newEnd - newStart < 2 ||
        !same(old[oldStart]!, next[newEnd - 1]) || !same(old[oldEnd - 1]!, next[newStart])) break;
      swaps.push(old[oldStart]!, old[oldEnd - 1]!);
      rows[newStart++] = old[--oldEnd]!;
      rows[--newEnd] = old[oldStart++]!;
    }

    // 2. Key every remaining item before any DOM mutation, so a duplicate (HR004) changes nothing.
    const epoch = ++this.x;
    const length = newEnd - newStart;
    for (let index = oldStart; index < oldEnd; index += 1) {
      const row = old[index]!;
      row.x = epoch;
      row.y = index;
    }
    const keys: unknown[] = [];
    const previous = new Int32Array(length);
    let kept = 0;
    let fresh: Set<unknown> | undefined;
    for (let index = 0; index < length; index += 1) {
      const key = this.key(next[newStart + index]);
      const row = map.get(key);
      keys.push(key);
      if (row === undefined) {
        if ((fresh ??= new Set()).has(key)) duplicate(key);
        fresh.add(key);
        previous[index] = -1;
      } else if (row.x === epoch) {
        row.x = -epoch;
        previous[index] = row.y;
        kept += 1;
      } else duplicate(key);
    }

    // 3a. Swapped ends, in recorded order; an adjacent pair is one move.
    for (let index = 0; index < swaps.length; index += 2) {
      const first = swaps[index]!.n;
      const second = swaps[index + 1]!.n;
      const afterFirst = first.nextSibling!;
      move(parent, first, second.nextSibling!);
      if (afterFirst !== second) move(parent, second, afterFirst);
    }

    // 3b. Remove unclaimed rows in adjacent groups. Foreign nodes and retained rows split groups.
    if (oldEnd - oldStart > kept) {
      const all = kept === 0 && oldStart === 0 && oldEnd === old.length;
      if (all) map.clear();
      let first: R | undefined;
      let last: R | undefined;
      const cut = (): void => {
        if (first === last) first!.n.remove();
        // The whole parent is this region and the group is every node in it.
        else if (first!.n.previousSibling === start && last!.n.nextSibling === end &&
          start.previousSibling === null && end.nextSibling === null) parent.replaceChildren(start, end);
        else {
          const range = parent.ownerDocument!.createRange();
          range.setStartBefore(first!.n);
          range.setEndAfter(last!.n);
          range.deleteContents();
        }
        first = undefined;
      };
      for (let index = oldStart; index < oldEnd; index += 1) {
        const row = old[index]!;
        if (row.x !== epoch) {
          if (first !== undefined) cut();
          continue;
        }
        if (!all) map.delete(row.k);
        if (first !== undefined && last!.n.nextSibling !== row.n) cut();
        first ??= row;
        last = row;
      }
      if (first !== undefined) cut();
    }

    // 3c. Make fresh rows (patched while detached) and patch retained rows whose item changed.
    for (let index = 0; index < length; index += 1) {
      const item = next[newStart + index];
      let row: R;
      if (previous[index]! < 0) {
        row = this.mk(item);
        row.k = keys[index];
        map.set(row.k, row);
      } else {
        row = old[previous[index]!]!;
        if (full || row.i !== item || changed?.has(item) === true) {
          row.i = item;
          this.p(row, -1);
        }
      }
      rows[newStart + index] = row;
    }

    // 3d. Place from the end: fresh runs go in forward, retained rows outside the LIS move.
    const stable = kept > 1 ? stablePositions(previous) : undefined;
    let reference: Node = newEnd < count ? rows[newEnd]!.n : end;
    for (let index = length - 1; index >= 0; index -= 1) {
      if (previous[index]! < 0) {
        let run = index;
        while (run > 0 && previous[run - 1]! < 0) run -= 1;
        if (KeyedList.fragment && run < index) {
          const fragment = parent.ownerDocument!.createDocumentFragment();
          for (let item = run; item <= index; item += 1) fragment.append(rows[newStart + item]!.n);
          parent.insertBefore(fragment, reference);
        } else {
          for (let item = run; item <= index; item += 1) parent.insertBefore(rows[newStart + item]!.n, reference);
        }
        index = run;
        reference = rows[newStart + run]!.n;
        continue;
      }
      const row = rows[newStart + index]!;
      if (stable !== undefined && stable[index] !== 1) move(parent, row.n, reference);
      reference = row.n;
    }
    this.r = rows;
  }
}
