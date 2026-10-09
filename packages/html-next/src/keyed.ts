/**
 * Keyed list reconciliation over element-as-boundary rows (owner decision 2a). Generated
 * components supply `make` and `patch`; the live runtime's row kernel can adopt this same
 * class later, replacing its own reconcile for the rows it covers.
 */

import { fail } from "./diagnostics.js";
import { toText, type Value } from "./expression.js";

/** The change bit for item data and any data reached through a controller facade. */
export const NESTED = 1 << 30;
/**
 * The change bit for a row's position: bindings that read an index or `loop`, here or in rows below.
 * `1 << 31`, written as a literal so bundles without positional lists drop it.
 */
export const POSITION = -0x80000000;
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
  /** Row element, or a ranged row's start marker. */
  n: Element | Comment;
  /** A ranged row's end marker. */
  t?: Comment;
  /** Reconcile epoch mark. */
  x: number;
  /** Old position, valid while `x` holds the current epoch. */
  y: number;
  /**
   * 1 when a binding last converted a list or object: that output depends on contents any nested
   * write may have changed, so the row is patched on every nested write (compare-before-write).
   */
  w?: number;
  /** Position and row count, kept for rows that read their index or `loop`, or hold rows that do. */
  j?: number;
  l?: number;
  /** Stops the row's listeners and nested regions when it is removed. */
  z?: (() => void)[];
}

