import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { build, transform } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";

import { compileExpression, evaluateCompiled, type Value } from "../src/expression.js";
import { generateComponent } from "../src/generate.js";
import { compactTypeAt, conforms, type CompactType } from "../src/generated-runtime.js";
import { parseComponent } from "../src/source-parser.js";
import { visitSelected } from "../src/selection.js";
import { blockPlan, compactType, lowerExpression } from "../src/targets/vanilla-blocks.js";
import { normalizeType, parseTypedValue, parseTypeExpression, typeAtKey, type TypeNode } from "../src/type-system.js";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const fixtures = new URL("./fixtures/direct-extend/", import.meta.url);

function vanilla(text: string, directExtend: boolean): string {
  const definition = parseComponent(text, new URL("component.html", fixtures).href);
  const named = definition.controller === undefined ? definition : { ...definition, controller: "./controller.js" };
  return generateComponent(named, { directExtend }).find((artifact) => artifact.path.endsWith(".js"))!.content;
}

const component = (defs: string, body: string, controller = true): string =>
  `<template component="x-shape" ${controller ? 'controller="./controller.js" ' : ""}status="early" summary="Shape.">
    <defs>${defs}</defs>${body}</template>`;

const benchmarkShape = component(`
  <state name="ready" type="boolean" value="false"></state>
  <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
  <state name="selected" type="number" nullable></state>`, `
  <div id="main"><div class="container" $if="ready"><table><tbody>
    <tr $each="row of rows" $key="row.id" from:data-id="row.id" class:danger="row.id = selected">
      <td $value="row.id"></td><td><a data-action="select" $value="row.label"></a></td>
    </tr>
  </tbody></table></div></div>`);

