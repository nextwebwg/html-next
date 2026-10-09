import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { build, transform } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";

import { compileExpression, evaluateCompiled, type Value } from "../src/expression.js";
import { generateComponent, type Invoked } from "../src/generate.js";
import { compactTypeAt, conforms, type CompactType } from "../src/generated-runtime.js";
import { parseComponent } from "../src/source-parser.js";
import { visitSelected } from "../src/selection.js";
import { liveReference } from "./live-reference.js";
import { compactSource, compactType, lowerExpression } from "../src/targets/vanilla-blocks.js";
import { normalizeType, parseTypedValue, parseTypeExpression, typeAtKey, type TypeNode } from "../src/type-system.js";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const fixtures = new URL("./fixtures/direct-extend/", import.meta.url);

function vanilla(text: string, invocations?: ReadonlyMap<string, Invoked>): string {
  const definition = parseComponent(text, new URL("component.html", fixtures).href);
  const named = definition.controller === undefined ? definition : { ...definition, controller: `./${definition.controller.split("/").at(-1)}` };
  return generateComponent(named, invocations === undefined ? {} : { invocations }).find((artifact) => artifact.path.endsWith(".js"))!.content;
}

/** A graph of components (the first one invokes the rest), each compiled with the others as invocations. */
function graph(texts: readonly string[]): { readonly entry: string; readonly modules: ReadonlyMap<string, string> } {
  const definitions = texts.map((text) => parseComponent(text, new URL("component.html", fixtures).href));
  const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
  const modules = new Map(texts.map((text, index) => [`./${definitions[index]!.contract.name}.js`, vanilla(text, invocations)]));
  return { entry: modules.get(`./${definitions[0]!.contract.name}.js`)!, modules };
}

/** The live reference for a component (and the components it invokes); see `live-reference.ts`. */
function reference(text: string, invoked: readonly string[] = []): string {
  const definition = parseComponent(text, new URL("component.html", fixtures).href);
  const named = definition.controller === undefined ? definition : { ...definition, controller: `./${definition.controller.split("/").at(-1)}` };
  return liveReference(named, invoked.map((other) => {
    const parsed = parseComponent(other, new URL("component.html", fixtures).href);
    return parsed.controller === undefined ? parsed : { ...parsed, controller: `./${parsed.controller.split("/").at(-1)}` };
  }));
}

const component = (defs: string, body: string, controller = true): string =>
  `<template component="x-shape" ${controller ? 'controller="./controller.js" ' : ""}status="early" summary="Shape.">
    <defs>${defs}</defs>${body}</template>`;

const benchmarkShape = component(`
  <state name="ready" type="boolean" value="false"></state>
  <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
  <state name="selected" type="number" nullable></state>`, `
  <div id="main"><div class="container" $if="$ready"><table><tbody>
    <tr $each="row of $rows" $key="$row.id" from:data-id="$row.id" class:danger="$row.id = $selected">
      <td $value="$row.id"></td><td><a data-action="select" $value="$row.label"></a></td>
    </tr>
  </tbody></table></div></div>`);

