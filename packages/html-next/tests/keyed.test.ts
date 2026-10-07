import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { KeyedList, NESTED, RAW, type DirtyObjects, type KeyedRow } from "../src/keyed.js";

interface Item { id: unknown; label: string }
interface Row extends KeyedRow { text: string }

function fixture() {
  const { window } = new JSDOM("<ul></ul>");
  const document = window.document;
  const list = document.querySelector("ul")!;
  const start = document.createComment("html-next:each-start");
  const end = document.createComment("html-next:each-end");
  list.append(start, end);
  const patches: Array<[unknown, number]> = [];
  const patch = (row: Row, changed: number): void => {
    patches.push([(row.i as Item).id, changed]);
    const label = (row.i as Item).label;
    if (label !== row.text) row.n.textContent = row.text = label;
  };
  const make = (item: unknown): Row => {
    const row: Row = { k: undefined, i: item, n: document.createElement("li"), x: 0, y: 0, text: "" };
    patch(row, -1);
    return row;
  };
  const keyed = new KeyedList<Row>(start, end, make, patch, (item) => (item as Item).id, "row");
  const observer = new window.MutationObserver(() => {});
  observer.observe(list, { childList: true, subtree: true, characterData: true });
  const rows = (): Element[] => Array.from(list.children);
  return { document, list, start, end, keyed, patches, observer, rows, window };
}