async function bundle(module: string, external = false): Promise<{ text: string; inputs: string[] }> {
  const result = await build({
    stdin: { contents: module, loader: "js", resolveDir: fileURLToPath(fixtures) },
    bundle: true, format: "esm", write: false, metafile: true, platform: "browser", target: ["es2022"],
    alias: {
      "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts`,
      "@nextwebwg/html-next/runtime": `${source}runtime.ts`,
    },
    external: external ? ["./controller.js"] : [],
    plugins: [{ name: "styles", setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
    } }],
  });
  // Modules that contribute output bytes; parsed but fully shaken modules do not count.
  const output = Object.values(result.metafile!.outputs)[0]!.inputs;
  return { text: result.outputFiles[0]!.text, inputs: Object.keys(output).filter((path) => output[path]!.bytesInOutput > 0) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("direct-extend Vanilla generation", () => {
  it("compiles the benchmark shape without the general runtime, parser or type system", async () => {
    const module = vanilla(benchmarkShape, true);
    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime|const definition|manageComponentLifecycle/);
    assert.match(module, /^import \{ attachGeneratedController, buildTemplate, clearRegion, KeyedList, readMember, toAttribute, toText, trackContainer, visitSelected, writeAttribute, writeText \} from "@nextwebwg\/html-next\/generated-runtime";$/m);
    await transform(module, { loader: "js", format: "esm" });
    const { inputs } = await bundle(module, true);
    const forbidden = /(?:^|\/)src\/(?:runtime|parser|source-parser|expression-parser|type-system|format)\.ts$/;
    assert.deepEqual(inputs.filter((path) => forbidden.test(path)), []);
  });

  it("keeps the indexed lifecycle coordinator out of every other generated bundle", async () => {
    const index = /(?:^|\/)src\/generated-lifecycle-index\.ts$/;
    const props = await readFile(new URL("../benchmarks/fixtures/prop-button.html", import.meta.url), "utf8");
    const older = await bundle(vanilla(props, true));
    assert.ok(older.inputs.some((path) => path.endsWith("src/generated-lifecycle.ts")));
    assert.equal(older.inputs.some((path) => index.test(path)), false);
    assert.ok((await bundle(vanilla(benchmarkShape, true), true)).inputs.some((path) => index.test(path)));
  });

  it("keeps the flag-off output byte-identical", () => {
    assert.equal(vanilla(benchmarkShape, false), generateComponent(parseComponent(benchmarkShape, new URL("component.html", fixtures).href))
      .find((artifact) => artifact.path.endsWith(".js"))!.content.replace(/import \* as controller from "[^"]*";/, 'import * as controller from "./controller.js";'));
    assert.match(vanilla(benchmarkShape, false), /manageComponentLifecycle/);
  });

  const state = '<state name="ready" type="boolean" value="false"></state><state name="rows" type="list(object({ id: number, label: string, user: object({ name: string }) }))" value="[]"></state>';
  const notYetDirect: Record<string, string> = {
    "no controller": component(state, '<p $value="ready"></p>', false),
    props: component(`${state}<prop name="size" type="number" default="1">Size.</prop>`, '<p $value="ready"></p>'),
    computed: component(`${state}<computed name="count" from="rows.length"></computed>`, '<p $value="count"></p>'),
    handler: component(`${state}<handler name="go"><set name="ready" expr:value="true"></set></handler>`, '<button on:click="go">Go</button>'),
    event: component(`${state}<event name="saved" type="number"></event>`, '<p $value="ready"></p>'),
    "untyped state": component('<state name="x" value="1"></state>', '<p $value="x"></p>'),
    "unknown state": component('<state name="x" type="unknown" value="1"></state>', '<p $value="x"></p>'),
    "format type": component('<state name="x" type="url" value="https://a.example/"></state>', '<p $value="x"></p>'),
    "nonconforming initial": component('<state name="x" type="number" value="abc"></state>', '<p $value="x"></p>'),
    "root match": component(state, '<template $match><a $when="ready">A</a><b $else>B</b></template>'),
    "host state": component(state, '<p $value="ready"></p><style>:host-state([ready]) { color: red; }</style>'),
    slot: component(state, "<p><slot></slot></p>"),
    "custom element": component(state, "<p><x-other></x-other></p>"),
    "is attribute": component(state, '<p><span is="x-span"></span></p>'),
    ref: component(state, '<p><span $ref="label"></span></p>'),
    event_listener: component(state, '<p><span on:click="go"></span></p>'),
    "select region": component(state, '<p><select><option $if="ready">A</option></select></p>'),
    "two-way binding": component('<state name="name" type="string" value="a"></state>', '<p><input bind:value="name"></p>'),
    html: component(state, '<p $html="rows.length"></p>'),
    with: component(state, '<p><span $with="rows as list" $value="list.length"></span></p>'),
    "unkeyed each": component(state, '<ul><li $each="row of rows" $value="row.label"></li></ul>'),
    "each index": component(state, '<ul><li $each="row, i of rows" $key="row.id" $value="i"></li></ul>'),
    "each where": component(state, '<ul><li $each="row of rows" $key="row.id" $where="row.id" $value="row.label"></li></ul>'),
    "each sort": component(state, '<ul><li $each="row of rows" $key="row.id" $sort="id" $value="row.label"></li></ul>'),
    "each limit": component(state, '<ul><li $each="row of rows" $key="row.id" $limit="2" $value="row.label"></li></ul>'),
    "nested flow in a row": component(state, '<ul><li $each="row of rows" $key="row.id"><b $if="ready">x</b></li></ul>'),
    "loop record": component(state, '<ul><li $each="row of rows" $key="row.id" $value="loop.index"></li></ul>'),
    "loop shadows a root": component(`${state}<state name="loop" type="number" value="1"></state>`, '<ul><li $each="row of rows" $key="row.id" $value="loop"></li></ul>'),
    "key reads state": component(state, '<ul><li $each="row of rows" $key="ready" $value="row.label"></li></ul>'),
    "member test": component(state, '<p><b $if="rows.length">x</b></p>'),
    "container test": component(state, '<p><b $if="rows">x</b></p>'),
  };
  for (const [name, text] of Object.entries(notYetDirect)) {
    it(`keeps today's module for a feature not on the direct path yet: ${name}`, () => {
      let off: string;
      try {
        off = vanilla(text, false);
      } catch {
        return; // The authoring itself is rejected before generation; nothing to compare.
      }
      assert.equal(vanilla(text, true), off);
    });
  }

  it("plans the supported shapes it should", () => {
    const plan = (text: string) => blockPlan(parseComponent(text, new URL("component.html", fixtures).href));
    assert.notEqual(plan(benchmarkShape), undefined);
    assert.notEqual(plan(component(state, '<p from:data-n="rows.length" class:on="ready and not ready"><b>{ready}</b></p>')), undefined);
    for (const text of Object.values(notYetDirect)) {
      let parsed;
      try { parsed = parseComponent(text, new URL("component.html", fixtures).href); } catch { continue; }
      assert.equal(blockPlan(parsed), undefined, text);
    }
  });
});

describe("direct-extend expression lowering (differential)", async () => {
  const pool: Value[] = [null, true, false, 0, 1, -0, 2.5, Number.NaN, "", "x", "length", "10px", "5%", "3ms", [], [1, "a"],
    [[1], []], {}, { k: 1 }, { k: null }, { k: [2] }, { length: 2 }, { k: { k: "deep" } }];
  const expressions = [
    "1", "'x'", "true", "null", "a", "row", "row.k", "row.length", "a.k", "a.length", "a.k.k", "a = b", "a != row.k",
    "row.k = a", "a = null", "a and b", "a or row", "not a", "not row.k", "a ? b : row.k", "a and b ? row : 'none'",
    "(a = b) or (row.k and not a)", "a ? (b ? 1 : 2) : row.k.k", "row.k.k",
    "a + 1", "a - b", "a * 2", "a / b", "a % 2", "a < b", "a <= 1", "a > row.k", "a >= b", "-a", "-row.k", "not -a",
    "a ^= 'x'", "a $= b", "a *= 'x'", "a[0]", "a['k']", "row[b]", "a[b]", "a[0].k", "row.k[0]",
    "default(a, 1)", "default(row.k, b)", "default(a.k, row)", "concat(a, 'x')", "concat(a, b)", "concat(a)", "join(a, ',')",
    "join(row, b)", "abs(a)", "round(a, 2)", "round(a)", "min(a, b, 1)", "max(a)", "clamp(0, a, 10)",
    "{ x: a, y: row.k }", "[a, b]", "[a, [row.k]]", "default(a + b, 0)", "a + b = 3",
    "concat(a, b) ? 1 : 2", "not concat(a)", "concat(a) and b", "a or concat(b)", "a + 1 > b",
  ];
  const roots: { name: string; type: CompactType }[] = [{ name: "a", type: "?" }, { name: "b", type: "?" }];
  const helpers = await import("../src/generated-runtime.js");
  const same = (left: unknown, right: unknown): boolean =>
    left !== null && typeof left === "object" ? JSON.stringify(left) === JSON.stringify(right) : Object.is(left, right);
  for (const text of expressions) {
    it(`matches the interpreter for ${text}`, () => {
      const ast = compileExpression(text).ast;
      const lowered = lowerExpression(ast, roots, "row");
      assert.notEqual(lowered, undefined, text);
      // oxlint-disable-next-line typescript/no-implied-eval
      const run = new Function("v", "o", "r", "h", `with (h) { return ${lowered}; }`) as
        (v: unknown[], o: unknown, r: object, h: typeof helpers) => unknown;
      for (const a of pool) for (const b of pool.slice(0, 12)) for (const row of pool) {
        const scope = { get: (name: string) => name === "a" ? a : name === "b" ? b : name === "row" ? row : undefined };
        const expected = evaluateCompiled(ast, scope);
        const actual = run([a, b], row, {}, helpers);
        if (!same(actual, expected)) assert.fail(`${text} with a=${inspect(a)} b=${inspect(b)} row=${inspect(row)}: ${inspect(actual)} vs ${inspect(expected)}`);
      }
    });
  }
});

describe("compact declared types (matrix)", () => {
  // The live runtime's destination check (runtime.ts conformsAtReference/conformsAtDestination).
  const atReference = (value: unknown, type: TypeNode): boolean => {
    if (value === null) return true;
    switch (type.kind) {
      case "list": return Array.isArray(value);
      case "record":
      case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
      case "union": return type.members.some((member) => atReference(value, member));
      case "constrained": return atReference(value, type.base);
      default: return parseTypedValue(value, type, "$", "value").ok;
    }
  };
  const atDestination = (value: unknown, type: TypeNode | undefined): boolean => {
    if (type === undefined) return true;
    if (value === null) return parseTypedValue(value, type, "$", "value").ok;
    return atReference(value, normalizeType(type));
  };
  const number: TypeNode = { kind: "terminal", name: "number" };
  const types: TypeNode[] = [
    ...["string", "boolean", "number", "integer", "unknown", "object", "list(string)", "list(list(integer))",
      "object({ id: number, name?: string })", "object({ id: integer, ... })", "list(object({ id: number, tags: list(string) }))"]
      .map(parseTypeExpression),
    { kind: "union", members: [number, { kind: "terminal", name: "null" }] },
    { kind: "union", members: [parseTypeExpression("list(string)"), parseTypeExpression("list(number)"), parseTypeExpression("string")] },
    { kind: "union", members: [parseTypeExpression("object({ a: string })"), parseTypeExpression("object({ b: number, ... })")] },
    { kind: "constrained", base: number, values: [1, 2], min: 0 },
    { kind: "record", value: { kind: "union", members: [number, { kind: "terminal", name: "absent" }] } },
  ];
  // Controllers cannot produce the interpreter's ABSENT, so it is not in the matrix.
  const values: unknown[] = [null, undefined, true, 0, -0, Number.NaN, Infinity, 1.5, 2, "", "x", [], [1], ["a"], {}, { a: 1 },
    { id: 1 }, new Date(0), () => 1];
  const keys: PropertyKey[] = ["0", "007", "-1", "1.5", "", "length", "id", "name", "a", "b", "missing", "__proto__", "constructor", Symbol.iterator];
  for (const node of types) {
    it(`agrees with the declared-type system for ${JSON.stringify(node).slice(0, 80)}`, () => {
      const type = compactType(node)!;
      assert.notEqual(type, undefined);
      for (const value of values) {
        assert.equal(conforms(value, type), atDestination(value, node), `conforms(${String(value)})`);
        for (const key of keys) {
          const step = typeAtKey(node, key as string);
          const compact = compactTypeAt(type, key);
          assert.equal(conforms(value, compact), atDestination(value, step), `${String(key)}: ${String(value)}`);
        }
      }
    });
  }

  it("leaves kinds it does not check yet on the fallback", () => {
    for (const text of ["url", "email", "color", "keyword", "keyword+", "event", "list(url)"]) {
      assert.equal(compactType(parseTypeExpression(text)), undefined, text);
    }
    assert.equal(compactType({ kind: "keyword", value: "a" }), undefined);
    assert.equal(compactType({ kind: "constrained", base: { kind: "terminal", name: "unknown" } }), undefined);
  });
});

describe("direct-extend parity with the general runtime (jsdom)", () => {
  interface Run {
    readonly snapshots: string[];
    readonly identities: string[];
    readonly warnings: string[];
    readonly errors: string[];
    readonly events: string[];
  }
  type Step = (host: any) => void;

  /** Builds `text` on one path, runs `steps` with a render and a snapshot after each, and reconnects. */
  async function run(text: string, directExtend: boolean, steps: readonly Step[]): Promise<Run> {
    const { text: code } = await bundle(vanilla(text, directExtend));
    const { window } = new JSDOM("<!doctype html><body></body>");
    for (const key of Object.getOwnPropertyNames(window)) {
      if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
      try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
    }
    const log = { hosts: [] as any[], events: [] as string[] };
    vi.stubGlobal("directExtendLog", log);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message: string) => { warnings.push(message.replace(/^.*?: HR007/, "HR007")); });
    // Render failures surface from the scheduler's microtask; both paths report them here.
    const errors: string[] = [];
    const queue = globalThis.queueMicrotask;
    vi.stubGlobal("queueMicrotask", (callback: () => void) => queue(() => {
      try { callback(); } catch (error) { errors.push((error as Error).message); }
    }));
    const module = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${directExtend}`).toString("base64")}`);
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const factory = Object.values(module).find((value) => typeof value === "function") as () => Element;
    const element = factory();
    const snapshots: string[] = [];
    const identities: string[] = [];
    let previous = new Map<string, Element>();
    const record = (): void => {
      snapshots.push(element.outerHTML.replaceAll(/<!--html-next:item-(?:start|end)-->/g, ""));
      const rows = new Map(Array.from(element.querySelectorAll("[data-id]"), (row) => [row.getAttribute("data-id")!, row]));
      identities.push([...rows].map(([id, row]) => `${id}:${previous.get(id) === row ? "same" : "new"}`).join(","));
      previous = rows;
    };
    window.document.body.append(element);
    await flush();
    record();
    const host = log.hosts[0];
    for (const step of steps) {
      step(host);
      await flush();
      record();
    }
    element.remove();
    await flush();
    host.state.rows = [{ id: 7, label: "back", tags: [] }];
    await flush();
    window.document.body.append(element);
    await flush();
    record();
    return { snapshots, identities, warnings, errors, events: log.events };
  }

  async function same(text: string, steps: readonly Step[]): Promise<Run> {
    const live = await run(text, false, steps);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const compiled = await run(text, true, steps);
    for (let index = 0; index < live.snapshots.length; index += 1) {
      assert.equal(compiled.snapshots[index], live.snapshots[index], `snapshot ${index}`);
      assert.equal(compiled.identities[index], live.identities[index], `identity ${index}`);
    }
    assert.deepEqual(compiled.warnings, live.warnings);
    assert.deepEqual(compiled.errors, live.errors);
    assert.deepEqual(compiled.events, live.events);
    return compiled;
  }

  it("renders, keeps row identity, warns and orders lifecycle callbacks like the general runtime", async () => {
    await same(await readFile(new URL("parity.html", fixtures), "utf8"), [
      (host) => { host.state.rows = [1, 2, 3, 4, 5].map((id) => ({ id, label: `r${id}`, tags: [] })); },
      (host) => { host.state.selected = 2; },
      (host) => { const rows = host.state.rows; const second = rows[1]; rows[1] = rows[3]; rows[3] = second; },
      (host) => { host.state.rows[0].label = ""; host.state.rows[2].label += "!"; },
      (host) => { host.state.rows[0].tags.push("a", "b"); },
      (host) => { host.state.rows = host.state.rows.filter((row: { id: number }) => row.id !== 3); },
      (host) => { host.state.rows = host.state.rows.concat([{ id: 9, label: "n", tags: ["t"] }]); },
      (host) => { host.state.rows[1].id = 20; },
      (host) => { host.state.rows = host.state.rows.toReversed(); },
      (host) => { host.state.rows = host.state.rows.slice(); },
      (host) => { host.state.rows[0].id = "bad"; host.state.selected = "bad"; host.state.title = 3; host.state.nope = 1; delete host.state.title; },
      (host) => { host.state.title = ""; host.state.selected = null; },
      (host) => { host.state.rows.length = 1; },
      (host) => { host.state.ready = false; },
      (host) => { host.state.ready = true; },
      (host) => { host.state.rows = []; },
    ]);
  });

  it("selects only affected keyed rows while preserving live/compiled DOM parity", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>`, `
      <section><p>rows</p><ul $if="ready">
        <li $each="row of rows" $key="row.id" from:data-id="row.id" class:on="row.id = selected"
          class:off="selected != row.id"><b $value="row.label"></b></li>
      </ul></section>`);
    const reads = new Set<number>();
    await same(text, [
      (host) => { host.state.rows = [1, 2, 3].map((id) => ({ get id() { reads.add(id); return id; }, label: `r${id}` })); },
      (host) => { host.state.selected = 1; },
      (host) => { reads.clear(); host.state.selected = 3; },
      () => { assert.deepEqual([...reads].sort(), [1, 3]); },
      (host) => { host.state.selected = 2; host.state.rows = [{ id: 2, label: "new" }, { id: 4, label: "four" }]; },
      (host) => { host.state.rows[0].id = 5; host.state.selected = 5; },
      (host) => { host.state.rows = host.state.rows.filter((row: { id: number }) => row.id !== 5); host.state.selected = 4; },
      (host) => { host.state.selected = null; },
      (host) => { host.state.ready = false; host.state.selected = 4; },
      (host) => { host.state.ready = true; },
      (host) => { host.state.rows = []; },
    ]);
  });

  it("keeps explicit loop-index comparisons reactive when retained rows move", async () => {
    const text = component(`
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>`, `
      <section><p>rows</p><ul><li $each="row, i of rows" $key="row.id"
        from:data-id="row.id" class:on="row.id = i"><b $value="i"></b></li></ul></section>`);
    const result = await same(text, [
      (host) => { host.state.rows = [{ id: 0, label: "zero" }, { id: 1, label: "one" }]; },
      (host) => { host.state.rows = host.state.rows.toReversed(); },
    ]);
    assert.equal(result.snapshots[1]!.match(/class="on"/g)?.length, 2);
    assert.doesNotMatch(result.snapshots[2]!, /class="on"/);
    assert.equal(result.identities[2], "1:same,0:same");
  });

  it("keeps independent selectors and ordinary root reads correct in one batched update", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="other" type="number" nullable></state>`, `
      <section><p>rows</p><div $if="ready">
        <ul><li $each="row of rows" $key="row.id" from:data-id="row.id"
          class:on="row.id = selected" class:other="row.id = other"><b $value="row.label"></b></li></ul>
        <ol><li $each="row of rows" $key="row.id" class:off="selected != row.id"
          from:title="selected" class:label="row.label = selected"><b $value="row.label"></b></li></ol>
      </div></section>`);
    await same(text, [
      (host) => { host.state.rows = [{ id: -0, label: "zero" }, { id: 1, label: "one" }, { id: null, label: "null" }]; },
      (host) => { host.state.selected = 0; host.state.other = 1; },
      (host) => { host.state.selected = -0; },
      (host) => { host.state.selected = 1; host.state.other = null; },
      (host) => { host.state.rows[1].id = 2; host.state.selected = 2; host.state.other = 0; },
      (host) => { host.state.selected = null; host.state.other = 2; },
      (host) => { host.state.rows = []; host.state.selected = 4; },
    ]);
  });

  it("re-renders container conversions written through any path, not only through the row's item", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string, tags: list(string) }))" value="[]"></state>
      <state name="current" type="list(string)" value="[]"></state>`, `
      <section><p $value="current"></p><ul $if="ready">
        <li $each="row of rows" $key="row.id" from:data-id="row.id" from:title="row.tags">
          <i $value="row.tags"></i><b $value="row.tags ? 'y' : 'n'"></b><em $value="row.label"></em><s class:full="row.tags"></s>
        </li>
      </ul></section>`);
    await same(text, [
      (host) => { const shared = ["t"]; host.state.rows = [{ id: 1, label: "a", tags: shared }, { id: 2, label: "b", tags: shared }]; },
      (host) => { host.state.rows[0].tags.push("u"); },
      (host) => { host.state.current = host.state.rows[1].tags; host.state.current.push("v"); },
      (host) => { host.state.current.length = 0; },
      // Declared item fields are checked only where written, so a row may still hold a list in `label`.
      (host) => { const label = ["x"]; host.state.rows = [{ id: 3, label, tags: [] }, { id: 4, label, tags: [] }]; },
      (host) => { host.state.rows[0].label.push("y"); },
      (host) => { host.state.rows[1].tags = ["z"]; host.state.rows[1].tags.push("w"); },
      (host) => { host.state.rows[1].label = "plain"; host.state.rows[0].label.push("q"); },
    ]);
  });

  it("evaluates arithmetic, calls, index reads and declared references like the general runtime", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string, tags: list(string), user: object({ name: string }) }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="user" type="object({ name: string, age: number })" value="{ name: 'Ada', age: 36 }"></state>`, `
      <section from:data-next="selected + 1" from:title="concat(user.name, '/', user.age)">
        <p $value="default(selected, 'none')"></p>
        <output $value="user.age * 2"></output><span $value="rows[0].label"></span><s $value="user.name"></s>
        <ul $if="ready"><li $each="row of rows" $key="row.id" from:data-id="row.id" class:even="row.id % 2 = 0">
          <b $value="row.user.name"></b><i $value="abs(row.id - 3)"></i><em $value="join(row.tags, '+')"></em>
        </li></ul></section>`);
    let kept = { name: "Raw", age: 1 };
    await same(text, [
      (host) => { host.state.rows = [1, 2, 3].map((id) => ({ id, label: `r${id}`, tags: ["a", String(id)], user: { name: `u${id}` } })); },
      (host) => { host.state.selected = 2; host.state.user.age = 40; },
      (host) => { host.state.rows[0].user.name = "renamed"; host.state.rows[1].tags.push("x"); },
      (host) => { kept = { name: "Raw", age: 1 }; host.state.user = kept; },
      // A controller that kept the raw object can still corrupt it; the read-time reference check catches it.
      (host) => { (kept as { name: unknown }).name = 5; host.state.user.age = 2; },
      (host) => { host.state.selected = null; host.state.rows = host.state.rows.toReversed(); },
    ]);
  });

  it("binds styles, URLs, properties, mixed text, SVG and class overwrites like the general runtime", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="title" type="string" value="Rows"></state>
      <state name="link" type="string" value="https://a.example/"></state>`, `
      <section style:--count="rows.length" from:data-n="rows.length">
        <p>Rows: {rows.length} of {title}!</p>
        <a from:href="link">Link</a><img from:src="link" alt=""><input .value="title">
        <div from:class="title" class:on="ready" class:pick="selected = 2"></div>
        <svg viewBox="0 0 10 10"><circle from:r="rows.length" from:viewbox="title"></circle>
          <foreignObject><b $value="title"></b></foreignObject></svg>
        <ul $if="ready"><li $each="row of rows" $key="row.id" from:data-id="row.id"><i>{row.label}: {row.id}</i></li></ul>
      </section>`);
    const note = (host: any): void => {
      const input = host.root.querySelector("input") as HTMLInputElement;
      const circle = host.root.querySelector("circle") as Element;
      (globalThis as any).directExtendLog.events.push(`value=${input.value} svg=${circle.namespaceURI} ${[...circle.attributes].map((a) => a.name).join(",")} ${host.root.querySelector("b").namespaceURI}`);
    };
    await same(text, [
      (host) => { host.state.rows = [1, 2].map((id) => ({ id, label: `r${id}` })); note(host); },
      (host) => { host.state.link = " javascript:alert(1)"; host.state.title = "Next"; note(host); },
      // A user edit survives a nested write the property binding does not read.
      (host) => { host.root.querySelector("input").value = "typed"; host.state.rows[0].label = "z"; note(host); },
      (host) => { host.state.selected = 2; host.state.link = "https://b.example/"; note(host); },
      // The class attribute overwrites the toggles, which return only when their own inputs change.
      (host) => { host.state.title = "fresh"; note(host); },
      (host) => { host.state.selected = 1; note(host); },
      (host) => { host.state.ready = false; host.state.ready = true; host.state.selected = 2; note(host); },
    ]);
  });

  it("fails a moved duplicate key before writing any row", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>`, `
      <section><p>rows</p><ul $if="ready"><li $each="row of rows" $key="row.id" from:data-id="row.id"><b $value="row.label"></b></li></ul></section>`);
    const compiled = await same(text, [
      (host) => { host.state.rows = [{ id: 1, label: "a" }, { id: 2, label: "b" }]; },
      (host) => { host.state.rows[0].label = "X"; host.state.rows[1].id = 1; },
    ]);
    assert.deepEqual(compiled.errors, ["HR004: A keyed list produced duplicate key `1`."]);
  });

  it("creates attributes and class tokens on one element in authored order", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>`, `
      <section><p from:title="ready" from:data-x="rows.length" from:lang="ready" class:a="ready" class:b="rows.length" class:c="ready">rows</p>
        <ul $if="ready"><li $each="row of rows" $key="row.id" class:x="ready" from:data-id="row.id" class:y="row.label" from:title="ready"></li></ul></section>`);
    await same(text, [
      (host) => { host.state.rows = [{ id: 1, label: "a" }]; },
      (host) => { host.state.ready = false; },
      (host) => { host.state.ready = true; host.state.rows = [{ id: 2, label: "" }, { id: 1, label: "a" }]; },
    ]);
  });
});

describe("indexed selection lookup", () => {
  it("visits affected entries once with SameValueZero lookup and forwards the update mask", () => {
    const a = {}, b = {}, nan = {};
    const index = new Map<unknown, object>([[0, a], [1, b], [Number.NaN, nan]]);
    const cases: Array<[unknown, unknown, object[]]> = [
      [0, 1, [a, b]], [1, null, [b]], [null, 1, [b]], [null, undefined, []],
      [0, 0, []], [-0, 0, []], [Number.NaN, Number.NaN, [nan]], [Number.NaN, 0, [nan, a]],
    ];
    for (const [before, after, expected] of cases) {
      const visited: object[] = [];
      visitSelected(index, before, after, (row, mask) => { assert.equal(mask, 4); visited.push(row); }, 4);
      assert.deepEqual(visited, expected);
    }
  });
});
