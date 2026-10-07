import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { ABSENT, evaluateCompiled, type ExpressionNode, type Scope, type Value } from "../src/expression.js";
import {
  attachGeneratedController,
  buildTemplate,
  clearRegion,
  compactTypeAt,
  conforms,
  manageGeneratedLifecycle,
  readMember,
  writeText,
  type CompactType,
  type GeneratedStateSpec,
} from "../src/generated-runtime.js";
import { NESTED, raw } from "../src/keyed.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

let window: JSDOM["window"];
let document: Document;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  ({ window } = new JSDOM("<!doctype html><body></body>"));
  document = window.document;
  for (const key of ["document", "Event", "CustomEvent", "MutationObserver"] as const) {
    vi.stubGlobal(key, window[key as keyof typeof window]);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generated DOM helpers", () => {
  it("builds prototypes without an HTML sink", () => {
    const node = buildTemplate(["", [], ["p", ["class", "a", "data-x", "<b>"], "text", 0, 1, ["i", []], 2]], document);
    const holder = document.createElement("div");
    holder.append(node);
    assert.equal(holder.innerHTML,
      '<p class="a" data-x="<b>">text<!--html-next:start--><!--html-next:end--><i></i><!--html-next:each-start--><!--html-next:each-end--></p>');
    assert.equal(holder.firstChild!.childNodes[1]!.nodeType, 3);
  });

  it("reads members exactly as the expression interpreter does", () => {
    const target = { id: 1 };
    const facade = new Proxy(target, { get: (raw, key) => key === Symbol.for("@nextwebwg/html-next.raw.v1") ? raw : Reflect.get(raw, key) });
    const values: unknown[] = [null, undefined, 0, "", "abc", [], [1, 2], { length: 3 }, { a: 1 }, { a: undefined }, { a: null },
      { a: { b: 1 } }, { a: [1] }, Object.create({ a: "inherited" }), { a: facade }];
    for (const value of values) {
      for (const key of ["a", "length", "missing"]) {
        const node: ExpressionNode = { kind: "member", object: { kind: "id", name: "x" }, key };
        const scope: Scope = { get: (name) => name === "x" ? value === undefined ? ABSENT : value as Value : undefined };
        const expected = evaluateCompiled(node, scope);
        const actual = readMember(value === undefined ? ABSENT : value, key);
        // Object results compare by their canonical raw identity.
        assert.equal(actual, expected === facade ? target : expected, `${JSON.stringify(value)}.${key}`);
      }
    }
  });

  it("writes $value text through the sole Text child and empties for an empty string", () => {
    const element = document.createElement("td");
    element.append("");
    const text = element.firstChild;
    writeText(element, "one");
    assert.equal(element.firstChild, text);
    assert.equal(element.textContent, "one");
    writeText(element, "");
    assert.equal(element.childNodes.length, 0);
    writeText(element, "two");
    element.append(document.createElement("b"));
    writeText(element, "three");
    assert.equal(element.innerHTML, "three");
  });

  it("clears a region node by node and keeps its anchors", () => {
    const holder = document.createElement("div");
    holder.append(buildTemplate(["", [], "a", 1, "z"], document));
    const start = holder.childNodes[1] as Comment;
    const end = start.nextSibling as Comment;
    end.before("x", document.createElement("i"));
    clearRegion(start, end);
    assert.equal(holder.innerHTML, "a<!--html-next:start--><!--html-next:end-->z");
  });
});