/** A deterministic shuffle source. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const items = (ids: readonly number[]): Item[] => ids.map((id) => ({ id, label: `row ${id}` }));
const none: DirtyObjects = new Map();

afterEach(() => {
  KeyedList.fragment = true;
  KeyedList.moveBefore = true;
});

describe("KeyedList", () => {
  for (const fragment of [true, false]) {
    it(`matches a brute-force model across list transitions${fragment ? "" : " (row-by-row insertion)"}`, () => {
      KeyedList.fragment = fragment;
      const { keyed, rows } = fixture();
      const pool = new Map<number, Item>();
      const item = (id: number): Item => {
        let known = pool.get(id);
        if (known === undefined) pool.set(id, known = { id, label: `row ${id}` });
        return known;
      };
      let elements = new Map<number, Element>();
      const step = (ids: readonly number[]): void => {
        const value = ids.map(item);
        keyed.update(value, none, 2);
        const children = rows();
        assert.deepEqual(children.map((child) => child.textContent), ids.map((id) => `row ${id}`));
        // Retained keys keep their element; new keys get a new one.
        const next = new Map<number, Element>();
        children.forEach((child, index) => {
          const id = ids[index]!;
          const prior = elements.get(id);
          if (prior !== undefined) assert.equal(child, prior, `row ${id} kept its element`);
          next.set(id, child);
        });
        elements = next;
        assert.equal(keyed.m.size, ids.length);
        assert.equal(keyed.r.length, ids.length);
      };
      const next = random(7);
      step([]);
      step([1, 2, 3, 4, 5]);
      step([0, 1, 2, 3, 4, 5]); // prefix
      step([0, 1, 2, 3, 4, 5, 6]); // suffix
      step([1, 2, 3, 4, 5]); // trim both ends
      step([5, 2, 3, 4, 1]); // swap ends, nested middle kept
      step([5, 3, 2, 4, 1]); // adjacent swap
      step([5, 3, 2, 4, 1]); // reverse
      step([10, 11, 12]); // replace everything
      step([10, 13, 11, 14, 12, 15]); // interleave fresh rows
      step([]);
      step(Array.from({ length: 40 }, (_, index) => index));
      for (let round = 0; round < 60; round += 1) {
        const current = rows().map((child) => Number(child.textContent!.slice(4)));
        const ids = [...current, ...Array.from({ length: Math.floor(next() * 4) }, (_, index) => 100 + round * 4 + index)]
          .filter(() => next() > 0.15);
        for (let index = ids.length - 1; index > 0; index -= 1) {
          if (next() < 0.3) {
            const other = Math.floor(next() * (index + 1));
            [ids[index], ids[other]] = [ids[other]!, ids[index]!];
          }
        }
        step(ids);
      }
      step([]);
    });
  }

  it("moves only the swapped ends and keeps the rest in place", () => {
    const { keyed, observer, list } = fixture();
    const value = items(Array.from({ length: 10 }, (_, index) => index));
    keyed.update(value, none, 2);
    observer.takeRecords();
    const swapped = [...value];
    [swapped[1], swapped[8]] = [swapped[8]!, swapped[1]!];
    keyed.update(swapped, none, 2);
    const records = observer.takeRecords();
    // Each moved row is one removal and one insertion.
    assert.equal(records.filter((record) => record.addedNodes.length > 0).length, 2);
    assert.deepEqual(Array.from(list.children, (child) => child.textContent), swapped.map((item) => item.label));
  });

  it("patches dirty retained rows, and replaces a row whose key moved before writing it", () => {
    const { keyed, patches, rows } = fixture();
    const value = items([1, 2, 3]);
    keyed.update(value, none, 2);
    const [first, second, third] = rows();
    patches.length = 0;
    value[1]!.label = "changed";
    keyed.update(value, new Map([[value[1], 1]]), NESTED);
    assert.deepEqual(patches, [[2, NESTED]]);
    assert.equal(rows()[1], second);
    assert.equal(second!.textContent, "changed");

    patches.length = 0;
    value[2]!.id = 30;
    keyed.update(value, new Map([[value[2], 1]]), NESTED);
    // The moved key never patched the old row; a fresh row replaced it.
    assert.deepEqual(patches, [[30, -1]]);
    assert.deepEqual(rows().slice(0, 2), [first, second]);
    assert.notEqual(rows()[2], third);
    assert.equal(keyed.m.has(3), false);
    assert.equal(keyed.m.size, 3);
  });

  it("checks every written row's key before patching any row", () => {
    const { keyed, observer, patches, rows } = fixture();
    const value = items([1, 2]);
    keyed.update(value, none, 2);
    const before = rows();
    observer.takeRecords();
    patches.length = 0;
    value[0]!.label = "X";
    value[1]!.id = 1;
    assert.throws(() => keyed.update(value, new Map([[value[0], 1], [value[1], 1]]), NESTED), /duplicate key `1`/);
    assert.deepEqual(patches, []);
    assert.equal(observer.takeRecords().length, 0);
    assert.deepEqual(rows(), before);
  });

  it("reconciles an array written in place and sweeps outer changes", () => {
    const { keyed, patches, rows } = fixture();
    const value = items([1, 2]);
    keyed.update(value, none, 2);
    value.push(...items([3]));
    keyed.update(value, new Map([[value, 1]]), NESTED);
    assert.deepEqual(rows().map((row) => row.textContent), ["row 1", "row 2", "row 3"]);
    // A write below the array (2) is not a structure change.
    patches.length = 0;
    keyed.update(value, new Map([[value, 2]]), NESTED);
    assert.deepEqual(patches, []);
    keyed.each(4);
    assert.deepEqual(patches, [[1, 4], [2, 4], [3, 4]]);
  });

  it("re-reads every key and patches every row in full mode", () => {
    const { keyed, patches, rows } = fixture();
    const value = items([1, 2, 3]);
    keyed.update(value, none, 2);
    const before = rows();
    patches.length = 0;
    keyed.update(value, none, -1);
    assert.deepEqual(patches, [[1, -1], [2, -1], [3, -1]]);
    assert.deepEqual(rows(), before);
  });

  it("canonicalizes facades to their raw items and treats a non-list as empty", () => {
    const { keyed, rows } = fixture();
    const value = items([1, 2]);
    keyed.update(value, none, 2);
    const before = rows();
    const facade = new Proxy(value[0]!, { get: (target, key) => key === RAW ? target : Reflect.get(target, key) });
    keyed.update([facade, value[1]], none, 2);
    assert.deepEqual(rows(), before);
    assert.equal(keyed.r[0]!.i, value[0]);
    keyed.update(null, none, 2);
    assert.deepEqual(rows(), []);
  });

  it("keeps foreign nodes and removes rows around them in groups", () => {
    const { keyed, document, list, start } = fixture();
    const value = items([1, 2, 3, 4]);
    keyed.update(value, none, 2);
    const foreign = document.createElement("aside");
    list.insertBefore(foreign, list.children[2]!);
    const leading = document.createTextNode("lead");
    start.after(leading);
    keyed.update([], none, 2);
    assert.deepEqual(Array.from(list.childNodes, (node) => node.nodeName), ["#comment", "#text", "ASIDE", "#comment"]);
    assert.equal(keyed.m.size, 0);
  });

  it("clears a region that owns its parent with one replaceChildren", () => {
    const { keyed, observer, list } = fixture();
    keyed.update(items([1, 2, 3, 4, 5]), none, 2);
    observer.takeRecords();
    keyed.update([], none, 2);
    // replaceChildren lifts the two anchors out, then replaces everything in one record.
    const records = observer.takeRecords();
    assert.equal(records.length, 3);
    assert.equal(records[2]!.removedNodes.length, 5);
    assert.equal(list.childNodes.length, 2);
  });

  it("fails duplicate keys and undefined items before any DOM mutation", () => {
    const { keyed, observer, rows } = fixture();
    const value = items([1, 2, 3]);
    keyed.update(value, none, 2);
    const before = rows();
    observer.takeRecords();
    for (const [bad, code] of [
      [[...value, { id: 4, label: "x" }, { id: 4, label: "y" }], "HR004"],
      [[{ id: 9, label: "x" }, value[0], value[0]], "HR004"],
      [[...value, { id: 2, label: "dup" }], "HR004"],
      [[value[0], undefined], "HB001"],
      // A hole reads as undefined, as in the live runtime.
      [Object.assign([value[0]], { 2: value[1] }), "HB001"],
    ] as const) {
      assert.throws(() => keyed.update(bad, none, 2), (error: unknown) =>
        error instanceof HtmlDiagnosticError && error.diagnostic.code === code);
      assert.equal(observer.takeRecords().length, 0);
      assert.deepEqual(rows(), before);
      assert.equal(keyed.m.size, 3);
    }
    assert.throws(() => keyed.update([value[0], undefined], none, 2), /`row` is not declared in scope\./);
    assert.throws(() => keyed.update([{ id: "a", label: "" }, { id: "a", label: "" }], none, 2), /duplicate key `a`/);
  });

  it("finds rows keyed by NaN after a spurious key change", () => {
    const { keyed, rows } = fixture();
    const value = [{ id: Number.NaN, label: "nan" }];
    keyed.update(value, none, 2);
    const before = rows();
    keyed.update(value, new Map([[value[0], 1]]), NESTED);
    assert.deepEqual(rows(), before);
    assert.equal(keyed.m.size, 1);
  });
});