async function bundle(module: string, external = false, modules: ReadonlyMap<string, string> = new Map()): Promise<{ text: string; inputs: string[] }> {
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
      // A graph's other components, generated beside the entry.
      builder.onResolve({ filter: /^\.\/[A-Z]\w*\.js$/ }, (args) => modules.has(args.path) ? { path: args.path, namespace: "generated" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "generated" }, (args) => ({ contents: modules.get(args.path)!, loader: "js", resolveDir: fileURLToPath(fixtures) }));
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
    const module = vanilla(benchmarkShape);
    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime|const definition|manageComponentLifecycle/);
    assert.match(module, /^import \{ attachGeneratedController, buildTemplate, clearRegion, KeyedList, readMember, toAttribute, toText, trackContainer, visitSelected, writeAttribute, writeText \} from "@nextwebwg\/html-next\/generated-runtime";$/m);
    await transform(module, { loader: "js", format: "esm" });
    const { inputs } = await bundle(module, true);
    const forbidden = /(?:^|\/)src\/(?:runtime|parser|source-parser|expression-parser|type-system|format)\.ts$/;
    assert.deepEqual(inputs.filter((path) => forbidden.test(path)), []);
  });

  it("compiles every component without the general runtime", () => {
    // What the parser accepts compiles; anything it rejects never reaches the generator.
    for (const text of [benchmarkShape, component('<state name="x" type="number" value="1"></state>', '<p $value="$x"></p>')]) {
      assert.doesNotMatch(vanilla(text), /@nextwebwg\/html-next\/runtime/);
    }
    assert.throws(() => vanilla(component('<state name="x" type="number" value="abc"></state>', '<p $value="$x"></p>')), /HC013/);
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

  it("checks formats, keywords, functions, events and constrained nullable types as the type system does", async () => {
    const helpers = await import("../src/generated-runtime.js");
    const materialize = (node: TypeNode): CompactType =>
      // oxlint-disable-next-line typescript/no-implied-eval
      new Function("h", `with (h) { return ${compactSource(compactType(node))}; }`)(helpers) as CompactType;
    const samples: unknown[] = [null, undefined, "", "x", "abc-1", "https://a.example/", "a@b.example", "2024-02-29", "2023-02-29",
      "2024-W53", "2020-W53", "12:30", "2024-01-01T10:00", "2024-01-01T10:00Z", "#fff", "#ffff", "rebeccapurple", "rgb(1 2 3)",
      "10px", "0", "5%", "3ms", "solid", 1, true, () => 1, new Event("x"), {}, []];
    const types = ["keyword", "url", "email", "date", "month", "week", "time", "datetime-local", "datetime", "color", "color-hex",
      "length", "percentage", "duration", "event", "list(email)", "object({ site: url, at?: date })"].map(parseTypeExpression);
    types.push({ kind: "terminal", name: "function" }, { kind: "union", members: [parseTypeExpression("url"), { kind: "terminal", name: "null" }] });
    types.push({ kind: "keyword", value: "solid" }, { kind: "union", members: [{ kind: "keyword", value: "solid" }, { kind: "keyword", value: "outline" }] });
    types.push({ kind: "constrained", base: { kind: "union", members: [{ kind: "terminal", name: "number" }, { kind: "terminal", name: "null" }] }, values: [1, 2] });
    for (const node of types) {
      const type = materialize(node);
      for (const value of samples) {
        assert.equal(conforms(value, type), atDestination(value, node), `${JSON.stringify(node)} ${String(value)}`);
      }
    }
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
  /** The network a run's declared reads use, when a test supplies one. */
  let fetchStub: ((url: string, init?: RequestInit) => Promise<unknown>) | undefined;

  /** A step drives the controller's host, or the root and its framework prop channel. */
  type Step = (host: any, update: (props: Record<string, unknown>) => void) => void;

  /** The rendered DOM with each element's attributes sorted: their order is not a contract. */
  const canonical = (element: Element): string => {
    const copy = element.cloneNode(true) as Element;
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
      const attributes = Array.from(node.attributes, (attribute) => [attribute.name, attribute.value] as const)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      for (const [name] of attributes) node.removeAttribute(name);
      for (const [name, value] of attributes) node.setAttribute(name, value);
    }
    return copy.outerHTML;
  };

  /** Builds `text` on one path, runs `steps` with a render and a snapshot after each, and reconnects. */
  /** Factory options, or a function making them in the run's document (for projected nodes). */
  type Options = Record<string, unknown> | ((document: Document) => Record<string, unknown>);

  async function run(text: string | readonly string[], directExtend: boolean, steps: readonly Step[], options?: Options): Promise<Run> {
    // Each run starts from the real globals, so its window's are the only ones stubbed in.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const [root, ...invoked] = typeof text === "string" ? [text] : text;
    const compiled = directExtend ? graph([root!, ...invoked]) : undefined;
    const { text: code } = await bundle(compiled !== undefined
      ? `${compiled.entry}\nexport { updateGeneratedProps as update } from "@nextwebwg/html-next/generated-runtime";`
      : reference(root!, invoked), false, compiled?.modules);
    const { window } = new JSDOM("<!doctype html><body></body>");
    for (const key of Object.getOwnPropertyNames(window)) {
      if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
      try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
    }
    const log = { hosts: [] as any[], events: [] as string[] };
    vi.stubGlobal("directExtendLog", log);
    if (fetchStub !== undefined) vi.stubGlobal("fetch", fetchStub);
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
    const factory = Object.entries(module).find(([name]) => name.startsWith("create"))![1] as (options?: Record<string, unknown>) => Element;
    const update = (props: Record<string, unknown>): void => (module.update as (element: Element, props: Record<string, unknown>) => void)(current(), props);
    const element = factory(typeof options === "function" ? options(window.document) : options);
    const snapshots: string[] = [];
    const identities: string[] = [];
    let previous = new Map<string, Element>();
    // The root as it is now in the document: a root switch or lowering replaces the element first returned.
    const current = (): Element => window.document.body.firstElementChild ?? element;
    const record = (): void => {
      snapshots.push(canonical(current()).replaceAll(/<!--html-next:item-(?:start|end)-->/g, ""));
      const rows = new Map(Array.from(current().querySelectorAll("[data-id]"), (row) => [row.getAttribute("data-id")!, row]));
      identities.push([...rows].map(([id, row]) => `${id}:${previous.get(id) === row ? "same" : "new"}`).join(","));
      previous = rows;
    };
    window.document.body.append(element);
    await flush();
    record();
    // A component without a controller is driven through its DOM.
    const host = log.hosts[0] ?? { get root() { return current(); } };
    for (const step of steps) {
      step(host, update);
      await flush();
      record();
    }
    const detached = current();
    detached.remove();
    await flush();
    if (host.state !== undefined && "rows" in host.state) host.state.rows = [{ id: 7, label: "back", tags: [] }];
    await flush();
    window.document.body.append(detached);
    await flush();
    record();
    return { snapshots, identities, warnings, errors, events: log.events };
  }

  async function same(text: string | readonly string[], steps: readonly Step[], options?: Options): Promise<Run> {
    // The compared modules must be direct ones: a fallback would compare the general runtime with itself.
    for (const module of graph(typeof text === "string" ? [text] : text).modules.values()) {
      assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/, "compiles directly");
    }
    const live = await run(text, false, steps, options);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const compiled = await run(text, true, steps, options);
    if (process.env.DBG !== undefined) (await import("node:fs")).writeFileSync(process.env.DBG, JSON.stringify({ live: live.errors, compiled: compiled.errors, lw: live.warnings, cw: compiled.warnings }, null, 1));
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
      <section><p>rows</p><ul $if="$ready">
        <li $each="row of $rows" $key="$row.id" from:data-id="$row.id" class:on="$row.id = $selected"
          class:off="$selected != $row.id"><b $value="$row.label"></b></li>
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
      <section><p>rows</p><ul><li $each="row, i of $rows" $key="$row.id"
        from:data-id="$row.id" class:on="$row.id = $i"><b $value="$i"></b></li></ul></section>`);
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
      <section><p>rows</p><div $if="$ready">
        <ul><li $each="row of $rows" $key="$row.id" from:data-id="$row.id"
          class:on="$row.id = $selected" class:other="$row.id = $other"><b $value="$row.label"></b></li></ul>
        <ol><li $each="row of $rows" $key="$row.id" class:off="$selected != $row.id"
          from:title="$selected" class:label="$row.label = $selected"><b $value="$row.label"></b></li></ol>
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
      <section><p $value="$current"></p><ul $if="$ready">
        <li $each="row of $rows" $key="$row.id" from:data-id="$row.id" from:title="$row.tags">
          <i $value="$row.tags"></i><b $value="$row.tags ? 'y' : 'n'"></b><em $value="$row.label"></em><s class:full="$row.tags"></s>
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
      <section from:data-next="$selected + 1" from:title="concat($user.name, '/', $user.age)">
        <p $value="default($selected, 'none')"></p>
        <output $value="$user.age * 2"></output><span $value="$rows[0].label"></span><s $value="$user.name"></s>
        <ul $if="$ready"><li $each="row of $rows" $key="$row.id" from:data-id="$row.id" class:even="$row.id % 2 = 0">
          <b $value="$row.user.name"></b><i $value="abs($row.id - 3)"></i><em $value="join($row.tags, '+')"></em>
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
      <section style:--count="$rows.length" from:data-n="$rows.length">
        <p>Rows: {$rows.length} of {$title}!</p>
        <a from:href="$link">Link</a><img from:src="$link" alt=""><input .value="$title">
        <div from:class="$title" class:on="$ready" class:pick="$selected = 2"></div>
        <svg viewBox="0 0 10 10"><circle from:r="$rows.length" from:viewbox="$title"></circle>
          <foreignObject><b $value="$title"></b></foreignObject></svg>
        <ul $if="$ready"><li $each="row of $rows" $key="$row.id" from:data-id="$row.id"><i>{$row.label}: {$row.id}</i></li></ul>
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

  it("runs handlers, computeds, initializers, refs and declared events like the general runtime", async () => {
    const text = component(`
      <state name="count" type="number" value="0"></state>
      <state name="items" type="list(number)" value="[]"></state>
      <state name="label" type="string" value="start"></state>
      <state name="seed" type="number" expr:value="$count + 10"></state>
      <computed name="double" from="$count * 2"></computed>
      <computed name="total" type="number" from="$seed + $double"></computed>
      <event name="changed" type="number" bubbles="false"></event>
      <handler name="increment"><set name="count" expr:value="$count + 1" $if="$count < 3"></set><set name="items" expr:value="[$count, $double]"></set>
        <dispatch event="changed" expr:value="$count"></dispatch><focus target="out"></focus></handler>
      <handler name="bad"><set name="count" expr:value="'x'"></set><set name="label" expr:value="$$event.type"></set></handler>`, `
      <section><button id="go" on:click.prevent="increment">Next</button><button id="bad" on:click.once="bad">Bad</button>
        <output $ref="out" tabindex="-1" $value="$double"></output><p>{$total} {$label} {$seed} {$items}</p></section>`, false);
    const log = (root: Element, note: string): void => {
      (globalThis as any).directExtendLog.events.push(`${note} focus=${(root.ownerDocument.activeElement as Element | null)?.localName}`);
    };
    const click = (root: Element, id: string): boolean => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      root.querySelector(`#${id}`)!.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await same(text, [
      ({ root }) => {
        root.addEventListener("changed", (event: Event) => {
          (globalThis as any).directExtendLog.events.push(`changed ${(event as CustomEvent).detail} bubbles=${event.bubbles}`);
        });
        log(root, `prevented=${click(root, "go")}`);
      },
      ({ root }) => { click(root, "go"); click(root, "go"); click(root, "go"); log(root, "four"); },
      ({ root }) => { click(root, "bad"); click(root, "bad"); log(root, "bad"); },
    ]);
  });

  it("renders every flow like the general runtime: tests, $with, $match, unkeyed, shaped and nested lists", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string, tags: list(string) }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="title" type="string" value="Rows"></state>
      <state name="limit" type="number" value="3"></state>
      <state name="prefix" type="string" value="k"></state>
      <handler name="pick"><set name="title" expr:value="concat($$event.type, ':', $$event.target.textContent)"></set></handler>`, `
      <section><p>{$title}</p>
        <b $if="$rows.length">some</b><i $if="$rows">truthy</i><s $if="$rows[0].tags">tagged</s>
        <span $with="$rows[0] as first"><em $value="$first.label"></em> <u $value="$first.tags.length"></u></span>
        <template $match="$selected as chosen"><b $when="$chosen = 1">one</b><i $when="$chosen > 1">many {$chosen}</i><u $else>none</u></template>
        <ol><li $each="row, i of $rows" from:data-id="$row.id" class:first="$loop.first" class:last="$loop.last">{$i}/{$loop.count} {$row.label}
          <button $ref="picks" on:click.stop="pick">{$row.label}</button><em $if="$row.tags.length > 0 and $ready">{$row.tags}</em>
          <ul><li $each="tag of $row.tags" $key="$tag">{$tag}</li></ul></li></ol>
        <menu><li $each="row of $rows" $key="concat($prefix, $row.id)" $where="$row.label" $sort="-row.label,row.id" $limit="$limit" from:data-key="$row.id">{$row.label}</li></menu>
      </section>`);
    const note = (host: any, label: string): void => {
      (globalThis as any).directExtendLog.events.push(`${label} refs=${(host.refs.picks ?? []).map((button: Element) => button.textContent).join("|")}`);
    };
    await same(text, [
      (host) => { host.state.rows = [1, 2, 3, 4].map((id) => ({ id, label: `r${id}`, tags: id % 2 === 0 ? ["t"] : [] })); note(host, "rows"); },
      (host) => { host.state.selected = 1; host.root.querySelector("ol button").click(); note(host, "click"); },
      (host) => { host.state.rows[0].tags.push("x"); host.state.selected = 3; },
      (host) => { host.state.rows = host.state.rows.toReversed(); note(host, "reversed"); },
      (host) => { host.state.rows[1].label = ""; host.state.limit = 2; host.state.prefix = "p"; },
      (host) => { host.state.rows.splice(1, 1); host.state.rows[0].label = "z"; note(host, "spliced"); },
      (host) => { host.state.rows[0].tags.length = 0; host.state.ready = false; },
      (host) => { host.state.rows = []; host.state.selected = null; note(host, "empty"); },
    ]);
  });

  it("keeps a region's body while its decision holds, with its inputs, focus and nodes, like the general runtime", async () => {
    const text = component(`
      <state name="count" type="number" value="1"></state>
      <state name="user" type="object({ name: string })" value='{ "name": "Ada" }'></state>`, `
      <section>
        <div $if="$count > 0"><input data-id="if"><span>{$count}</span></div>
        <div $with="$user as u"><input data-id="with"><span>{$u.name}</span></div>
        <template $match="$count as n"><p $when="$n < 5"><input data-id="small">{$n}</p><p $else><input data-id="large">{$n}</p></template>
      </section>`);
    const field = (host: any, id: string): HTMLInputElement | null => host.root.querySelector(`[data-id="${id}"]`);
    const run = await same(text, [
      (host) => {
        for (const id of ["if", "with", "small"]) field(host, id)!.value = `typed ${id}`;
        field(host, "if")!.focus();
        field(host, "if")!.setSelectionRange(1, 3);
        host.state.count = 2;
      },
      (host) => {
        for (const id of ["if", "with", "small"]) assert.equal(field(host, id)!.value, `typed ${id}`);
        assert.equal(host.root.ownerDocument.activeElement, field(host, "if"));
        assert.deepEqual([field(host, "if")!.selectionStart, field(host, "if")!.selectionEnd], [1, 3]);
        host.state.user = { name: "Grace" };
      },
      (host) => {
        assert.equal(field(host, "with")!.value, "typed with");
        assert.match(host.root.textContent, /Grace/);
        // The `$if` flips; the `$match` keeps its arm.
        host.state.count = 0;
      },
      (host) => {
        assert.equal(field(host, "if"), null);
        assert.equal(field(host, "small")!.value, "typed small");
        // The `$if` flips back; the `$match` switches arm.
        host.state.count = 7;
      },
      (host) => {
        assert.equal(field(host, "if")!.value, "");
        host.state.user.name = "Lin";
      },
    ]);
    assert.deepEqual(run.identities, [
      "if:new,with:new,small:new", "if:same,with:same,small:same", "if:same,with:same,small:same",
      "with:same,small:same", "if:new,with:same,large:new", "if:same,with:same,large:same", "if:same,with:same,large:same",
    ]);
    assert.match(run.snapshots.at(-2)!, /Lin/);
    // A `$match` that chose no arm stays empty while other state changes.
    await same(component(`<state name="count" type="number" value="0"></state><state name="label" type="string" value="a"></state>`, `
      <section><p>{$label}</p><template $match="$count as n"><b $when="$n = 1">one</b><i $when="$n = 2">two {$n}</i></template></section>`), [
      (host) => { host.state.label = "b"; },
      (host) => { host.state.count = 2; },
      (host) => { host.state.count = 3; host.state.label = "c"; },
      (host) => { host.state.label = "d"; },
    ]);
  });

  it("stops at an unchanged value: no write, effect, request or rebuild follows it, like the general runtime", async () => {
    const requests: string[] = [];
    fetchStub = async (url) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => ({ n: url.split("=").at(-1) }), text: async () => "" };
    };
    const text = `<template component="x-shape" controller="./changes-controller.js" status="early" summary="Shape.">
      <defs><state name="a" type="number" value="1"></state><state name="b" type="number" value="2"></state>
        <state name="label" type="string" value="x"></state>
        <state name="items" type="list(object({ name: string }))" value='[{ "name": "a" }, { "name": "b" }]'></state>
        <computed name="sum" from="$a + $b"></computed>
        <data name="feed" src="https://example.test/feed" type="object({ n: string })"><param name="n" from:value="$a + $b"></param><param name="note" expr:value="$label"></param></data></defs>
      <section from:title="$a + $b" class:wide="$a + $b > 2" style:--n="$a + $b"><p>{$a + $b}</p><b $value="$sum"></b>
        <i $html="concat('&lt;em&gt;', $a + $b, '&lt;/em&gt;')"></i><template $html="concat('&lt;u&gt;', $sum, '&lt;/u&gt;')"></template>
        <span>{$items.0.name}</span><div $with="$sum as s"><input data-id="with">{$s}</div></section></template>`;
    const log = (): string[] => (globalThis as any).directExtendLog.events;
    // Each run counts its own requests from its first step on.
    let base = 0;
    const requested = (): void => { log().push(`requests ${requests.length - base}`); };
    let observer: MutationObserver | undefined;
    try {
      const run = await same(text, [
        (host) => {
          // From here on, every DOM write the bindings make is an event (sorted: the modes order one flush differently).
          const watch: MutationObserver = new (host.root.ownerDocument.defaultView.MutationObserver)((records: MutationRecord[]) => {
            log().push(...records.map((record) =>
              `write ${record.type} ${record.attributeName ?? ""} ${(record.target as Element).localName ?? record.target.parentNode?.nodeName}`).sort());
          });
          watch.observe(host.root, { subtree: true, attributes: true, characterData: true, childList: true });
          observer = watch;
          base = requests.length - 1;
          requested();
          // The same sum: no binding writes, no effect runs, no request goes out.
          host.state.a = 2;
          host.state.b = 1;
        },
        (host) => {
          requested();
          // An equal write notifies nothing.
          host.state.label = "x";
          host.state.items[0].name = "a";
        },
        (host) => {
          // Writes inside the list change only the paths written, so `items.0.name` readers stay.
          host.state.items.push({ name: "c" });
          host.state.items[1].name = "z";
        },
        (host) => {
          host.state.items[0].name = "q";
          requested();
          // An `expr` parameter is sampled when a request goes out; changing it requests nothing.
          host.state.label = "y";
        },
        () => { requested(); },
        (host) => {
          host.state.a = 5;
        },
        () => { requested(); observer?.disconnect(); },
      ]);
      assert.deepEqual(run.events, [
        "effect first a", "effect sum 3", "effect label x",
        // A swap that keeps the sum, an equal write, and writes inside the list: nothing ran, wrote or requested.
        "requests 1", "requests 1",
        "requests 1", "effect first q", "effect label y", "write characterData  SPAN", "requests 1",
        // A new sum reaches its readers once: no class write (still wide), and the `$with` body kept its input.
        "effect sum 6", "write attributes style section", "write attributes title section", "write characterData  B",
        "write characterData  DIV", "write characterData  P", "write childList  i", "write childList  section", "write childList  section",
        "requests 2",
        // Reconnecting runs each effect once.
        "effect first q", "effect sum 6", "effect label y",
      ]);
    } finally {
      fetchStub = undefined;
      observer?.disconnect();
    }
  });

  it("binds form controls both ways, sanitizes $html and inlines template carriers like the general runtime", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string, done: boolean }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="name" type="string" value="Ada"></state>
      <state name="age" type="number" value="36"></state>
      <state name="agree" type="boolean" value="true"></state>
      <state name="size" type="string" value="m"></state>
      <state name="colors" type="list(string)" value="['red']"></state>
      <state name="markup" type="string" value="&lt;b&gt;bold&lt;/b&gt;"></state>`, `
      <section><p>{$name} {$age} {$agree} {$size} {$colors}</p>
        <input id="name" bind:value="name"><input id="age" type="text" bind:value="age"><input id="agree" type="checkbox" bind:checked="agree">
        <input id="small" type="radio" name="size" value="s" from:checked="$size = 's'"><textarea id="bio" bind:value="name"></textarea>
        <select id="size" bind:value="size"><option $each="row of $rows" $key="$row.id" from:value="$row.label">{$row.label}</option><option value="m">M</option></select>
        <select id="colors" multiple bind:value="colors"><option value="red">Red</option><option value="blue">Blue</option></select>
        <div id="html" $html="$markup"></div><template $html="$markup"></template><template $value="$name"></template><template><i>inline</i> {$age}</template>
        <input id="first" type="checkbox" bind:checked="rows[0].done"><ul><li $each="row of $rows" $key="$row.id" from:data-id="$row.id"><b>{$row.done}</b></li></ul>
      </section>`);
    const control = (root: Element, id: string): any => root.querySelector(`#${id}`);
    const note = (host: any, label: string): void => {
      const root = host.root as Element;
      const values = ["name", "age", "bio", "size"].map((id) => control(root, id).value);
      const selected = Array.from(control(root, "colors").selectedOptions as HTMLOptionElement[], (option) => option.value);
      const state = JSON.stringify([host.state.name, host.state.age, host.state.agree, host.state.size, host.state.colors, host.state.rows]);
      (globalThis as any).directExtendLog.events.push(`${label} ${values.join("|")} ${control(root, "agree").checked} ${selected} ${state}`);
    };
    const type = (element: any, value: string, event = "input"): void => {
      element.value = value;
      element.dispatchEvent(new Event(event, { bubbles: true }));
    };
    await same(text, [
      (host) => { host.state.rows = [1, 2].map((id) => ({ id, label: `l${id}`, done: false })); host.state.size = "l2"; note(host, "rows"); },
      (host) => { type(control(host.root, "name"), "Bea"); type(control(host.root, "age"), "41"); note(host, "typed"); },
      (host) => { control(host.root, "agree").click(); control(host.root, "first").click(); note(host, "clicked"); },
      (host) => { type(control(host.root, "size"), "m", "change"); control(host.root, "colors").options[1].selected = true; control(host.root, "colors").dispatchEvent(new Event("change", { bubbles: true })); note(host, "selected"); },
      (host) => { host.state.markup = "<i onclick=\"x()\">i</i><script>bad()</script>"; host.state.rows = host.state.rows.concat([{ id: 3, label: "l3", done: true }]); host.state.size = "l3"; note(host, "markup"); },
      (host) => { type(control(host.root, "bio"), "Cy"); host.state.colors = ["blue", "red"]; note(host, "bio"); },
    ]);
  });

  it("writes through $each, $with, and $match aliases of state like the general runtime", async () => {
    const text = component(`
      <state name="rows" type="list(object({ id: number, label: string, done: boolean }))" value="[]"></state>
      <state name="draft" type="object({ owner: object({ name: string }), plan: string })" value="{ owner: { name: 'Ada' }, plan: 'free' }"></state>`, `
      <section><p>{$draft.owner.name} {$draft.plan}</p>
        <div $with="$draft.owner as owner"><input id="owner" bind:value="owner.name"></div>
        <template $match="$draft as d"><select id="plan" $when="$d.plan" bind:value="d.plan"><option value="free">Free</option><option value="pro">Pro</option></select><i $else></i></template>
        <ul><li $each="row of $rows" $key="$row.id"><input class="label" bind:value="row.label"><input class="done" type="checkbox" bind:checked="row.done"></li></ul>
        <ol><li $each="row, i of $rows" $key="$row.id"><b $each="n of [1]"><input class="nested" bind:value="row.label"></b></li></ol>
      </section>`);
    const all = (host: any, selector: string): any[] => Array.from((host.root as Element).querySelectorAll(selector));
    const type = (element: any, value: string, event = "input"): void => {
      element.value = value;
      element.dispatchEvent(new Event(event, { bubbles: true }));
    };
    const note = (host: any, label: string): void => {
      (globalThis as any).directExtendLog.events.push(`${label} ${JSON.stringify([host.state.draft, host.state.rows])}`);
    };
    const result = await same(text, [
      (host) => { host.state.rows = [1, 2].map((id) => ({ id, label: `l${id}`, done: false })); note(host, "rows"); },
      (host) => { type(all(host, "#owner")[0], "Bea"); type(all(host, "#plan")[0], "pro", "change"); note(host, "with/match"); },
      (host) => { type(all(host, ".label")[1], "second"); all(host, ".done")[0].click(); note(host, "each"); },
      (host) => { type(all(host, ".nested")[0], "nested"); note(host, "nested"); },
    ]);
    assert.deepEqual(result.events.filter((event: string) => /^(with\/match|each|nested) /.test(event)), [
      `with/match ${JSON.stringify([{ owner: { name: "Bea" }, plan: "pro" }, [{ id: 1, label: "l1", done: false }, { id: 2, label: "l2", done: false }]])}`,
      `each ${JSON.stringify([{ owner: { name: "Bea" }, plan: "pro" }, [{ id: 1, label: "l1", done: true }, { id: 2, label: "second", done: false }]])}`,
      `nested ${JSON.stringify([{ owner: { name: "Bea" }, plan: "pro" }, [{ id: 1, label: "nested", done: true }, { id: 2, label: "second", done: false }]])}`,
    ]);
  });

  it("updates nested rows that read an outer row's position, item or outer state like the general runtime", async () => {
    const text = component(`
      <state name="title" type="string" value="a"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>`, `
      <section><ul><li $each="row, i of $rows" $key="$row.id"><b $each="n of [1]">{$i}:{$row.label}</b></li></ul>
        <ol><li $each="row, i of $rows" $key="$row.id"><p $each="n of [1]"><s $if="$row.id > 1"><b $each="m of [1]">{$i}/{$loop.count}</b></s></p><i>{$row.label} {$loop.last}</i></li></ol>
        <dl><template $each="row of $rows"><dt $each="n of [1]">{$title}{$row.id}</dt><dd><b $each="m of [1]"><i $each="k of [1]">{$title}</i></b></dd></template></dl></section>`);
    await same(text, [
      (host) => { host.state.rows = [1, 2, 3].map((id) => ({ id, label: `l${id}` })); },
      (host) => { host.state.rows = host.state.rows.toReversed(); },
      (host) => { host.state.rows.splice(1, 1); },
      (host) => { host.state.rows.unshift({ id: 4, label: "l4" }); },
      (host) => { host.state.rows[2].label = "x"; host.state.title = "b"; },
      (host) => { host.state.rows = host.state.rows.slice(1).concat(host.state.rows.slice(0, 1)); },
      (host) => { host.state.rows.push({ id: 5, label: "l5" }); },
    ]);
  });

  // The older direct paths compile these primitive, controller-free shapes; they must match live too.
  const older = (defs: string, body: string): string => component(defs, body, false);
  const fire = (target: any, type: string, init: EventInit & { key?: string; ctrlKey?: boolean } = {}): boolean => {
    const event = type === "keydown" ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : type === "click" ? new MouseEvent(type, { bubbles: true, cancelable: true, ...init }) : new Event(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const log = (text: string): void => { (globalThis as any).directExtendLog.events.push(text); };
  const olderShapes: Record<string, [string, readonly Step[]]> = {
    counter: [older(`<state name="count" type="number" value="0"></state><computed name="label" from="concat('n', $count)"></computed>
      <handler name="up"><set name="count" expr:value="$count + 1" $if="$count < 2"></set></handler>`,
      `<section><button on:click.prevent="up" from:aria-label="$label">{$count}</button><output $value="$label"></output></section>`),
      [({ root }) => log(String(fire(root.querySelector("button"), "click"))), ({ root }) => { fire(root.querySelector("button"), "click"); fire(root.querySelector("button"), "click"); }]],
    "number guard": [older(`<state name="count" type="number" value="1"></state><handler name="divide"><set name="count" expr:value="$count / 0"></set></handler>`,
      `<section><button on:click="divide"><output $value="$count"></output></button></section>`), [({ root }) => fire(root.querySelector("button"), "click")]],
    checkbox: [older(`<state name="done" type="boolean" value="false"></state>`, `<section><input type="checkbox" bind:checked="done"><output $value="$done"></output></section>`),
      [({ root }) => { root.querySelector("input").click(); log(String(root.querySelector("input").checked)); }]],
    range: [older(`<state name="position" type="number" value="0"></state>`, `<section><input type="range" min="0" max="100" bind:value="position"><output $value="$position"></output></section>`),
      [({ root }) => { root.querySelector("input").value = "42"; fire(root.querySelector("input"), "input"); log(root.querySelector("input").value); }]],
    choice: [older(`<state name="choice" type="string" value="one"></state>`,
      `<section><textarea bind:value="choice"></textarea><select bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="$choice"></output></section>`),
      [({ root }) => { root.querySelector("select").value = "two"; fire(root.querySelector("select"), "change"); log(root.querySelector("textarea").value); },
        ({ root }) => { root.querySelector("textarea").value = "three"; fire(root.querySelector("textarea"), "input"); log(root.querySelector("select").value); }]],
    modifiers: [older(`<state name="count" type="number" value="0"></state><handler name="up"><set name="count" expr:value="$count + 1"></set></handler>`,
      `<section><input on:keydown.enter.stop="up"><button on:click.self.once="up"><b>inner</b></button><output $value="$count"></output></section>`),
      [({ root }) => { log(String(fire(root.querySelector("input"), "keydown", { key: "Enter" }))); fire(root.querySelector("input"), "keydown", { key: "a" }); },
        ({ root }) => { fire(root.querySelector("b"), "click"); fire(root.querySelector("button"), "click"); fire(root.querySelector("button"), "click"); }]],
    "mixed text and styles": [older(`<state name="count" type="number" value="2"></state><state name="tone" type="string" value="red"></state>
      <handler name="up"><set name="count" expr:value="$count + 1"></set><set name="tone" value="blue"></set></handler>`,
      `<section style:color="$tone" from:data-count="$count"><p>Count: {$count} of {$tone}!</p><button on:click="up" class:big="$count > 2">Up</button></section>`),
      [({ root }) => fire(root.querySelector("button"), "click")]],
  };
  for (const [name, [text, steps]] of Object.entries(olderShapes)) {
    it(`matches live for the older direct shape: ${name}`, async () => { await same(text, steps); });
  }

  // Shapes the former compact Vanilla emitters compiled, driven through their DOM and props: every
  // control, button and key filter, three times, with declared events and focus logged.
  const poke = (host: any, update: (props: Record<string, unknown>) => void, round: number): void => {
    const root: Element = host.root;
    if (round === 0) root.addEventListener("saved", (event) => log(`saved ${JSON.stringify((event as CustomEvent).detail)}`));
    update(round === 0 ? { label: "Hi", value: 5 } : round === 1 ? { label: null, value: "bad" } : { label: undefined, value: undefined });
    for (const control of root.querySelectorAll<HTMLInputElement>("input, textarea, select")) {
      if (control.type === "checkbox") control.click();
      else if (control instanceof HTMLSelectElement) { control.value = round === 1 ? "one" : "two"; fire(control, "change"); }
      else { control.value = control.type === "range" || control.type === "number" ? String(40 + round) : `typed${round}`; fire(control, "input"); }
    }
    for (const button of root.querySelectorAll("button")) {
      const inner = button.querySelector("span");
      if (inner !== null) log(`inner ${fire(inner, "click")}`);
      log(`click ${fire(button, "click")}`);
      log(`ctrl ${fire(button, "keydown", { key: "Enter", ctrlKey: true })}`);
      log(`enter ${fire(button, "keydown", { key: "Enter" })}`);
    }
    log(`focus ${root.ownerDocument.activeElement?.localName}`);
  };
  const formerCompactShapes: Record<string, string> = {
    "compiles simple numeric state directly to native browser primitives": `<template component="demo-counter" status="experimental" summary="Counter.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment">
          <set name="count" expr:value="$count + 1"></set>
          <set name="count" expr:value="$count + 1"></set>
        </handler>
      </defs>
      <button type="button" on:click="increment"><output $value="$count"></output></button>
    </template>`,
    "prunes directly compiled numeric updates by their static dependencies": `<template component="demo-split" status="experimental" summary="Split state.">
      <defs>
        <state type="number" name="left" value="1"></state>
        <state type="number" name="right" value="10"></state>
        <computed name="left1" from="$left + 1"></computed>
        <computed name="left2" from="$left1 + 1"></computed>
        <computed name="left3" from="$left2 + 1"></computed>
        <computed name="total" from="$left3 + $right"></computed>
        <handler name="increaseLeft"><set name="left" expr:value="$left + 1"></set></handler>
        <handler name="increaseRight"><set name="right" expr:value="$right + 1"></set></handler>
      </defs>
      <section><button on:click="increaseLeft"><output $value="$left3"></output></button><button on:click="increaseRight"><output $value="$total"></output></button></section>
    </template>`,
    "removes unused direct numeric branches from generated output": `<template component="demo-live" status="experimental" summary="Live direct branch.">
      <defs>
        <state type="number" name="left" value="1"></state>
        <state type="number" name="right" value="10"></state>
        <computed name="visible" from="$right + 1"></computed>
        <computed name="unused1" from="$left + 1"></computed>
        <computed name="unused2" from="$unused1 + 1"></computed>
        <computed name="unused3" from="$unused2 + 1"></computed>
        <handler name="increaseLeft"><set name="left" expr:value="$left + 1"></set></handler>
        <handler name="increaseRight"><set name="right" expr:value="$right + 1"></set></handler>
      </defs>
      <section><button on:click="increaseLeft"></button><button on:click="increaseRight"><output $value="$visible"></output></button></section>
    </template>`,
    "suppresses repeated direct rounded DOM output": `<template component="demo-round" status="experimental" summary="Rounded direct value.">
      <defs>
        <state type="number" name="position" value="0"></state>
        <computed name="bucket" from="round($position)"></computed>
        <handler name="advance"><set name="position" expr:value="$position + 0.1"></set></handler>
      </defs>
      <button on:click="advance"><output $value="$bucket"></output></button>
    </template>`,
    "gates only stabilizing direct bindings in a mixed output": `<template component="demo-mixed" status="experimental" summary="Mixed direct value.">
      <defs>
        <state type="number" name="position" value="0"></state>
        <computed name="bucket" from="round($position)"></computed>
        <handler name="advance"><set name="position" expr:value="$position + 0.1"></set></handler>
      </defs>
      <button on:click="advance"><output $value="$position"></output><output $value="$bucket"></output></button>
    </template>`,
    "compiles numeric data attributes with the direct native emitter": `<template component="demo-data" status="experimental" summary="Direct data binding.">
      <defs>
        <state type="number" name="position" value="0"></state>
        <computed name="bucket" from="round($position)"></computed>
        <handler name="advance"><set name="position" expr:value="$position + 0.1"></set></handler>
      </defs>
      <button on:click="advance" from:data-bucket="$bucket"><output $value="$position"></output></button>
    </template>`,
    "compiles numeric ARIA attributes with the direct native emitter": `<template component="demo-aria" status="experimental" summary="Direct ARIA binding.">
      <defs>
        <state type="number" name="position" value="0"></state>
        <computed name="bucket" from="round($position)"></computed>
        <handler name="advance"><set name="position" expr:value="$position + 0.1"></set></handler>
      </defs>
      <button on:click="advance" role="progressbar" from:aria-valuenow="$position" from:aria-valuetext="$bucket"><output $value="$position"></output></button>
    </template>`,
    "compiles numeric ordinary HTML attributes with the direct native emitter": `<template component="demo-title" status="experimental" summary="Direct HTML attribute binding.">
      <defs>
        <state type="number" name="position" value="0"></state>
        <computed name="bucket" from="round($position)"></computed>
        <handler name="advance"><set name="position" expr:value="$position + 0.1"></set></handler>
      </defs>
      <button on:click="advance" from:title="$bucket"><output $value="$position"></output></button>
    </template>`,
    "compiles numeric native HTML properties with the direct emitter": `<template component="demo-value" status="experimental" summary="Direct HTML property binding.">
      <defs>
        <state type="number" name="position" value="0"></state>
        <computed name="bucket" from="round($position)"></computed>
        <handler name="advance"><set name="position" expr:value="$position + 0.1"></set></handler>
      </defs>
      <button on:click="advance"><input type="number" .value="$bucket"><output $value="$position"></output></button>
    </template>`,
    "compiles primitive boolean state, attributes, and properties with the direct emitter": `<template component="demo-toggle" status="experimental" summary="Direct primitive toggle.">
      <defs>
        <state type="boolean" name="open" value="false"></state>
        <computed name="closed" from="not $open"></computed>
        <handler name="toggle"><set name="open" expr:value="not $open"></set></handler>
      </defs>
      <button on:click="toggle" from:aria-expanded="$open" from:hidden="$closed"><input type="checkbox" .checked="$open"><output $value="$closed"></output></button>
    </template>`,
    "compiles primitive class tokens with the direct emitter": `<template component="demo-class-toggle" status="experimental" summary="Direct primitive class toggle.">
      <defs>
        <state type="boolean" name="open" value="false"></state>
        <handler name="toggle"><set name="open" expr:value="not $open"></set></handler>
      </defs>
      <button on:click="toggle" class:open="$open"><output $value="$open"></output></button>
    </template>`,
    "compiles primitive HTML style values with the direct emitter": `<template component="demo-style-counter" status="experimental" summary="Direct primitive style counter.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment" style:--count="$count"><output $value="$count"></output></button>
    </template>`,
    "compiles primitive SVG style values with the direct emitter": `<template component="demo-svg-style-counter" status="experimental" summary="Direct primitive SVG style counter.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment"><svg style:--count="$count"><text>Chart</text></svg><output $value="$count"></output></button>
    </template>`,
    "compiles direct text input bindings with the native dirty-value guard": `<template component="demo-bound-text" status="experimental" summary="Direct native text binding.">
      <defs><state type="string" name="draft" value="Ready"></state></defs>
      <section><label>Draft <input type="text" bind:value="draft"></label><output $value="$draft"></output></section>
    </template>`,
    "compiles direct checkbox bindings with native checked synchronization": `<template component="demo-bound-check" status="experimental" summary="Direct native checkbox binding.">
      <defs><state type="boolean" name="done" value="false"></state></defs>
      <section><input type="checkbox" bind:checked="done"><output $value="$done"></output></section>
    </template>`,
    "compiles direct textarea and single-select bindings": `<template component="demo-bound-choice" status="experimental" summary="Direct native choice bindings.">
      <defs><state type="string" name="choice" value="one"></state></defs>
      <section><textarea bind:value="choice"></textarea><select bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="$choice"></output></section>
    </template>`,
    "compiles direct range bindings with native numeric synchronization": `<template component="demo-bound-range" status="experimental" summary="Direct native range binding.">
      <defs><state type="number" name="position" value="0"></state></defs>
      <section><input type="range" min="0" max="100" bind:value="position"><output $value="$position"></output></section>
    </template>`,
    "compiles static self handlers with a native target identity guard": `<template component="demo-event-self" status="experimental" summary="Direct native self modifier.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <section><button on:click.self="increment"><span>Inner</span><output $value="$count"></output></button></section>
    </template>`,
    "compiles static filtered handlers with native event guards": `<template component="demo-event-filter" status="experimental" summary="Direct native event filter.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <section><button on:keydown.enter.ctrl.exact.self.prevent.stop="increment"><span>Inner</span><output $value="$count"></output></button></section>
    </template>`,
    "compiles static capture and passive listeners with native options": `<template component="demo-event-options" status="experimental" summary="Direct native event options.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <section><button on:click.capture.passive.stop="increment"><span>Inner</span><output $value="$count"></output></button></section>
    </template>`,
    "compiles static once listeners through the generated lifecycle coordinator": `<template component="demo-event-once" status="experimental" summary="Native once fallback.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <button on:keydown.enter.once="increment"><output $value="$count"></output></button>
    </template>`,
    "compiles static state-derived primitive event dispatch through generated runtime validation": `<template component="demo-event-dispatch" status="experimental" summary="Direct declared event dispatch.">
      <defs>
        <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
        <state type="number" name="count" value="0"></state>
        <handler name="save"><set name="count" expr:value="$count + 1"></set><dispatch event="saved" expr:value="$count"></dispatch></handler>
      </defs>
      <button on:click="save">Save</button>
    </template>`,
    "compiles state-only boolean handler guards while preserving subsequent steps": `<template component="demo-guarded-handler" status="experimental" summary="Direct guarded handler.">
      <defs>
        <event name="saved" type="number"></event>
        <state type="boolean" name="enabled" value="true"></state>
        <state type="number" name="count" value="0"></state>
        <handler name="advance"><set name="count" expr:value="$count + 1" $if="$enabled"></set><dispatch event="saved" expr:value="$count" $if="$enabled"></dispatch><set name="enabled" expr:value="not $enabled"></set></handler>
      </defs>
      <button on:click="advance"><output $value="$count"></output></button>
    </template>`,
    "pulls static primitive computed handler guards before each guarded step": `<template component="demo-computed-guard" status="experimental" summary="Computed guard direct path.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <state type="number" name="hits" value="0"></state>
        <computed name="even" from="$count % 2 = 0"></computed>
        <handler name="advance"><set name="count" expr:value="$count + 1"></set><set name="hits" expr:value="$hits + 1" $if="$even"></set></handler>
      </defs>
      <button on:click="advance"><output $value="$count"></output><output $value="$hits"></output></button>
    </template>`,
    "compiles static refs with native validation and focus handler steps": `<template component="demo-ref-action" status="experimental" summary="Direct static ref action.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="submit"><validate target="form"></validate><focus ref="field"></focus><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <section><form $ref="form"><input required $ref="field"></form><button on:click="submit">Submit</button><output $value="$count"></output></section>
    </template>`,
    "compiles dependency-free primitive `$value` beside dynamic direct output": `<template component="demo-literal-text" status="experimental" summary="Direct literal text.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <section><output class="status" $value="'Ready'"></output><button on:click="increment"><output $value="$count"></output></button></section>
    </template>`,
    "compiles dependency-free primitive native bindings beside dynamic direct output": `<template component="demo-literal-native" status="experimental" summary="Direct literal native bindings.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <section from:data-status="'ready'" from:aria-hidden="false" from:hidden="true" class:fixed="true" style:--gap="4"><input .value="'Fixed'"><button on:click="increment"><output $value="$count"></output></button></section>
    </template>`,
    "initializes transitively constant direct computeds during construction": `<template component="demo-static-computed" status="experimental" summary="Static computed direct construction.">
      <defs>
        <event name="saved" type="string"></event>
        <state type="number" name="count" value="0"></state>
        <computed name="prefix" from="'Ready'"></computed>
        <computed name="label" from="concat($prefix, '!')"></computed>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
        <handler name="save"><dispatch event="saved" expr:value="$label"></dispatch></handler>
      </defs>
      <section from:data-status="$label" class:ready="$label = 'Ready!'" style:--label="$prefix"><input .value="$label"><output class="status" $value="$label"></output><button on:click="increment"><output $value="$count"></output></button><button on:click="save">Save</button></section>
    </template>`,
    "pulls static primitive computed event detail through the generated dispatch boundary": `<template component="demo-computed-event-dispatch" status="experimental" summary="Direct computed declared event dispatch.">
      <defs>
        <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
        <state type="number" name="count" value="0"></state>
        <computed name="savedValue" from="$count * 2"></computed>
        <handler name="save"><set name="count" expr:value="$count + 1"></set><dispatch event="saved" expr:value="$savedValue"></dispatch></handler>
      </defs>
      <button on:click="save">Save <output $value="$savedValue"></output></button>
    </template>`,
    "compiles a static primitive `$value` expression without the live runtime": `<template component="demo-inline-expression" status="experimental" summary="Direct inline text expression.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="$count + 1"></output></button>
    </template>`,
    "compiles static primitive attribute, property, class, and style expressions directly": `<template component="demo-inline-attributes" status="experimental" summary="Direct inline native expressions.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <section from:data-count="$count + 1" class:zero="$count = 0" style:--count="$count + 1"><button on:click="increment">Advance</button><input type="number" .value="$count + 1"></section>
    </template>`,
    "compiles dependency-free primitive `$value` expressions as direct text": `<template component="demo-static-directive" status="experimental" summary="Static directive text.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="'fixed'"></output></button>
    </template>`,
    "guards direct mutable numeric state against non-finite writes": `<template component="demo-typed-number" status="experimental" summary="Typed numeric state.">
      <defs><state name="count" type="number" value="1"></state><handler name="divide"><set name="count" expr:value="$count / 0"></set></handler></defs>
      <button on:click="divide"><output $value="$count"></output></button>
    </template>`,
    "includes set value dependencies even when they are not rendered": `<template component="demo-set-input" status="experimental" summary="Set input dependency.">
      <defs><state type="number" name="count" value="0"></state><state type="number" name="snapshot" value="0"></state><handler name="save"><set name="snapshot" expr:value="$count + 1"></set></handler></defs>
      <button on:click="save"><output $value="$snapshot"></output></button>
    </template>`,
    "refreshes a computed before a later set reads it": `<template component="demo-sequential-sets" status="experimental" summary="Sequential sets.">
      <defs><state type="number" name="count" value="0"></state><state type="number" name="snapshot" value="0"></state><computed name="double" from="$count * 2"></computed><handler name="advance"><set name="count" expr:value="$count + 1"></set><set name="snapshot" expr:value="$double"></set></handler></defs>
      <button on:click="advance"><output $value="$snapshot"></output></button>
    </template>`,
    "compiles static string modes to direct native text, attributes, and properties": `<template component="demo-tabs" status="experimental" summary="Direct string tabs.">
      <defs>
        <state type="string" name="tab" value="one"></state>
        <handler name="showOne"><set name="tab" expr:value="'one'"></set></handler>
        <handler name="showTwo"><set name="tab" expr:value="'two'"></set></handler>
      </defs>
      <section from:data-tab="$tab" from:title="$tab"><button on:click="showOne">One</button><button on:click="showTwo">Two</button><input .value="$tab"><output $value="$tab"></output></section>
    </template>`,
    "compiles literal primitive concat expressions to direct string concatenation": `<template component="demo-label" status="experimental" summary="Direct formatted label.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <computed name="label" from="concat('Step ', $count)"></computed>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment" from:aria-label="$label"><input .value="$label"><output $value="$label"></output></button>
    </template>`,
    "preserves literal percent characters in direct concatenation": `<template component="demo-missing-format" status="experimental" summary="Direct missing format placeholder.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <computed name="label" from="concat($count, '/%s')"></computed>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="$label"></output></button>
    </template>`,
    "keeps numeric SVG data attributes on the direct native emitter": `<template component="demo-svg-data" status="experimental" summary="Direct SVG data binding.">
      <defs>
        <state type="number" name="size" value="24"></state>
        <handler name="grow"><set name="size" expr:value="$size + 1"></set></handler>
      </defs>
      <button on:click="grow"><svg from:data-size="$size"><path d="M0 0"></path></svg></button>
    </template>`,
    "compiles scalar prop reflection without the live interpreter": `<template component="demo-label" status="experimental" summary="A target compiler fixture."><props><prop name="label" type="string" default="Ready">Label.</prop></props><output from:data-label="$label"><span $value="$label"></span></output></template>`,
    "compiles a scalar native property prop with the compact generated boundary": `<template component="demo-prop-value" status="experimental" summary="A target compiler fixture."><props><prop name="value" type="number" default="1">Value.</prop></props><input type="number" .value="$value"></template>`,
    "creates vanilla SVG subtrees in the SVG namespace": `<template component="demo-icon" status="experimental" summary="A target compiler fixture."><props><prop name="label" type="string" default="Close">Label.</prop></props><button from:aria-label="$label"><svg viewBox="0 0 24 24"><path d="M6 6l12 12"></path><foreignObject><span>html</span></foreignObject></svg></button></template>`,
    "compiles a read-only primitive reactive leaf without the full runtime": `<template component="demo-derived" status="experimental" summary="Derived output.">
      <defs><state type="number" name="count" value="0"></state></defs>
      <output $value="$count + 1"></output>
    </template>`,
    "compiles static prevent and stop handlers with native event calls": `<template component="demo-event-modifier" status="experimental" summary="Direct native event modifiers.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <section><button on:click.prevent.stop="increment"><output $value="$count"></output></button></section>
    </template>`,
  };
  for (const [name, text] of Object.entries(formerCompactShapes)) {
    it(`matches live for a former compact shape: ${name}`, async () => {
      await same(text, [0, 1, 2].map((round) => (host, update) => poke(host, update, round)));
    });
  }

  it("checks formatted and keyword state like the general runtime", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="site" type="url" value="https://a.example/"></state>
      <state name="tint" type="color" value="red"></state>
      <state name="when" type="date" nullable></state>
      <state name="tone" type="keyword" values="solid, outline" value="solid"></state>
      <state name="links" type="list(url)" value="[]"></state>`, `
      <section><p>{$site} {$tint} {$when} {$tone}</p><a from:href="$site">x</a><b $value="$links[0]"></b><i $value="$links.length"></i></section>`);
    await same(text, [
      (host) => { host.state.site = "not a url"; host.state.tint = "#abc"; host.state.when = "2024-02-29"; host.state.tone = "outline"; },
      (host) => { host.state.tint = "nope"; host.state.when = "2023-02-29"; host.state.tone = "dashed"; host.state.when = null; },
      (host) => { host.state.links = ["https://b.example/", "bad"]; host.state.links.push(4); },
      (host) => { host.state.site = "https://c.example/"; host.state.links[0] = "also bad"; host.state.selected = 1; },
    ]);
  });

  it("keeps a computed's value read-only through host.state, nested writes too, like the general runtime", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <computed name="first" from="$rows[0]"></computed>
      <computed name="labels" from="[default($first.label, 'none')]"></computed>`, `
      <section><p>{default($first.label, 'none')}</p><b $value="$labels[0]"></b><i $value="$rows.length"></i></section>`);
    const note = (host: any, label: string): void => {
      (globalThis as any).directExtendLog.events.push(`${label} ${JSON.stringify(host.state.rows)} ${JSON.stringify(host.state.first)} ${JSON.stringify(host.state.labels)}`);
    };
    await same(text, [
      (host) => { host.state.rows = [{ id: 1, label: "a" }]; note(host, "rows"); },
      (host) => { host.state.first.label = "z"; note(host, "nested"); },
      (host) => { delete host.state.first.label; host.state.labels.push("x"); note(host, "delete"); },
      (host) => { host.state.first = { id: 2, label: "b" }; note(host, "root"); },
    ]);
  });

  it("tracks more than 29 roots exactly like the general runtime", async () => {
    const many = Array.from({ length: 34 }, (_, index) => `<state name="s${index}" type="number" value="${index}"></state>`).join("");
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>${many}`, `
      <section><p>{$s0} {$s30} {$s33}</p><input .value="$s31"><b $if="$s32 > 40">big</b><i class:hot="$s33 > 40"></i></section>`);
    const note = (host: any, label: string): void => {
      (globalThis as any).directExtendLog.events.push(`${label} ${host.root.querySelector("input").value}`);
    };
    await same(text, [
      (host) => { host.root.querySelector("input").value = "typed"; host.state.s30 = 1; note(host, "s30"); },
      (host) => { host.state.s31 = 5; host.state.s32 = 50; note(host, "s31"); },
      (host) => { host.state.s33 = 50; host.state.s0 = 9; host.root.querySelector("input").value = "again"; note(host, "s33"); },
      (host) => { host.state.s32 = 51; note(host, "s32"); },
    ]);
  });

  it("keeps the :host-state attribute in step like the general runtime", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>
      <state name="tone" type="string" value=""></state>`, `
      <section><p>{$tone}</p></section><style>:host-state([ready]) { color: red; } :host-state([tone="loud"]) { color: blue; }
      :host-state([selected]) { outline: 1px solid; }</style>`);
    await same(text, [
      (host) => { host.state.tone = "loud"; host.state.selected = 2; },
      (host) => { host.state.tone = ""; host.state.selected = 0; },
      (host) => { host.state.ready = false; },
    ]);
  });

  const propsShape = (defs: string, body: string): string =>
    `<template component="x-shape" controller="./props-controller.js" status="early" summary="Shape.">
    <defs>${defs}</defs>${body}</template>`;
  const scalarProps = `
    <prop name="variant" type="keyword" values="solid, subtle, outline" default="subtle">Emphasis.</prop>
    <prop name="label" type="string">Label.</prop>
    <prop name="count" type="integer" default="2">Count.</prop>
    <prop name="ratio" type="number">Ratio.</prop>
    <prop name="open" type="boolean" default="false">Open.</prop>
    <state name="note" type="string" value="n"></state>
    <computed name="doubled" from="$count * 2"></computed>
    <computed name="summary" from="concat($variant, ':', default($label, $note))"></computed>`;
  const scalarBody = `
    <section class:open="$open" from:data-tone="$variant"><p>{$label} {$count} {$ratio}</p><b $value="$summary"></b>
      <i $if="$open">{$doubled}</i><ul><li $each="n of [1, 2, 3]" $key="$n" from:data-id="$n"><b $if="$n <= $count">{$n}</b></li></ul></section>`;

  it("accepts, renders and reflects props like the general runtime", async () => {
    await same(propsShape(scalarProps, scalarBody), [
      (_host, update) => { update({ variant: "solid", count: 3 }); },
      (_host, update) => { update({ label: "Hi", open: true, ratio: 0.5 }); },
      // Invalid inputs are refused and leave the value; null clears and undefined returns the default.
      (_host, update) => { update({ count: "4", variant: "loud", ratio: Number.NaN }); },
      (_host, update) => { update({ label: null, count: undefined }); },
      (_host, update) => { update({ open: false, unknown: 1 }); },
    ], { variant: "outline", label: "Start", ratio: 1.5 });
  });

  it("refuses invalid initial props and reports the root's validity like the general runtime", async () => {
    await same(propsShape(`${scalarProps}<prop name="name" type="string" required>Name.</prop>`, scalarBody), [
      (_host, update) => { update({ name: "set" }); },
      (_host, update) => { update({ name: "", count: 1.5 }); },
      (_host, update) => { update({ name: undefined }); },
    ], { variant: "huge", count: "x", attributes: { "data-label": "From attribute", id: "x" } });
  });

  it("writes a root's bound data-* prop as template output", async () => {
    await same(propsShape(`
      <prop name="variant" type="keyword" values="solid, subtle" default="subtle">Emphasis.</prop>
      <prop name="size" type="keyword" values="sm, md" default="md">Size.</prop>`, `
      <section from:data-variant="$variant"><p>{$size}</p></section>`), [
      (_host, update) => { update({ variant: "solid", size: "sm" }); },
      (_host, update) => { update({ variant: "bad", size: "bad" }); },
      (_host, update) => { update({ variant: undefined, size: undefined }); },
    ], { size: "sm" });
  });

  it("reads structured props through their declared types", async () => {
    await same(propsShape(`
      <prop name="items" type="list(object({ id: integer, label: string }))" default="[]">Items.</prop>
      <prop name="config" type="object({ title: string, limit?: integer })">Config.</prop>`, `
      <section><h2>{$config.title}</h2><ol><li $each="item of $items" $key="$item.id" from:data-id="$item.id"><b $if="$item.id <= default($config.limit, 9)">{$item.label}</b></li></ol></section>`), [
      (_host, update) => { update({ items: [{ id: 1, label: "a" }, { id: 2, label: "b" }], config: { title: "T", limit: 1 } }); },
      (_host, update) => { update({ items: [{ id: 2, label: "B" }, { id: 3, label: "c" }], config: { title: "U" } }); },
      (_host, update) => { update({ items: [{ id: "x" }], config: { title: 1 } }); },
    ], { items: [{ id: 1, label: "a" }], config: { title: "Start" } });
  });

  it("checks prop bounds and writes boolean and property bindings like the general runtime", async () => {
    await same(propsShape(`
      <prop name="amount" type="number" min="1" max="10">Amount.</prop>
      <prop name="label" type="string" minlength="2" maxlength="8" pattern="[a-z]+">Label.</prop>
      <prop name="open" type="boolean" default="false">Open.</prop>
      <prop name="gone" type="boolean" default="false">Gone.</prop>`, `
      <section from:aria-expanded="$open" from:hidden="$gone"><input type="number" .value="$amount" from:data-label="$label"></section>`), [
      (_host, update) => { update({ amount: 11, label: "a" }); },
      (_host, update) => { update({ amount: 0, label: "toolongvalue", open: true, gone: true }); },
      (_host, update) => { update({ amount: 5, label: "UPPER" }); },
      (_host, update) => { update({ amount: 5, label: "fine", open: false, gone: false }); },
    ], { amount: 3, label: "ok" });
  });

  it("writes URL sinks, form properties, boolean defaults and escaped literals like the general runtime", async () => {
    await same(propsShape(`
      <prop name="target" type="string" default="https://example.test">Target.</prop>
      <prop name="destination" type="string">Destination.</prop>
      <prop name="disabled" type="boolean" default="false">Disabled.</prop>
      <prop name="selected" type="boolean" default="false">Selected.</prop>`, `
      <section><a from:href="$target">Link</a><button title="A &amp; &quot;quote&quot;" .formAction="$destination" from:disabled="$disabled" from:data-selected="$selected">Text &amp; \\{literal}</button></section>`), [
      (_host, update) => { update({ target: "javascript:alert(1)", destination: "/go", disabled: true }); },
      (_host, update) => { update({ target: " JAVASCRIPT:x", selected: true }); },
      (_host, update) => { update({ target: "/relative", disabled: false, destination: undefined }); },
    ]);
  });

  it("types a select prop by its selector's current value", async () => {
    const select = (from: string) => propsShape(`
      ${from}
      <type name="input-value" from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type>
      <prop name="value" type="input-value">Value.</prop>`, `
      <section from:data-value="$value"><p>{$value}</p><b $if="$value = 3">three</b></section>`);
    // A required selector can be cleared, which chooses nothing: then the value must be null.
    await same(select('<prop name="mode" type="keyword" values="text, number" required>Mode.</prop>'), [
      (_host, update) => { update({ mode: "number" }); },
      (_host, update) => { update({ value: 3 }); },
      (_host, update) => { update({ value: "four", mode: "text" }); },
      (_host, update) => { update({ mode: null }); },
      (_host, update) => { update({ mode: undefined, value: undefined }); },
    ], { mode: "text", value: "start" });
    await same(select('<prop name="mode" type="keyword" values="text, number" default="number">Mode.</prop>'), [
      (_host, update) => { update({ value: "x" }); },
      (_host, update) => { update({ value: 9, mode: "text" }); },
    ], { mode: "number", value: "7" });
  });

  const slotsShape = (defs: string, body: string): string =>
    `<template component="x-shape" controller="./slots-controller.js" status="early" summary="Shape.">
    <defs><state name="open" type="boolean" value="false"></state><state name="label" type="string" value="L"></state>${defs}</defs>${body}</template>`;
  const projection = (document: Document): Record<string, unknown> => {
    const element = (tag: string, text: string): Element => { const node = document.createElement(tag); node.textContent = text; return node; };
    return { children: ["Hello ", element("b", "world")], slots: { head: [element("h1", "Title"), element("small", "sub")], unknown: [element("i", "lost")] } };
  };

  it("projects children and named slots, and renders fallbacks, like the general runtime", async () => {
    const text = slotsShape("", `
      <section><header><slot name="head"><em>{$label}</em></slot></header><main><slot></slot></main>
        <footer><slot name="tail">Tail {$label}<b $if="$open">open</b></slot></footer><aside><slot name="missing"></slot></aside></section>`);
    const steps: Step[] = [(host) => { host.state.label = "M"; }, (host) => { host.state.open = false; }];
    await same(text, steps, projection);
    await same(text, steps);
  });

  it("moves projected nodes with the region that renders their slot", async () => {
    await same(slotsShape(`<state name="shown" type="boolean" value="true"></state>`, `
      <section><div $if="$shown"><slot></slot></div><p $if="not $shown"><slot name="head">none</slot></p><slot name="tail"></slot></section>`), [
      (host) => { host.state.shown = false; },
      (host) => { host.state.shown = true; },
      (host) => { host.state.label = "x"; },
    ], projection);
  });

  it("gives projected nodes to the outlet live's assembly appends last when two share a name", async () => {
    // Static names are unique, so outlets share one only in rows or through a dynamic name.
    for (const body of [
      '<section><ul><li $each="n of $rows" $key="$n" from:data-id="$n"><slot name="head">row</slot></li></ul></section>',
      '<section><slot from:name="$which"></slot><div><slot name="head"></slot></div></section>',
      '<section><div><slot name="head"></slot></div><slot from:name="$which"></slot></section>',
      '<section><div><slot from:name="$which"></slot></div><p><slot name="head"></slot></p><b $if="$open"><slot from:name="$other"></slot></b></section>',
    ]) {
      await same(slotsShape(`<state name="which" type="string" value="head"></state><state name="other" type="string" value="head"></state>
        <state name="rows" type="list(integer)" value="[1, 2]"></state>`, body), [
        (host) => { host.state.open = false; },
        (host) => { host.state.open = true; host.state.rows = [2, 1, 3]; },
        (host) => { host.state.rows = [4]; },
      ], projection);
    }
  });

  it("names a slot by its expression when it renders", async () => {
    await same(slotsShape(`<state name="which" type="string" value="head"></state>`, `
      <section><div $if="$open"><slot from:name="$which">fallback {$which}</slot></div></section>`), [
      (host) => { host.state.which = "default"; },
      (host) => { host.state.open = false; },
      (host) => { host.state.which = ""; host.state.open = true; },
    ], projection);
    await same(slotsShape(`<state name="which" type="string" value="head"></state>`, `
      <section><slot from:name="$which">fallback {$which}</slot><p $with="$label as l"><slot from:name="$which">{$l}</slot></p></section>`), [
      (host) => { host.state.which = "default"; },
      (host) => { host.state.which = ""; },
    ], projection);
    // A name reading the region's alias, or inside the chosen `$match` arm, rebuilds that body too.
    await same(slotsShape(`<state name="which" type="string" value="head"></state>`, `
      <section><p $with="$which as w"><slot from:name="$w">none {$w}</slot></p>
        <template $match><div $when="$open"><slot from:name="$which">open</slot></div><div $else><slot from:name="$which">shut</slot></div></template></section>`), [
      (host) => { host.state.which = "default"; },
      (host) => { host.state.open = true; },
      (host) => { host.state.which = "head"; },
      (host) => { host.state.label = "kept"; },
    ], projection);
  });

  const armsShape = propsShape(`
    <prop name="as" type="keyword" values="div, section, article" default="div">Element.</prop>
    <prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop>
    <state name="count" type="integer" value="1"></state>`, `
    <template $match>
      <section $when="$as = 'section'" class="card own" style="color: red" from:data-tone="$tone" class:hot="$count > 1"><h2>{$tone}</h2><slot></slot></section>
      <article $when="$as = 'article' and $count < 3" role="article" title="own"><button>{$count}</button><slot></slot></article>
      <div $else tabindex="-1"><slot></slot><b>{$count}</b></div>
    </template>`);

  it("switches a root $match arm like the general runtime", async () => {
    const options = (document: Document): Record<string, unknown> => {
      const child = document.createElement("i");
      child.textContent = "kept";
      return { as: "section", attributes: { class: "mine", style: "margin: 1px", id: "x", title: "theirs" }, children: [child] };
    };
    await same(armsShape, [
      (_host, update) => { update({ as: "article", tone: "warn" }); },
      (host) => { host.state.count = 5; },
      (_host, update) => { update({ as: "section" }); },
      (host, update) => { host.state.count = 2; update({ as: undefined }); },
      (_host, update) => { update({ as: "nope" }); },
      (host) => { host.root.click(); host.root.querySelector("i").click(); },
      (_host, update) => { update({ as: "article" }); },
      (host) => { host.root.querySelector("button").click(); host.root.querySelector("button").focus(); },
      // Focus stays on the control in the same position among the new root's focusable elements.
      (_host, update) => { update({ as: "section" }); },
      (host) => { (globalThis as any).directExtendLog.events.push(`focus ${host.root.ownerDocument.activeElement.localName}`); host.root.focus(); },
      (host, update) => { update({ as: "div" }); host.root.click(); },
      (host) => { (globalThis as any).directExtendLog.events.push(`focus ${host.root.ownerDocument.activeElement.localName}`); },
    ], options);
  });

  it("switches a link-or-button root with its refs and list props like the general runtime", async () => {
    await same(propsShape(`
      <prop name="as" type="keyword" values="button, a" default="button">Native root.</prop>
      <prop name="href" type="string">Link.</prop>
      <prop name="disabled" type="boolean" default="false">Off.</prop>
      <prop name="tags" type="keyword#">Comma-separated tags.</prop>
      <prop name="spaceTags" type="keyword+">Space-separated tags.</prop>`, `
      <template $match>
        <a $when="$as = 'a'" class="action" from:href="{ true: null, false: $href }[concat($disabled)]" from:data-tags="$tags" from:data-space-tags="$spaceTags" $ref="control"><slot></slot></a>
        <button $else class="action" type="button" from:disabled="$disabled" $ref="control"><slot></slot></button>
      </template>`), [
      (host, update) => { (globalThis as any).directExtendLog.events.push(`ref ${host.refs.control.localName}`); update({ as: "a", href: "/next", tags: ["red", "blue"], spaceTags: ["one", "two"] }); },
      (host, update) => { (globalThis as any).directExtendLog.events.push(`ref ${host.refs.control.localName}`); update({ disabled: true }); },
      (host, update) => { (globalThis as any).directExtendLog.events.push(`ref ${host.refs.control.localName}`); update({ as: "button" }); },
      (host) => { (globalThis as any).directExtendLog.events.push(`ref ${host.refs.control.localName} ${host.refs.control === host.root}`); },
    ], { children: ["Go"] });
  });

  const badge = `<template component="x-badge" status="early" summary="Badge.">
    <defs><prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop>
      <prop name="count" type="integer" default="0">Count.</prop><prop name="label" type="string">Label.</prop>
      <prop name="open" type="boolean" default="false">Open.</prop></defs>
    <span class="badge" from:data-tone="$tone"><b>{$count}</b><i $if="$open">{$label}</i><slot name="icon">*</slot><slot></slot></span></template>`;
  const parent = (body: string, defs = ""): string => propsShape(`
    <prop name="flag" type="boolean" default="false">Flag.</prop>
    <state name="label" type="string" value="L"></state><state name="count" type="integer" value="1"></state>
    <state name="rows" type="list(integer)" value="[1, 2]"></state>
    <handler name="bump"><set name="count" expr:value="$count + 1"></set></handler>${defs}`, body);

  it("invokes a compiled component like live lowering", async () => {
    await same([parent(`
      <section><x-badge tone="warn" count="3" open class="extra" title="t" from:label="$label" class:hot="$count > 1" style:color="$flag ? 'red' : 'blue'"
        from:data-n="$count" on:click="bump" $ref="badge">Text {$label}<em slot="icon">{$count}</em></x-badge></section>`), badge], [
      (host) => { host.state.label = "M"; },
      (host) => { host.root.querySelector("span").click(); },
      (host, update) => { (globalThis as any).directExtendLog.events.push(`ref ${host.refs.badge.className}`); update({ flag: true }); host.state.count = 5; },
    ]);
  });

  it("passes a child prop on only when its value changes, like live lowering", async () => {
    const meter = `<template component="x-meter" controller="./props-controller.js" status="early" summary="Meter.">
      <defs><prop name="amount" type="integer" default="0">Amount.</prop></defs><meter from:value="$amount"></meter></template>`;
    const log = (): string[] => (globalThis as any).directExtendLog.events;
    let observer: MutationObserver | undefined;
    try {
      const run = await same([parent(`<section><x-meter from:amount="$count + $rows.length"></x-meter></section>`), meter], [
        (host) => {
          const root = host.root.querySelector("meter");
          observer = new (root.ownerDocument.defaultView.MutationObserver)((records: MutationRecord[]) => {
            log().push(...records.map((record) => `write ${record.attributeName}`).sort());
          });
          observer!.observe(root, { attributes: true });
          // 2 + 1 is the 1 + 2 it was: the child's input, validity and reflection stay as they are.
          host.state.count = 2;
          host.state.rows = [1];
        },
        (host) => { host.state.count = 5; },
        () => { observer?.disconnect(); },
      ]);
      // The equal sum logs nothing and writes nothing; the new one updates the child once.
      assert.deepEqual(run.events.slice(4, 11), [
        "1 state |undefined", "1 props amount=3/3/true", "1 root meter true", "1 connect true null true",
        "1 props amount=6/6/true", "write data-amount", "write value",
      ]);
    } finally {
      observer?.disconnect();
    }
  });

  it("binds invocation props by their values, after their attribute text", async () => {
    await same([parent(`
      <section><x-badge from:count="$label" from:tone="$flag ? 'warn' : 'nope'" from:open="$flag"></x-badge></section>`), badge], [
      (_host, update) => { update({ flag: true }); },
      (host) => { host.state.label = "7"; },
      (host, update) => { host.state.label = "x"; update({ flag: false }); },
    ]);
  });

  it("invokes components in regions and keyed rows like live lowering", async () => {
    await same([parent(`
      <section><x-badge $if="$flag" from:count="$count">if</x-badge>
        <ul><li $each="n of $rows" $key="$n" from:data-id="$n"><x-badge from:count="$n" from:label="$label" on:click="bump" $ref="rows">{$n}</x-badge></li></ul>
        <x-badge $each="n of $rows" $key="$n" from:count="$n * 10"></x-badge></section>`), badge], [
      (_host, update) => { update({ flag: true }); },
      (host) => { host.state.rows = [2, 3, 1]; host.state.label = "z"; },
      (host) => { host.root.querySelectorAll("li span")[1].click(); (globalThis as any).directExtendLog.events.push(`refs ${host.refs.rows.length}`); },
      (host, update) => { host.state.rows = [3]; update({ flag: false }); },
    ]);
  });

  it("follows an invoked component's root switch with the parent's bindings", async () => {
    const action = `<template component="x-action" status="early" summary="Action.">
      <defs><prop name="as" type="keyword" values="button, a" default="button">As.</prop></defs>
      <template $match><a $when="$as = 'a'" href="#"><slot></slot></a><button $else type="button"><slot></slot></button></template></template>`;
    await same([parent(`
      <section><x-action from:as="$flag ? 'a' : 'button'" class:hot="$count > 1" from:title="$label" on:click="bump" $ref="action">Go {$count}</x-action></section>`), action], [
      (host) => { host.root.querySelector("button").click(); },
      (_host, update) => { update({ flag: true }); },
      (host) => { host.root.querySelector("a").click(); (globalThis as any).directExtendLog.events.push(`ref ${host.refs.action.localName}`); },
      (host, update) => { host.state.label = "N"; update({ flag: false }); },
      (host) => { host.root.querySelector("button").click(); (globalThis as any).directExtendLog.events.push(`ref ${host.refs.action.localName}`); },
    ]);
  });

  it("renders a custom element no component claims as an element, like live", async () => {
    await same(parent(`
      <section><x-other class="o" from:title="$label" class:hot="$count > 1" from:data-n="$count" on:click="bump" $ref="other"><b>{$label}</b><x-deeper $if="$flag">{$count}</x-deeper></x-other></section>`), [
      (host) => { host.root.querySelector("x-other").click(); (globalThis as any).directExtendLog.events.push(`ref ${host.refs.other.localName}`); },
      (host, update) => { host.state.label = "Q"; update({ flag: true }); },
    ]);
  });

  it("retains nothing from rows it removed: their listeners and invoked components", async () => {
    const compiled = graph([parent(`
      <section><ul><li $each="n of $rows" $key="$n" from:data-id="$n" on:click="bump"><x-badge from:count="$n" on:click="bump">{$n}</x-badge></li></ul></section>`), badge]);
    const { text: code } = await bundle(compiled.entry, false, compiled.modules);
    const { window } = new JSDOM("<!doctype html><body></body>");
    for (const key of Object.getOwnPropertyNames(window)) {
      if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
      try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
    }
    vi.stubGlobal("directExtendLog", { hosts: [], events: [] });
    const module = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// retention`).toString("base64")}`) as Record<string, unknown>;
    const factory = Object.entries(module).find(([name]) => name.startsWith("create"))![1] as () => Element;
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const root = factory();
    window.document.body.append(root);
    await flush();
    const handle = (root as unknown as Record<symbol, { h: { o: unknown[] } }>)[Symbol.for("@nextwebwg/html-next.lifecycle.v1")]!.h;
    const host = (globalThis as any).directExtendLog.hosts[0];
    const baseline = handle.o.length;
    for (let round = 0; round < 40; round += 1) {
      host.state.rows = Array.from({ length: 10 }, (_, index) => round * 10 + index);
      await flush();
      host.state.rows = [];
      await flush();
    }
    // Each round created and removed ten rows' listeners and component-following effects.
    assert.ok(handle.o.length <= baseline + 2 * 10 * 3, `${handle.o.length} owners after 40 rounds (${baseline} at start)`);
  });

  it("fails a <context> no ancestor provides with live's HR009", async () => {
    const step = `<template component="x-step" status="early" summary="Step.">
      <defs><context name="count" from="x-shape" as="active"></context></defs><li>{$active}</li></template>`;
    const messages: string[] = [];
    for (const compiled of [false, true]) {
      const { text: code } = await bundle(compiled ? graph([step]).entry : reference(step));
      // The failure surfaces from the lifecycle observer's callback, which jsdom reports.
      const reported: string[] = [];
      const virtualConsole = new VirtualConsole();
      virtualConsole.on("jsdomError", (error) => reported.push(error.message));
      const { window } = new JSDOM("<!doctype html><body></body>", { virtualConsole });
      for (const key of Object.getOwnPropertyNames(window)) {
        if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
        try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
      }
      const module = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// missing ${compiled}`).toString("base64")}`) as Record<string, unknown>;
      const factory = Object.entries(module).find(([name]) => name.startsWith("create"))![1] as () => Element;
      window.document.body.append(factory());
      await new Promise((resolve) => setTimeout(resolve, 0));
      messages.push(reported.find((message) => /HR\d+/.test(message)) ?? "none");
      vi.unstubAllGlobals();
    }
    assert.equal(messages.length, 2);
    assert.match(messages[0]!, /HR009: <x-step> requires context `count` from <x-shape>\./);
    assert.equal(messages[1], messages[0]);
  });

  it("observes each document once however many compiled roots it holds", async () => {
    const action = `<template component="x-action" status="early" summary="Action.">
      <defs><prop name="as" type="keyword" values="button, a" default="button">As.</prop></defs>
      <template $match><a $when="$as = 'a'" href="#"><slot></slot></a><button $else type="button"><slot></slot></button></template></template>`;
    const compiled = graph([parent(`
      <section><x-badge $each="n of $rows" $key="$n" from:count="$n"><x-action from:as="$flag ? 'a' : 'button'">{$n}</x-action></x-badge></section>`), badge, action]);
    const { text: code } = await bundle(`${compiled.entry}\nexport { updateGeneratedProps as update } from "@nextwebwg/html-next/generated-runtime";`, false, compiled.modules);
    const { window } = new JSDOM("<!doctype html><body></body>");
    let observers = 0;
    const Native = window.MutationObserver;
    (window as unknown as { MutationObserver: unknown }).MutationObserver = class extends Native {
      constructor(callback: MutationCallback) { super(callback); observers += 1; }
    };
    for (const key of Object.getOwnPropertyNames(window)) {
      if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
      try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
    }
    vi.stubGlobal("directExtendLog", { hosts: [], events: [] });
    const module = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// observers`).toString("base64")}`) as Record<string, unknown>;
    const factory = Object.entries(module).find(([name]) => name.startsWith("create"))![1] as (options?: object) => Element;
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const roots = [factory(), factory(), factory()];
    window.document.body.append(...roots);
    await flush();
    const host = (globalThis as any).directExtendLog.hosts[0];
    host.state.rows = [1, 2, 3, 4];
    (module.update as (element: Element, props: object) => void)(roots[0]!, { flag: true });
    await flush();
    roots[1]!.remove();
    await flush();
    window.document.body.append(roots[1]!);
    await flush();
    assert.equal(window.document.querySelectorAll("[data-component]").length, 3 + 3 * 2 * 2 + 2 * 2);
    // Every compiled root, parent or invoked, shares the document's one lifecycle observer.
    assert.equal(observers, 1);
  });

  it("delegates a root to an invoked component and shares it, like live", async () => {
    const card = `<template component="x-card" status="early" summary="Card.">
      <defs><prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop>
        <prop name="as" type="keyword" values="section, article" default="section">As.</prop></defs>
      <template $match><article $when="$as = 'article'" class="card"><slot name="head"></slot><slot></slot></article>
        <section $else class="card" from:data-tone="$tone"><slot name="head"></slot><slot></slot></section></template></template>`;
    const panel = propsShape(`
      <prop name="title" type="string" required>Title.</prop>
      <prop name="kind" type="keyword" values="section, article" default="section">Kind.</prop>
      <state name="count" type="integer" value="1"></state>
      <handler name="bump"><set name="count" expr:value="$count + 1"></set></handler>`, `
      <x-card tone="warn" class="panel" from:as="$kind" on:click="bump"><h2 slot="head">{$title}</h2><p>{$count} <slot></slot></p></x-card>`);
    await same([panel, card], [
      (host) => { host.root.click(); (globalThis as any).directExtendLog.events.push(`hosts ${(globalThis as any).directExtendLog.hosts.length}`); },
      (_host, update) => { update({ title: "Next", kind: "article" }); },
      (host, update) => { host.root.click(); update({ title: undefined }); },
    ], { title: "T", attributes: { id: "p", class: "mine" }, children: ["body"] });
  });

  it("renders rows of several nodes like the general runtime", async () => {
    const rows = `
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>`;
    const steps: Step[] = [
      (host) => { host.state.rows = [1, 2, 3, 4].map((id) => ({ id, label: `r${id}` })); },
      (host) => { const list = host.state.rows; const first = list[0]; list[0] = list[3]; list[3] = first; },
      (host) => { host.state.selected = 2; host.state.rows[1].label = "x"; },
      (host) => { host.state.rows = host.state.rows.filter((row: { id: number }) => row.id !== 2).concat([{ id: 9, label: "n" }]); },
      (host) => { host.state.rows = [...host.state.rows].toReversed(); },
      (host) => { host.state.rows = []; },
      (host) => { host.state.rows = [{ id: 5, label: "five" }]; },
    ];
    for (const body of [
      `<section><p></p><dl><template $each="row of $rows" $key="$row.id"><dt from:data-id="$row.id">{$row.label}</dt><dd $if="$row.id = $selected">sel</dd>text</template></dl></section>`,
      `<section><p></p><dl><template $each="row of $rows"><dt from:data-id="$row.id">{$row.label}</dt><dd>{$loop.index}</dd></template></dl></section>`,
      `<section><p></p><dl><template $each="row, i of $rows" $key="$row.id"><dt from:data-id="$row.id">{$i}</dt><dd>{$loop.count}</dd></template></dl></section>`,
    ]) {
      await same(component(rows, body), steps);
    }
  });

  it("renders scoped and $each slots with a consumer's template like live", async () => {
    const list = `<template component="x-row-list" status="early" summary="Rows.">
      <defs><prop name="items" type="list(object({ id: integer, name: string }))" default="[]">Items.</prop>
        <state name="title" type="string" value="Rows"></state></defs>
      <section><h3><slot name="title" from:text="$title">{$title}</slot></h3>
        <ul><slot $each="item, i of $items" $key="$item.id" name="row" from:item="$item" from:index="$i"><li>{$item.name}</li></slot></ul></section></template>`;
    const consumer = parent(`
      <section><x-row-list from:items="$people">
        <template slot="row"><li from:data-id="$item.id"><b>{$item.name}</b> {$index} <i $if="$flag">{$label}</i></li></template>
      </x-row-list><x-row-list from:items="$people"></x-row-list></section>`,
      `<state name="people" type="list(object({ id: integer, name: string }))" value="[]"></state>`);
    await same([consumer, list], [
      (host) => { host.state.people = [{ id: 1, name: "Ada" }, { id: 2, name: "Bea" }]; },
      (host, update) => { host.state.label = "L2"; update({ flag: true }); },
      (host) => { host.state.people[0].name = "Ann"; },
      (host) => { host.state.people = [host.state.people[1], { id: 3, name: "Cy" }, host.state.people[0]]; },
      (host) => { host.state.people = []; },
    ]);
  });

  it("reads an ancestor's state through <context> like live", async () => {
    const step = `<template component="x-step" status="early" summary="Step.">
      <defs><prop name="index" type="integer" default="0">Index.</prop>
        <context name="count" from="x-shape" as="active"></context><context name="people" from="x-shape"></context></defs>
      <li from:aria-current="$active = $index ? 'step' : null"><b>{$active}</b> <i>{$people.length}</i>
        <em $each="person of $people" $key="$person.id">{$person.name}</em></li></template>`;
    const provider = parent(`
      <ol><x-step index="1"></x-step><x-step from:index="$count + 1"></x-step><li $each="n of $rows" $key="$n" from:data-id="$n"><x-step from:index="$n"></x-step></li></ol>`,
      `<state name="people" type="list(object({ id: integer, name: string }))" value="[]"></state>`);
    await same([provider, step], [
      (host) => { host.state.count = 2; },
      (host) => { host.state.people = [{ id: 1, name: "Ada" }]; },
      (host) => { host.state.people.push({ id: 2, name: "Bea" }); host.state.people[0].name = "Ann"; },
      (host) => { host.state.rows = [2, 3]; host.state.count = 3; },
    ]);
  });

  it("reads declared data like live", async () => {
    const requests: string[] = [];
    fetchStub = async (url) => {
      requests.push(url);
      await Promise.resolve();
      return { ok: !url.includes("fail"), status: 500, json: async () => [{ name: url.split("/").at(-1)!.split("?")[0] }], text: async () => "" };
    };
    try {
      await same(parent(`
        <section><p $if="$users.pending">loading</p><b $if="$users.ok">ok</b><i>{default($users.error, 'none')}</i>
          <ul><li $each="user of default($users.value, [])">{$user.name}</li></ul></section>`, `
        <state name="q" type="string" value="a"></state><state name="page" type="integer" value="1"></state>
        <data name="users" src="https://example.test/api/users/{q}" type="list(object({ name: string }))">
          <param name="q" from:value="$q"></param><param name="page" expr:value="$page"></param></data>`), [
        (host) => { host.state.q = "b"; },
        // An `expr` parameter is sampled when a request goes out; changing it requests nothing.
        (host) => { host.state.page = 2; },
        (host) => { host.state.q = "fail"; },
        (host) => { host.state.q = "c"; (globalThis as any).directExtendLog.events.push(`data ${JSON.stringify(host.data.users)} ${"users" in host.data} ${"other" in host.data}`); host.data.users.value = []; },
      ]);
      // Both paths made the same requests: on connect, per changed `from` parameter, and on reconnect.
      assert.deepEqual(requests.slice(0, requests.length / 2), requests.slice(requests.length / 2));
      assert.ok(requests.length >= 8, requests.join("\n"));
    } finally {
      fetchStub = undefined;
    }
  });

  it("requests again and passes a whole list on when it changes in place, like live", async () => {
    const requests: string[] = [];
    fetchStub = async (url) => {
      requests.push(url);
      await Promise.resolve();
      return { ok: true, status: 200, json: async () => [], text: async () => "" };
    };
    const tags = `<template component="x-tags" status="early" summary="Tags.">
      <defs><prop name="items" type="list(string)" default="[]">Items.</prop></defs><output>{$items}</output></template>`;
    const shelf = parent(`<section><x-tags from:items="$filter.tags"></x-tags><x-tags from:items="$more"></x-tags></section>`, `
      <state name="filter" type="object({ tags: list(string) })" value="{ tags: ['a'] }"></state>
      <state name="more" type="list(string)" value="['x']"></state>
      <data name="found" src="https://example.test/api/found" type="list(string)">
        <param name="tags" from:value="$filter.tags"></param><param name="more" from:value="$more"></param></data>`);
    // Each `from` parameter compares what it reads now with what it read for the last request.
    const compared = [...[...graph([shelf, tags]).modules.values()].join("\n").matchAll(/readsChanged\(DQ0\.(f\d+), (f\d+)\)/g)];
    assert.equal(compared.length, 2);
    for (const [, last, now] of compared) assert.equal(last, now);
    try {
      // A parameter or prop that is a whole list depends on its contents, not only on which list it is.
      await same([shelf, tags], [
        (host) => { host.state.filter.tags.push("b"); },
        (host) => { host.state.filter.tags[0] = "z"; },
        (host) => { host.state.more.push("y"); },
      ]);
      const half = requests.length / 2;
      assert.deepEqual(requests.slice(half), requests.slice(0, half));
      assert.deepEqual(requests.slice(0, half).map((url) => new URL(url).search), [
        "?tags=a&more=x", "?tags=a&tags=b&more=x", "?tags=z&tags=b&more=x", "?tags=z&tags=b&more=x&more=y",
        // Reconnecting requests again.
        "?tags=z&tags=b&more=x&more=y",
      ]);
    } finally {
      fetchStub = undefined;
    }
  });

  it("writes is=, content directives and two-way bindings on invocations like live", async () => {
    const field = `<template component="x-field" status="early" summary="Field.">
      <defs><prop name="value" type="string" default="">Value.</prop></defs><input .value="$value"></template>`;
    await same([parent(`
      <section><button is="x-fancy" from:title="$label">is</button>
        <x-badge $value="$label" from:count="$count"></x-badge><x-badge $html="'<b>' + $label + '</b>'"></x-badge>
        <x-field bind:value="label"></x-field><x-field bind:title="label"></x-field></section>`), badge, field], [
      (host) => { host.state.label = "M"; },
      (host) => {
        const [first, second] = host.root.querySelectorAll("input");
        first.value = "typed"; first.dispatchEvent(new Event("input", { bubbles: true }));
        second.value = "other"; second.dispatchEvent(new Event("input", { bubbles: true }));
      },
      (host) => { (globalThis as any).directExtendLog.events.push(`label ${host.state.label}`); host.state.label = "N"; },
    ]);
  });

  it("compiles a component with only props like the general runtime", async () => {
    for (const body of ['<button from:data-tone="$tone" type="button">{$label}</button>', '<input from:value="$label" from:data-tone="$tone">']) {
      await same(`<template component="x-shape" status="early" summary="Shape.">
        <defs><prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop><prop name="label" type="string" required>Label.</prop></defs>${body}</template>`, [
        (_host, update) => { update({ tone: "warn", label: "L" }); },
        (_host, update) => { update({ tone: "bad", label: undefined }); },
        (host) => { (globalThis as any).directExtendLog.events.push(`valid ${(host.root as any).validity?.valid} ${(host.root as any).validationMessage}`); },
      ], { tone: "nope" });
    }
  });

  it("creates a component projected into a closed slot only when a slot renders it, like live", async () => {
    const leaf = `<template component="x-leaf" status="early" summary="Leaf."><defs><prop name="text" type="string" default="none">Text.</prop></defs>
      <p class="leaf" data-id="leaf" $value="$text"></p></template>`;
    const host = (controller: boolean): string => `<template component="x-host" ${controller ? 'controller="./slots-controller.js" ' : ""}status="early" summary="Host.">
      <defs><state type="boolean" name="open" value="false"></state><handler name="toggle"><set name="open" expr:value="not $open"></set></handler></defs>
      <div><button type="button" class="toggle" on:click="toggle">More</button><section $if="$open"><slot name="head"></slot></section></div></template>`;
    const page = `<template component="x-page" status="early" summary="Page."><defs><state type="string" name="label" value="from the page"></state></defs>
      <div><x-host><x-leaf slot="head" from:text="$label"></x-leaf><b slot="tail">tail</b></x-host></div></template>`;
    const toggle = ({ root }: any): void => root.querySelector("button.toggle").click();
    // Closed at first render: nothing is created until the slot opens; then closing and reopening
    // inserts the same component root again.
    await same([page, host(false), leaf], [() => {}, toggle, toggle, toggle]);
    // The host's controller reads its slots while the slot is closed, then opens it on connect.
    await same([page, host(true), leaf], [toggle, toggle]);
  });

  it("renders a consumer's <template slot> only while a slot without props renders, like live", async () => {
    const leaf = `<template component="x-leaf" status="early" summary="Leaf."><defs><prop name="text" type="string" default="none">Text.</prop></defs>
      <p class="leaf" $value="$text"></p></template>`;
    const toggle = `<template component="x-toggle" controller="./host-reader.js" status="early" summary="Toggle.">
      <defs><state type="boolean" name="open" value="false"></state><handler name="toggle"><set name="open" expr:value="not $open"></set></handler></defs>
      <div><button type="button" class="toggle" on:click="toggle">More</button><section $if="$open"><slot name="details"></slot><slot name="note"></slot></section></div></template>`;
    const page = `<template component="x-page" status="early" summary="Page."><defs><state type="string" name="label" value="first"></state>
      <handler name="rename"><set name="label" expr:value="'second'"></set></handler></defs>
      <div><button type="button" class="rename" on:click="rename">Rename</button><x-toggle>
        <p slot="note" class="note" data-id="note">Note</p>
        <template slot="details"><i data-id="detail" $value="$label"></i><x-leaf from:text="$label"></x-leaf></template>
      </x-toggle></div></template>`;
    const tag = (element: Element): string => element.localName + (element.className === "" ? "" : `.${element.className}`);
    const read = (host: any): void => log(`details ${host.slots.details.map(tag)} note ${host.slots.note.map(tag)} rendered ${
      host.root.ownerDocument.querySelectorAll("template[slot]").length}`);
    const click = (name: string) => (host: any): void => host.root.ownerDocument.querySelector(`button.${name}`).click();
    await same([page, toggle, leaf], [read, click("toggle"), read, click("rename"), read, click("toggle"), read, click("toggle"), read]);
  });

  it("invokes a scalar prop component like live lowering", async () => {
    const tag = `<template component="x-tag" status="early" summary="Tag.">
      <defs><prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop><prop name="label" type="string" required>Label.</prop></defs>
      <button from:data-tone="$tone" type="button">{$label}</button></template>`;
    await same([parent(`
      <section><x-tag tone="warn" label="Hi"></x-tag><x-tag tone="bad"></x-tag><x-tag from:label="$label" from:tone="$flag ? 'warn' : 'nope'"></x-tag></section>`), tag], [
      (_host, update) => { update({ flag: true }); },
      (host) => { host.state.label = "7"; },
      (host, update) => { host.state.label = "8"; update({ flag: false }); },
    ]);
  });

  it("renders a root $with and a real element's root $match like live", async () => {
    const rows = `
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>`;
    const steps: Step[] = [
      (host) => { host.state.rows = [{ id: 1, label: "a" }, { id: 2, label: "b" }]; },
      (host) => { host.state.rows[0].label = "z"; host.state.selected = 2; },
      (host) => { host.state.rows = []; },
    ];
    await same(component(rows, `<section $with="$rows[0] as first" from:data-n="$rows.length"><p>{default($first.label, 'none')}</p><b $if="$first">has</b></section>`), steps);
    await same(component(rows, `<section $match class="m"><p $when="$rows.length = 0">empty</p><p $when="$selected">{$selected}</p><ul $else><li $each="row of $rows" $key="$row.id" from:data-id="$row.id">{$row.label}</li></ul></section>`), steps);
  });

  it("gives a scoped slot's props by name, and leaves other names to the consumer, like live", async () => {
    const alternate = `<template component="x-alternate" status="early" summary="Alternate.">
      <defs><prop name="alternate" type="boolean" default="false">Alternate.</prop>
        <state name="first" type="string" value="First"></state><state name="second" type="string" value="Second"></state></defs>
      <template $match><section $when="$alternate"><slot name="item" from:first="$first"></slot></section>
        <article $else><slot name="item" from:second="$second"></slot></article></template></template>`;
    await same([parent(`
      <section><x-alternate from:alternate="$flag"><template slot="item"><b>{default($first, 'no first')}</b> <i>{default($second, 'no second')}</i></template></x-alternate></section>`,
      `<state name="first" type="string" value="mine"></state><state name="second" type="string" value="own"></state>`), alternate], [
      (_host, update) => { update({ flag: true }); },
      (host) => { if (host.state === undefined) (globalThis as any).directExtendLog.events.push("no host"); else { host.state.first = "changed"; host.state.second = "own2"; } },
      (_host, update) => { update({ flag: false }); },
    ]);
    await same([parent(`
      <section><x-alternate from:alternate="$flag"><template slot="item"><b>{default($first, 'no first')}</b> <i>{default($second, 'no second')}</i> <u>{$label}</u></template></x-alternate></section>`,
      `<state name="first" type="string" value="mine"></state>`), alternate], [
      // The section arm gives no \`second\`, which the consumer does not declare: HB001 leaves the old arm, inert.
      (_host, update) => { update({ flag: true }); },
      (host) => { host.state.first = "changed"; host.state.label = "L2"; },
    ]);
  });

  it("fails a moved duplicate key before writing any row", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>`, `
      <section><p>rows</p><ul $if="$ready"><li $each="row of $rows" $key="$row.id" from:data-id="$row.id"><b $value="$row.label"></b></li></ul></section>`);
    const compiled = await same(text, [
      (host) => { host.state.rows = [{ id: 1, label: "a" }, { id: 2, label: "b" }]; },
      (host) => { host.state.rows[0].label = "X"; host.state.rows[1].id = 1; },
    ]);
    assert.deepEqual(compiled.errors, ["HR004: A keyed list produced duplicate key `1`."]);
  });

  it("keeps whitespace-only text between elements and rows inside pre", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="selected" type="number" nullable></state>
      <state name="rows" type="list(object({ id: number, label: string, tags: list(string) }))" value="[]"></state>`, `
      <section><p>code</p><pre><code><span class="line">a</span>
<span class="line">b</span>
<template $each="row of $rows" $key="$row.id"><span class="line" from:data-id="$row.id">{$row.label}</span>
</template></code></pre></section>`);
    const compiled = await same(text, [
      (host) => { host.state.rows = [{ id: 1, label: "c", tags: [] }, { id: 2, label: "d", tags: [] }]; },
    ]);
    assert.match(compiled.snapshots[1]!.replaceAll(/<!--[^>]*-->/g, ""), /<code><span class="line">a<\/span>\n<span class="line">b<\/span>\n<span class="line" data-id="1">c<\/span>\n<span class="line" data-id="2">d<\/span>\n<\/code>/);
  });

  it("creates attributes and class tokens on one element in authored order", async () => {
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>`, `
      <section><p from:title="$ready" from:data-x="$rows.length" from:lang="$ready" class:a="$ready" class:b="$rows.length" class:c="$ready">rows</p>
        <ul $if="$ready"><li $each="row of $rows" $key="$row.id" class:x="$ready" from:data-id="$row.id" class:y="$row.label" from:title="$ready"></li></ul></section>`);
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