describe("compact declared types", () => {
  it("checks destinations and steps into types like the declared-type system", () => {
    const object: CompactType = ["o", ["id", "n", "tags", ["l", "s"]]];
    const open: CompactType = ["o", ["id", "i"], 1];
    const cases: Array<[CompactType, unknown, boolean]> = [
      [0, undefined, true], ["?", undefined, true], ["?", null, true], ["s", "", true], ["s", 1, false], ["s", null, false],
      ["b", false, true], ["b", 0, false], ["n", Number.NaN, false], ["n", Infinity, false], ["n", -0, true], ["i", 1.5, false],
      ["i", 2, true], ["z", null, true], ["z", 0, false], ["a", undefined, true], ["a", null, false],
      [["l", "s"], [1], true], [["l", "s"], {}, false], [["r", "n"], [], false], [["r", "n"], new Date(), true],
      [object, { id: "x" }, true], [object, null, false], [["u", "n", "z"], null, true], [["u", "n", "z"], undefined, false],
      [["u", "n", "z"], 3, true], [["u", ["l", "s"], "s"], "x", true], [["u", "s", "?"], null, true],
    ];
    for (const [type, value, expected] of cases) assert.equal(conforms(value, type), expected, `${JSON.stringify(type)} ${String(value)}`);
    assert.equal(compactTypeAt(["l", "s"], "0"), "s");
    assert.equal(compactTypeAt(["l", "s"], "007"), "s");
    assert.equal(compactTypeAt(["l", "s"], "-1"), 0);
    assert.equal(compactTypeAt(["l", "s"], "length"), 0);
    assert.equal(compactTypeAt(["l", "s"], Symbol.iterator), 0);
    assert.equal(compactTypeAt(object, "tags"), (object as [string, unknown[]])[1][3]);
    assert.equal(compactTypeAt(object, "__proto__"), "a");
    assert.equal(compactTypeAt(open, "other"), 0);
    assert.deepEqual(compactTypeAt(["u", ["l", "s"], ["l", "n"], "s"], "1"), ["u", "s", "n"]);
    assert.equal(compactTypeAt(["u", ["l", "s"], "s"], "1"), "s");
    assert.equal(compactTypeAt("s", "length"), 0);
  });
});

describe("generated lifecycle coordinator", () => {
  const managed = (element: Element, log: string[], name: string): (() => void) =>
    manageGeneratedLifecycle(element, () => { log.push(`+${name}`); }, () => { log.push(`-${name}`); }, { name });

  it("keeps the handle on the lifecycle record", () => {
    const element = document.createElement("div");
    managed(element, [], "a");
    const record = (element as unknown as Record<symbol, { h?: unknown }>)[Symbol.for("@nextwebwg/html-next.lifecycle.v1")];
    assert.deepEqual(record?.h, { name: "a" });
  });

  it("disconnects a removed root without querying unrelated subtrees", async () => {
    const log: string[] = [];
    const root = document.createElement("div");
    root.setAttribute("data-component", "x-a");
    const list = document.createElement("ul");
    document.body.append(root, list);
    managed(root, log, "a");
    assert.deepEqual(log, ["+a"]);
    const query = vi.spyOn(window.Element.prototype, "querySelectorAll");
    for (let index = 0; index < 50; index += 1) list.append(Object.assign(document.createElement("li"), { innerHTML: "<b>x</b>" }));
    await flush();
    list.replaceChildren();
    await flush();
    assert.equal(query.mock.calls.length, 0);
    const wrapper = document.createElement("section");
    document.body.append(wrapper);
    wrapper.append(root);
    await flush();
    wrapper.remove();
    await flush();
    assert.deepEqual(log, ["+a", "-a"]);
  });

  it("keeps the light-DOM scope for roots inside shadow trees", async () => {
    const log: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    inner.setAttribute("data-component", "x-inner");
    shadow.append(inner);
    managed(inner, log, "inner");
    // A light root moved into a connected shadow tree, then removed there, is out of scope too.
    const moved = document.createElement("div");
    moved.setAttribute("data-component", "x-moved");
    document.body.append(moved);
    managed(moved, log, "moved");
    shadow.append(moved);
    await flush();
    moved.remove();
    document.body.append(document.createElement("p"));
    await flush();
    host.remove();
    await flush();
    assert.deepEqual(log, ["+inner", "+moved"]);
  });

  it("retains no root that moved into a shadow tree and was removed there", async () => {
    const keep = document.createElement("div");
    keep.setAttribute("data-component", "x-keep");
    document.body.append(keep);
    managed(keep, [], "keep");
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const collected = await (async () => {
      const moved = document.createElement("div");
      moved.setAttribute("data-component", "x-moved");
      document.body.append(moved);
      managed(moved, [], "moved");
      await flush();
      shadow.append(moved);
      await flush();
      moved.remove();
      return new WeakRef(moved);
    })();
    document.body.append(document.createElement("p"));
    await flush();
    for (let attempt = 0; attempt < 10 && collected.deref() !== undefined; attempt += 1) {
      await flush();
      gc();
    }
    assert.equal(collected.deref(), undefined);
  });

  it("keeps the fast path after other roots unmount, remount or never connect", async () => {
    const log: string[] = [];
    const root = (name: string): Element => {
      const element = document.createElement("div");
      element.setAttribute("data-component", `x-${name}`);
      return element;
    };
    const a = root("a");
    const b = root("b");
    document.body.append(a, b);
    managed(a, log, "a");
    managed(b, log, "b");
    managed(root("pending"), log, "pending");
    b.remove();
    await flush();
    document.body.append(b);
    await flush();
    b.remove();
    await flush();
    const list = document.createElement("ul");
    a.append(list);
    await flush();
    const query = vi.spyOn(window.Element.prototype, "querySelectorAll");
    for (let index = 0; index < 50; index += 1) list.append(Object.assign(document.createElement("li"), { innerHTML: "<b>x</b>" }));
    await flush();
    list.replaceChildren();
    await flush();
    assert.equal(query.mock.calls.length, 0);
    // A parked root still connects and disconnects exactly as the walk would.
    const wrapper = document.createElement("section");
    wrapper.append(b);
    document.body.append(wrapper);
    await flush();
    wrapper.remove();
    await flush();
    assert.deepEqual(log, ["+a", "+b", "-b", "+b", "-b", "+b", "-b"]);
  });

  it("connects roots added in one batch in mutation order", async () => {
    const log: string[] = [];
    const roots = ["a", "b", "c"].map((name) => {
      const element = document.createElement("div");
      element.setAttribute("data-component", `x-${name}`);
      managed(element, log, name);
      return element;
    });
    const holder = document.createElement("div");
    holder.append(roots[2]!, roots[0]!);
    document.body.append(roots[1]!, holder);
    await flush();
    assert.deepEqual(log, ["+b", "+c", "+a"]);
    roots[1]!.remove();
    holder.remove();
    await flush();
    assert.deepEqual(log, ["+b", "+c", "+a", "-b", "-c", "-a"]);
  });
});