/** Stops what a removed row or cleared region owned: its listeners and nested regions. */
export function dispose(record: { z?: (() => void)[] } | undefined): void {
  if (record?.z !== undefined) for (const stop of record.z) stop();
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
  /** The record of the block holding the list, which rows and keys reading outer locals reach. */
  u: unknown = undefined;
  /** Leading and trailing rows the last partial reconcile kept at their index (trailing: while the count held). */
  declare f: number;
  declare g: number;

  constructor(
    readonly s: Comment,
    readonly e: Comment,
    readonly mk: (item: unknown, index: number, count: number, owner: unknown) => R,
    readonly p: (row: R, changed: number, dirty: DirtyObjects) => void,
    /** The key of an item at a position; undefined for an unkeyed list, whose rows follow positions. */
    readonly key: ((item: unknown, index: number, count: number, owner: unknown) => unknown) | undefined,
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

  /** Records a patched row's position; only rows that read it keep one (`PositionalList`). */
  place(_row: R, _index: number, _count: number): void {}

  /** Puts a row's nodes before `reference`, moving a retained row (`moving`) where the browser can. */
  put(parent: Node, row: R, reference: Node, moving: boolean): void {
    if (moving) move(parent, row.n, reference);
    else parent.insertBefore(row.n, reference);
  }

  /** Removes a row's nodes. */
  drop(row: R): void {
    row.n.remove();
  }

  /** Patches every row with `changed`: an outer value its bindings read changed. */
  each(changed: number, dirty: DirtyObjects): void {
    for (const row of this.r) this.p(row, changed, dirty);
  }

  /**
   * Patches rows whose item was written, and rows showing a container; true, before writing any
   * row, when a key moved, so a duplicate (HR004) fails with the DOM untouched.
   */
  touch(dirty: DirtyObjects): boolean {
    const rows = this.r;
    if (this.key !== undefined) for (const row of rows) if (dirty.has(row.i) && this.key(row.i, row.j!, row.l!, this.u) !== row.k) return true;
    for (const row of rows) if (row.w === 1 || dirty.has(row.i)) this.p(row, NESTED, dirty);
    return false;
  }

  /** Reconciles the rows with `items`; `full` re-reads every key and patches every row. */
  set(items: unknown, dirty: DirtyObjects, full: boolean): void {
    this.a = items;
    const list = Array.isArray(items) ? items as readonly unknown[] : [];
    const key = this.key!;
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
    // Written objects; a row showing a container is treated as written whenever anything was.
    const changed = dirty.size > 0 ? dirty : undefined;
    const same = (row: R, item: unknown): boolean =>
      row.i === item && (changed === undefined || row.w !== 1 && !changed.has(item));

    // 1. Trim common ends and swapped ends without touching the DOM. Trimmed rows keep their key.
    let oldStart = 0;
    let oldEnd = old.length;
    let newStart = 0;
    let newEnd = count;
    const swaps: R[] = [];
    if (!full) for (;;) {
      while (oldStart < oldEnd && newStart < newEnd && same(old[oldStart]!, next[newStart])) rows[newStart++] = old[oldStart++]!;
      while (oldStart < oldEnd && newStart < newEnd && same(old[oldEnd - 1]!, next[newEnd - 1])) rows[--newEnd] = old[--oldEnd]!;
      if (swaps.length === 0) {
        this.f = newStart;
        this.g = count - newEnd;
      }
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
      const itemKey = key(next[newStart + index], newStart + index, count, this.u);
      const row = map.get(itemKey);
      keys.push(itemKey);
      if (row === undefined) {
        if ((fresh ??= new Set()).has(itemKey)) duplicate(itemKey);
        fresh.add(itemKey);
        previous[index] = -1;
      } else if (row.x === epoch) {
        row.x = -epoch;
        previous[index] = row.y;
        kept += 1;
      } else duplicate(itemKey);
    }

    // 3a. Swapped ends, in recorded order; an adjacent pair is one move.
    for (let index = 0; index < swaps.length; index += 2) {
      const first = swaps[index]!;
      const second = swaps[index + 1]!;
      const afterFirst = (first.t ?? first.n).nextSibling!;
      this.put(parent, first, (second.t ?? second.n).nextSibling!, true);
      if (afterFirst !== second.n) this.put(parent, second, afterFirst, true);
    }

    // 3b. Remove unclaimed rows in adjacent groups. Foreign nodes and retained rows split groups.
    if (oldEnd - oldStart > kept) {
      const all = kept === 0 && oldStart === 0 && oldEnd === old.length;
      if (all) map.clear();
      let first: R | undefined;
      let last: R | undefined;
      const cut = (): void => {
        if (first === last) this.drop(first!);
        // The whole parent is this region and the group is every node in it.
        else if (first!.n.previousSibling === start && (last!.t ?? last!.n).nextSibling === end &&
          start.previousSibling === null && end.nextSibling === null) parent.replaceChildren(start, end);
        else {
          const range = parent.ownerDocument!.createRange();
          range.setStartBefore(first!.n);
          range.setEndAfter((last!.t ?? last!.n));
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
        dispose(row);
        if (first !== undefined && (last!.t ?? last!.n).nextSibling !== row.n) cut();
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
        row = this.mk(item, newStart + index, count, this.u);
        row.k = keys[index];
        map.set(row.k, row);
      } else {
        row = old[previous[index]!]!;
        if (full || !same(row, item)) {
          row.i = item;
          this.place(row, newStart + index, count);
          this.p(row, -1, dirty);
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
        for (let item = run; item <= index; item += 1) this.put(parent, rows[newStart + item]!, reference, false);
        index = run;
        reference = rows[newStart + run]!.n;
        continue;
      }
      const row = rows[newStart + index]!;
      if (stable !== undefined && stable[index] !== 1) this.put(parent, row, reference, true);
      reference = row.n;
    }
    this.r = rows;
  }
}

/**
 * A keyed list whose rows read their position, or hold rows that do. A row that moved, or (when
 * rows read it) saw the count change, re-runs only what reads the position. Rows the reconcile
 * kept at their index are not visited.
 */
export class PositionalList<R extends KeyedRow> extends KeyedList<R> {
  /** Rows (or their key) read the row count, so a changed count patches every row. */
  q = false;

  override place(row: R, index: number, count: number): void {
    row.j = index;
    row.l = count;
  }

  override set(items: unknown, dirty: DirtyObjects, full: boolean): void {
    const before = this.r.length;
    super.set(items, dirty, full);
    const rows = this.r;
    const count = rows.length;
    // A full reconcile placed every retained row already.
    if (full) return;
    const counted = this.q && count !== before;
    const end = count === before ? count - this.g : count;
    for (let index = counted ? 0 : this.f; index < end; index += 1) {
      const row = rows[index]!;
      if (row.j !== index || counted && row.l !== count) {
        row.j = index;
        row.l = count;
        this.p(row, POSITION, dirty);
      }
    }
  }
}

/** An unkeyed list: rows follow positions, and a changed item updates its position's row. */
export class IndexedList<R extends KeyedRow> extends KeyedList<R> {
  /** Rows read the row count, so a changed count patches them too; their index never changes. */
  q = false;

  override set(items: unknown, dirty: DirtyObjects, full: boolean): void {
    this.a = items;
    this.positions(Array.isArray(items) ? items as readonly unknown[] : [], dirty, full);
  }

  /** An unkeyed list: rows follow positions, and a changed item updates its position's row. */
  positions(list: readonly unknown[], dirty: DirtyObjects, full: boolean): void {
    const rows = this.r;
    const count = list.length;
    for (let index = 0; index < Math.min(count, rows.length); index += 1) {
      const row = rows[index]!;
      const item = raw(list[index]);
      if (item === undefined) fail("HB001", `\`${this.alias}\` is not declared in scope.`);
      if (full || row.i !== item || dirty.has(item)) {
        row.i = item;
        row.j = index;
        row.l = count;
        this.p(row, -1, dirty);
      } else if (this.q && row.l !== count) {
        row.l = count;
        this.p(row, POSITION, dirty);
      }
    }
    while (rows.length > count) {
      const row = rows.pop()!;
      this.drop(row);
      dispose(row);
    }
    const parent = this.e.parentNode!;
    for (let index = rows.length; index < count; index += 1) {
      const item = raw(list[index]);
      if (item === undefined) fail("HB001", `\`${this.alias}\` is not declared in scope.`);
      const row = this.mk(item, index, count, this.u);
      rows.push(row);
      this.put(parent, row, this.e, false);
    }
  }

}

/**
 * Rows of several nodes (`<template $each>`) between item markers, as live renders them: the list
 * puts, moves and removes each row's whole range. A fresh row's nodes wait in their fragment.
 */
function putRange(parent: Node, row: KeyedRow, reference: Node, moving: boolean): void {
  const holder = row.n.parentNode;
  if (holder !== null && holder.nodeType === 11) {
    parent.insertBefore(holder, reference);
    return;
  }
  for (let node: Node = row.n, next: Node | null; ; node = next!) {
    next = node.nextSibling;
    if (moving) move(parent, node, reference);
    else parent.insertBefore(node, reference);
    if (node === row.t) break;
  }
}

function dropRange(row: KeyedRow): void {
  const range = row.n.ownerDocument.createRange();
  range.setStartBefore(row.n);
  range.setEndAfter(row.t!);
  range.deleteContents();
}

export class RangedKeyedList<R extends KeyedRow> extends KeyedList<R> {
  override put(parent: Node, row: R, reference: Node, moving: boolean): void { putRange(parent, row, reference, moving); }
  override drop(row: R): void { dropRange(row); }
}

export class RangedPositionalList<R extends KeyedRow> extends PositionalList<R> {
  override put(parent: Node, row: R, reference: Node, moving: boolean): void { putRange(parent, row, reference, moving); }
  override drop(row: R): void { dropRange(row); }
}

export class RangedIndexedList<R extends KeyedRow> extends IndexedList<R> {
  override put(parent: Node, row: R, reference: Node, moving: boolean): void { putRange(parent, row, reference, moving); }
  override drop(row: R): void { dropRange(row); }
}