describe("generated controller host", () => {
  const spec = (names: readonly string[], types: readonly CompactType[]): GeneratedStateSpec => ({ n: names, t: types, f: "x.html" });

  it("validates, stores raw values, and renders once per flush after controller effects are ordered", async () => {
    const root = document.createElement("div");
    const values: unknown[] = [[], null];
    const log: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let host: any;
    attachGeneratedController(root, spec(["rows", "selected"], [["l", ["o", ["id", "n", "label", "s"]]], ["u", "n", "z"]]), values,
      (changed, dirty) => { log.push(`render ${changed} ${dirty.size}`); },
      { default: (value: unknown) => { host = value; } });
    assert.deepEqual(log, ["render -1 0"]);
    document.body.append(root);
    await flush();
    assert.ok(Object.isFrozen(host));
    assert.deepEqual(Object.keys(host), ["root", "element", "state", "data", "on", "props", "refs", "slots", "signal", "computed", "effect", "dispatch"]);
    host.effect(() => { log.push(`effect ${host.state.rows.length}`); });
    const row = { id: 1, label: "a" };
    host.state.rows = [row];
    host.state.selected = "nope";
    host.state.missing = 1;
    host.state.missing = 2;
    await flush();
    assert.deepEqual(log, ["render -1 0", "effect 0", "render 1 0", "effect 1"]);
    assert.deepEqual(warn.mock.calls.map(([message]) => message), [
      "x.html: HR007: State `selected` does not satisfy its declared type.",
      "x.html: HR007: Destination `missing` is read-only.",
    ]);
    const facade = host.state.rows[0];
    assert.equal(host.state.rows[0], facade);
    assert.ok(Array.isArray(host.state.rows));
    facade.label = 2;
    assert.equal(warn.mock.calls.at(-1)![0], "x.html: HR007: State `rows.0.label` does not satisfy its declared type.");
    facade.label = "b";
    await flush();
    assert.equal(row.label, "b");
    assert.equal(log.at(-1), `render ${NESTED} 2`);
    // Raw storage: the root holds the raw array; concat copied item facades, which readers canonicalize.
    host.state.rows = host.state.rows.concat([{ id: 2, label: "c" }]);
    await flush();
    assert.equal(raw(values[0]), values[0]);
    assert.equal(raw((values[0] as unknown[])[0]), row);
    warn.mockRestore();
  });

  it("terminates writes through cyclic data and parent back-pointers", async () => {
    const root = document.createElement("div");
    const sizes: number[] = [];
    let host: any;
    attachGeneratedController(root, spec(["items"], [["l", "?"]]), [[]], (_changed, dirty) => { sizes.push(dirty.size); },
      { default: (value: unknown) => { host = value; } });
    document.body.append(root);
    await flush();
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    host.state.items = [{ meta: node }];
    host.state.items[0].meta.self.name = "b";
    const parent: Record<string, unknown> = { children: [] };
    const child = { parent };
    (parent.children as unknown[]).push(child);
    host.state.items = [child];
    host.state.items[0].parent.children[0].parent.name = "p";
    await flush();
    assert.equal(node.name, "b");
    assert.equal(parent.name, "p");
    // The written object and every object on the path that last reached it: child, its children array, parent.
    assert.ok(sizes.at(-1)! >= 3);
  });

  it("records no written objects while disconnected; a reconnect renders everything", async () => {
    const root = document.createElement("div");
    const renders: Array<[number, number]> = [];
    let host: any;
    attachGeneratedController(root, spec(["rows"], [["l", ["o", ["id", "n", "label", "s"]]]]), [[]],
      (changed, dirty) => { renders.push([changed, dirty.size]); },
      // The controller's cleanup writes while the root is still connected, just before it disconnects.
      { default: (value: unknown) => { host = value; return () => { host.state.rows[0].label = "z"; }; } });
    document.body.append(root);
    await flush();
    host.state.rows = [{ id: 0, label: "a" }];
    await flush();
    root.remove();
    await flush();
    for (let index = 0; index < 50; index += 1) {
      host.state.rows = [{ id: index, label: "a" }];
      host.state.rows[0].label = "b";
    }
    await flush();
    document.body.append(root);
    await flush();
    assert.deepEqual(renders, [[-1, 0], [1, 0], [-1, 0]]);
  });

  it("follows the live lifecycle: controller once, connect callbacks on every connect, cleanup once", async () => {
    const root = document.createElement("div");
    const log: string[] = [];
    let resolve!: (value: () => void) => void;
    attachGeneratedController(root, spec(["on"], ["b"]), [false], (changed) => { log.push(`render ${changed}`); }, {
      default: (host: any) => {
        log.push("controller");
        host.on("connect", () => { log.push("connect"); host.state.on = !host.state.on; return () => log.push("connect cleanup"); });
        host.on("disconnect", () => { log.push("disconnect"); });
        return new Promise<() => void>((done) => { resolve = done; });
      },
    });
    document.body.append(root);
    await flush();
    root.remove();
    await flush();
    resolve(() => log.push("controller cleanup"));
    await flush();
    document.body.append(root);
    await flush();
    root.remove();
    await flush();
    assert.deepEqual(log, [
      "render -1", "controller", "connect", "render 1",
      "connect cleanup", "disconnect", "controller cleanup",
      "connect", "render -1",
      "connect cleanup", "disconnect",
    ]);
  });

  it("answers data, props, refs and slots like the live host for a component without them", () => {
    const root = document.createElement("div");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let host: any;
    attachGeneratedController(root, spec(["a"], ["s"]), ["x"], () => {}, { default: (value: unknown) => { host = value; } });
    document.body.append(root);
    return flush().then(() => {
      host.data.x = 1;
      assert.equal(host.data.x, undefined);
      assert.equal("x" in host.data, false);
      assert.equal(Object.getPrototypeOf(host.props), null);
      assert.equal(host.refs.anything, undefined);
      assert.deepEqual(host.slots.default, []);
      assert.notEqual(host.slots.default, host.slots.default);
      assert.equal("a" in host.state, true);
      assert.equal(delete host.state.a, true);
      assert.deepEqual(warn.mock.calls.map(([message]) => message), [
        "x.html: HR007: Destination `data.x` is read-only.",
        "x.html: HR007: Destination `a` is read-only.",
      ]);
      const events: unknown[] = [];
      root.addEventListener("ping", (event) => events.push((event as CustomEvent).detail));
      assert.equal(host.dispatch("ping", 3), true);
      assert.deepEqual(events, [3]);
    });
  });
});
