import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { build, transform } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";

import { compileExpression, evaluateCompiled, type Value } from "../src/expression.js";
import { generateComponent, type Invoked } from "../src/generate.js";
import { compactTypeAt, conforms, type CompactType } from "../src/generated-runtime.js";
import { parseComponent } from "../src/source-parser.js";
import { visitSelected } from "../src/selection.js";
import { serializedDefinition } from "../src/targets/shared.js";
import { blockPlan, compactSource, compactType, lowerExpression } from "../src/targets/vanilla-blocks.js";
import { normalizeType, parseTypedValue, parseTypeExpression, typeAtKey, type TypeNode } from "../src/type-system.js";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const fixtures = new URL("./fixtures/direct-extend/", import.meta.url);

function vanilla(text: string, directExtend: boolean, invocations?: ReadonlyMap<string, Invoked>): string {
  const definition = parseComponent(text, new URL("component.html", fixtures).href);
  const named = definition.controller === undefined ? definition : { ...definition, controller: `./${definition.controller.split("/").at(-1)}` };
  return generateComponent(named, { directExtend, ...invocations === undefined ? {} : { invocations } }).find((artifact) => artifact.path.endsWith(".js"))!.content;
}

/** A graph of components (the first one invokes the rest), each compiled with the others as invocations. */
function graph(texts: readonly string[]): { readonly entry: string; readonly modules: ReadonlyMap<string, string> } {
  const definitions = texts.map((text) => parseComponent(text, new URL("component.html", fixtures).href));
  const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
  const modules = new Map(texts.map((text, index) => [`./${definitions[index]!.contract.name}.js`, vanilla(text, true, invocations)]));
  return { entry: modules.get(`./${definitions[0]!.contract.name}.js`)!, modules };
}

/**
 * The reference every compiled module is held to: the live runtime attached to a fresh root, as
 * generated output's general-runtime fallback attached it, rendering the same definition.
 */
function reference(text: string, invoked: readonly string[] = []): string {
  const definition = parseComponent(text, new URL("component.html", fixtures).href);
  // Components the root's template invokes, which live lowering renders from their registered definitions.
  const others = invoked.map((other) => parseComponent(other, new URL("component.html", fixtures).href));
  const controlled = definition.controller !== undefined;
  const named = controlled ? { ...definition, controller: `./${definition.controller!.split("/").at(-1)}` } : definition;
  const root = definition.template.name;
  return [
    'import { componentRootIndex, getComponentHost, manageComponentLifecycle, observeDocument, registerComponentDefinitions } from "@nextwebwg/html-next/runtime";',
    'export { updateComponentProps as update } from "@nextwebwg/html-next/runtime";',
    ...controlled ? [`import * as controller from ${JSON.stringify(named.controller)};`] : [],
    // Registered as a live document registers it, with its styles and their `:host-state()` names.
    `const definition = { ...${serializedDefinition(named)}, css: ${JSON.stringify(definition.css)} };`,
    `registerComponentDefinitions([definition${others.map((other) => `, { ...${serializedDefinition(other)}, css: ${JSON.stringify(other.css)} }`).join("")}]);`,
    // A live document is observed, so an invocation a region renders later lowers too. A root lowered
    // from its invocation gets its controller as the browser loader gives one: once per host, on connect.
    ...others.length > 0 ? [definition.root?.kind === "component" && controlled ? [
      "const initialized = new WeakSet();",
      "observeDocument(document, { onConnect(element, connected) {",
      `  if (connected.contract.tag !== ${JSON.stringify(definition.contract.tag)}) return;`,
      "  const host = getComponentHost(element);",
      "  if (initialized.has(host)) return;",
      "  initialized.add(host);",
      "  let cleanup; let disconnected = false;",
      "  void Promise.resolve(controller.default(host)).then((result) => { if (typeof result !== \"function\") return; if (disconnected) result(); else cleanup = result; });",
      "  return () => { disconnected = true; cleanup?.(); };",
      "} });",
    ].join("\n") : "observeDocument(document);"] : [],
    "export function createReference(options = {}) {",
    "  const { attributes = {}, children = [], slots = {}, ...props } = options;",
    // A root delegated to another component is lowered from its invocation, as a live document lowers it.
    ...definition.root?.kind === "component" ? [
      `  const invocation = document.createElement(${JSON.stringify(definition.contract.tag)});`,
      "  for (const [name, value] of Object.entries(attributes)) invocation.setAttribute(name, String(value));",
      "  for (const [name, value] of Object.entries(props)) if (value !== undefined && value !== null && value !== false) invocation.setAttribute(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value === true ? \"\" : typeof value === \"string\" ? value : JSON.stringify(value));",
      "  for (const child of children) invocation.append(child);",
      "  for (const [name, nodes] of Object.entries(slots)) for (const child of nodes) { if (typeof child !== \"string\") child.setAttribute(\"slot\", name); invocation.append(child); }",
      "  return invocation;",
      "}",
    ] : [

    // A root `$match` starts on the arm the props choose, as the general runtime's factories chose it.
    root === "template" ? "  const arm = definition.template.children[componentRootIndex(definition, props)], element = document.createElement(arm.name);"
      : root === "svg" ? '  const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");' : `  const element = document.createElement(${JSON.stringify(root)});`,
    "  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));",
    // Then the root's literals, as generated factories merge them: class and style combine, else the factory's win.
    `  const node = ${root === "template" ? "arm" : "definition.template"};`,
    "  for (const attribute of node.attributes) {",
    "    if (attribute.kind !== \"literal\") continue;",
    "    if (attribute.name === \"class\" || attribute.name === \"style\") element.setAttribute(attribute.name, [attribute.value, element.getAttribute(attribute.name)].filter(Boolean).join(attribute.name === \"class\" ? \" \" : \"; \"));",
    "    else if (!element.hasAttribute(attribute.name)) element.setAttribute(attribute.name, attribute.value);",
    "  }",
    `  element.setAttribute("data-component", ${JSON.stringify(definition.contract.tag)});`,
    // A factory's children and named slots, as the general runtime's factories projected them.
    "  const projected = [];",
    "  for (const [name, nodes] of [[\"\", children], ...Object.entries(slots)]) for (const child of nodes) projected.push([typeof child === \"string\" ? document.createTextNode(child) : child, name]);",
    `  manageComponentLifecycle(element, definition, { props, projected${controlled ? ", controller" : ""} });`,
    "  return element;",
    "}",
    ],
  ].join("\n");
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
    "nonconforming initial": component('<state name="x" type="number" value="abc"></state>', '<p $value="x"></p>'),
    "is attribute": component(state, '<p><span is="x-span"></span></p>'),
    event_listener: component(state, '<p><span on:click="go"></span></p>'),
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

  it("runs handlers, computeds, initializers, refs and declared events like the general runtime", async () => {
    const text = component(`
      <state name="count" type="number" value="0"></state>
      <state name="items" type="list(number)" value="[]"></state>
      <state name="label" type="string" value="start"></state>
      <state name="seed" type="number" expr:value="count + 10"></state>
      <computed name="double" from="count * 2"></computed>
      <computed name="total" type="number" from="seed + double"></computed>
      <event name="changed" type="number" bubbles="false"></event>
      <handler name="increment"><set name="count" expr:value="count + 1" $if="count < 3"></set><set name="items" expr:value="[count, double]"></set>
        <dispatch event="changed" expr:value="count"></dispatch><focus target="out"></focus></handler>
      <handler name="bad"><set name="count" expr:value="'x'"></set><set name="label" expr:value="$$event.type"></set></handler>`, `
      <section><button id="go" on:click.prevent="increment">Next</button><button id="bad" on:click.once="bad">Bad</button>
        <output $ref="out" tabindex="-1" $value="double"></output><p>{total} {label} {seed} {items}</p></section>`, false);
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
      <section><p>{title}</p>
        <b $if="rows.length">some</b><i $if="rows">truthy</i><s $if="rows[0].tags">tagged</s>
        <span $with="rows[0] as first"><em $value="first.label"></em> <u $value="first.tags.length"></u></span>
        <template $match="selected as chosen"><b $when="chosen = 1">one</b><i $when="chosen > 1">many {chosen}</i><u $else>none</u></template>
        <ol><li $each="row, i of rows" from:data-id="row.id" class:first="loop.first" class:last="loop.last">{i}/{loop.count} {row.label}
          <button $ref="picks" on:click.stop="pick">{row.label}</button><em $if="row.tags.length > 0 and ready">{row.tags}</em>
          <ul><li $each="tag of row.tags" $key="tag">{tag}</li></ul></li></ol>
        <menu><li $each="row of rows" $key="concat(prefix, row.id)" $where="row.label" $sort="-label,id" $limit="limit" from:data-key="row.id">{row.label}</li></menu>
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
      <section><p>{name} {age} {agree} {size} {colors}</p>
        <input id="name" bind:value="name"><input id="age" type="text" bind:value="age"><input id="agree" type="checkbox" bind:checked="agree">
        <input id="small" type="radio" name="size" value="s" from:checked="size = 's'"><textarea id="bio" bind:value="name"></textarea>
        <select id="size" bind:value="size"><option $each="row of rows" $key="row.id" from:value="row.label">{row.label}</option><option value="m">M</option></select>
        <select id="colors" multiple bind:value="colors"><option value="red">Red</option><option value="blue">Blue</option></select>
        <div id="html" $html="markup"></div><template $html="markup"></template><template $value="name"></template><template><i>inline</i> {age}</template>
        <input id="first" type="checkbox" bind:checked="rows[0].done"><ul><li $each="row of rows" $key="row.id" from:data-id="row.id"><b>{row.done}</b></li></ul>
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

  // The older direct paths compile these primitive, controller-free shapes; they must match live too.
  const older = (defs: string, body: string): string => component(defs, body, false);
  const fire = (target: any, type: string, init: EventInit & { key?: string } = {}): boolean => {
    const event = type === "keydown" ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : type === "click" ? new MouseEvent(type, { bubbles: true, cancelable: true, ...init }) : new Event(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const log = (text: string): void => { (globalThis as any).directExtendLog.events.push(text); };
  const olderShapes: Record<string, [string, readonly Step[]]> = {
    counter: [older(`<state name="count" type="number" value="0"></state><computed name="label" from="concat('n', count)"></computed>
      <handler name="up"><set name="count" expr:value="count + 1" $if="count < 2"></set></handler>`,
      `<section><button on:click.prevent="up" from:aria-label="label">{count}</button><output $value="label"></output></section>`),
      [({ root }) => log(String(fire(root.querySelector("button"), "click"))), ({ root }) => { fire(root.querySelector("button"), "click"); fire(root.querySelector("button"), "click"); }]],
    "number guard": [older(`<state name="count" type="number" value="1"></state><handler name="divide"><set name="count" expr:value="count / 0"></set></handler>`,
      `<section><button on:click="divide"><output $value="count"></output></button></section>`), [({ root }) => fire(root.querySelector("button"), "click")]],
    checkbox: [older(`<state name="done" type="boolean" value="false"></state>`, `<section><input type="checkbox" bind:checked="done"><output $value="done"></output></section>`),
      [({ root }) => { root.querySelector("input").click(); log(String(root.querySelector("input").checked)); }]],
    range: [older(`<state name="position" type="number" value="0"></state>`, `<section><input type="range" min="0" max="100" bind:value="position"><output $value="position"></output></section>`),
      [({ root }) => { root.querySelector("input").value = "42"; fire(root.querySelector("input"), "input"); log(root.querySelector("input").value); }]],
    choice: [older(`<state name="choice" type="string" value="one"></state>`,
      `<section><textarea bind:value="choice"></textarea><select bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="choice"></output></section>`),
      [({ root }) => { root.querySelector("select").value = "two"; fire(root.querySelector("select"), "change"); log(root.querySelector("textarea").value); },
        ({ root }) => { root.querySelector("textarea").value = "three"; fire(root.querySelector("textarea"), "input"); log(root.querySelector("select").value); }]],
    modifiers: [older(`<state name="count" type="number" value="0"></state><handler name="up"><set name="count" expr:value="count + 1"></set></handler>`,
      `<section><input on:keydown.enter.stop="up"><button on:click.self.once="up"><b>inner</b></button><output $value="count"></output></section>`),
      [({ root }) => { log(String(fire(root.querySelector("input"), "keydown", { key: "Enter" }))); fire(root.querySelector("input"), "keydown", { key: "a" }); },
        ({ root }) => { fire(root.querySelector("b"), "click"); fire(root.querySelector("button"), "click"); fire(root.querySelector("button"), "click"); }]],
    "mixed text and styles": [older(`<state name="count" type="number" value="2"></state><state name="tone" type="string" value="red"></state>
      <handler name="up"><set name="count" expr:value="count + 1"></set><set name="tone" value="blue"></set></handler>`,
      `<section style:color="tone" from:data-count="count"><p>Count: {count} of {tone}!</p><button on:click="up" class:big="count > 2">Up</button></section>`),
      [({ root }) => fire(root.querySelector("button"), "click")]],
  };
  for (const [name, [text, steps]] of Object.entries(olderShapes)) {
    it(`matches live for the older direct shape: ${name}`, async () => { await same(text, steps); });
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
      <section><p>{site} {tint} {when} {tone}</p><a from:href="site">x</a><b $value="links[0]"></b><i $value="links.length"></i></section>`);
    await same(text, [
      (host) => { host.state.site = "not a url"; host.state.tint = "#abc"; host.state.when = "2024-02-29"; host.state.tone = "outline"; },
      (host) => { host.state.tint = "nope"; host.state.when = "2023-02-29"; host.state.tone = "dashed"; host.state.when = null; },
      (host) => { host.state.links = ["https://b.example/", "bad"]; host.state.links.push(4); },
      (host) => { host.state.site = "https://c.example/"; host.state.links[0] = "also bad"; host.state.selected = 1; },
    ]);
  });

  it("tracks more than 29 roots exactly like the general runtime", async () => {
    const many = Array.from({ length: 34 }, (_, index) => `<state name="s${index}" type="number" value="${index}"></state>`).join("");
    const text = component(`
      <state name="ready" type="boolean" value="false"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      <state name="selected" type="number" nullable></state>${many}`, `
      <section><p>{s0} {s30} {s33}</p><input .value="s31"><b $if="s32 > 40">big</b><i class:hot="s33 > 40"></i></section>`);
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
      <section><p>{tone}</p></section><style>:host-state([ready]) { color: red; } :host-state([tone="loud"]) { color: blue; }
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
    <computed name="doubled" from="count * 2"></computed>
    <computed name="summary" from="concat(variant, ':', default(label, note))"></computed>`;
  const scalarBody = `
    <section class:open="open" from:data-tone="variant"><p>{label} {count} {ratio}</p><b $value="summary"></b>
      <i $if="open">{doubled}</i><ul><li $each="n of [1, 2, 3]" $key="n" from:data-id="n"><b $if="n <= count">{n}</b></li></ul></section>`;

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
      <section from:data-variant="variant"><p>{size}</p></section>`), [
      (_host, update) => { update({ variant: "solid", size: "sm" }); },
      (_host, update) => { update({ variant: "bad", size: "bad" }); },
      (_host, update) => { update({ variant: undefined, size: undefined }); },
    ], { size: "sm" });
  });

  it("reads structured props through their declared types", async () => {
    await same(propsShape(`
      <prop name="items" type="list(object({ id: integer, label: string }))" default="[]">Items.</prop>
      <prop name="config" type="object({ title: string, limit?: integer })">Config.</prop>`, `
      <section><h2>{config.title}</h2><ol><li $each="item of items" $key="item.id" from:data-id="item.id"><b $if="item.id <= default(config.limit, 9)">{item.label}</b></li></ol></section>`), [
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
      <section from:aria-expanded="open" from:hidden="gone"><input type="number" .value="amount" from:data-label="label"></section>`), [
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
      <section><a from:href="target">Link</a><button title="A &amp; &quot;quote&quot;" .formAction="destination" from:disabled="disabled" from:data-selected="selected">Text &amp; \\{literal}</button></section>`), [
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
      <section from:data-value="value"><p>{value}</p><b $if="value = 3">three</b></section>`);
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
      <section><header><slot name="head"><em>{label}</em></slot></header><main><slot></slot></main>
        <footer><slot name="tail">Tail {label}<b $if="open">open</b></slot></footer><aside><slot name="missing"></slot></aside></section>`);
    const steps: Step[] = [(host) => { host.state.label = "M"; }, (host) => { host.state.open = false; }];
    await same(text, steps, projection);
    await same(text, steps);
  });

  it("moves projected nodes with the region that renders their slot", async () => {
    await same(slotsShape(`<state name="shown" type="boolean" value="true"></state>`, `
      <section><div $if="shown"><slot></slot></div><p $if="not shown"><slot name="head">none</slot></p><slot name="tail"></slot></section>`), [
      (host) => { host.state.shown = false; },
      (host) => { host.state.shown = true; },
      (host) => { host.state.label = "x"; },
    ], projection);
  });

  it("gives projected nodes to the outlet live's assembly appends last when two share a name", async () => {
    // Static names are unique, so outlets share one only in rows or through a dynamic name.
    for (const body of [
      '<section><ul><li $each="n of rows" $key="n" from:data-id="n"><slot name="head">row</slot></li></ul></section>',
      '<section><slot from:name="which"></slot><div><slot name="head"></slot></div></section>',
      '<section><div><slot name="head"></slot></div><slot from:name="which"></slot></section>',
      '<section><div><slot from:name="which"></slot></div><p><slot name="head"></slot></p><b $if="open"><slot from:name="other"></slot></b></section>',
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
      <section><div $if="open"><slot from:name="which">fallback {which}</slot></div></section>`), [
      (host) => { host.state.which = "default"; },
      (host) => { host.state.open = false; },
      (host) => { host.state.which = ""; host.state.open = true; },
    ], projection);
    await same(slotsShape(`<state name="which" type="string" value="head"></state>`, `
      <section><slot from:name="which">fallback {which}</slot><p $with="label as l"><slot from:name="which">{l}</slot></p></section>`), [
      (host) => { host.state.which = "default"; },
      (host) => { host.state.which = ""; },
    ], projection);
  });

  const armsShape = propsShape(`
    <prop name="as" type="keyword" values="div, section, article" default="div">Element.</prop>
    <prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop>
    <state name="count" type="integer" value="1"></state>`, `
    <template $match>
      <section $when="as = 'section'" class="card own" style="color: red" from:data-tone="tone" class:hot="count > 1"><h2>{tone}</h2><slot></slot></section>
      <article $when="as = 'article' and count < 3" role="article" title="own"><button>{count}</button><slot></slot></article>
      <div $else tabindex="-1"><slot></slot><b>{count}</b></div>
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
        <a $when="as = 'a'" class="action" from:href="{ true: null, false: href }[concat(disabled)]" from:data-tags="tags" from:data-space-tags="spaceTags" $ref="control"><slot></slot></a>
        <button $else class="action" type="button" from:disabled="disabled" $ref="control"><slot></slot></button>
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
    <span class="badge" from:data-tone="tone"><b>{count}</b><i $if="open">{label}</i><slot name="icon">*</slot><slot></slot></span></template>`;
  const parent = (body: string, defs = ""): string => propsShape(`
    <prop name="flag" type="boolean" default="false">Flag.</prop>
    <state name="label" type="string" value="L"></state><state name="count" type="integer" value="1"></state>
    <state name="rows" type="list(integer)" value="[1, 2]"></state>
    <handler name="bump"><set name="count" expr:value="count + 1"></set></handler>${defs}`, body);

  it("invokes a compiled component like live lowering", async () => {
    await same([parent(`
      <section><x-badge tone="warn" count="3" open class="extra" title="t" from:label="label" class:hot="count > 1" style:color="flag ? 'red' : 'blue'"
        from:data-n="count" on:click="bump" $ref="badge">Text {label}<em slot="icon">{count}</em></x-badge></section>`), badge], [
      (host) => { host.state.label = "M"; },
      (host) => { host.root.querySelector("span").click(); },
      (host, update) => { (globalThis as any).directExtendLog.events.push(`ref ${host.refs.badge.className}`); update({ flag: true }); host.state.count = 5; },
    ]);
  });

  it("binds invocation props by their values, after their attribute text", async () => {
    await same([parent(`
      <section><x-badge from:count="label" from:tone="flag ? 'warn' : 'nope'" from:open="flag"></x-badge></section>`), badge], [
      (_host, update) => { update({ flag: true }); },
      (host) => { host.state.label = "7"; },
      (host, update) => { host.state.label = "x"; update({ flag: false }); },
    ]);
  });

  it("invokes components in regions and keyed rows like live lowering", async () => {
    await same([parent(`
      <section><x-badge $if="flag" from:count="count">if</x-badge>
        <ul><li $each="n of rows" $key="n" from:data-id="n"><x-badge from:count="n" from:label="label" on:click="bump" $ref="rows">{n}</x-badge></li></ul>
        <x-badge $each="n of rows" $key="n" from:count="n * 10"></x-badge></section>`), badge], [
      (_host, update) => { update({ flag: true }); },
      (host) => { host.state.rows = [2, 3, 1]; host.state.label = "z"; },
      (host) => { host.root.querySelectorAll("li span")[1].click(); (globalThis as any).directExtendLog.events.push(`refs ${host.refs.rows.length}`); },
      (host, update) => { host.state.rows = [3]; update({ flag: false }); },
    ]);
  });

  it("follows an invoked component's root switch with the parent's bindings", async () => {
    const action = `<template component="x-action" status="early" summary="Action.">
      <defs><prop name="as" type="keyword" values="button, a" default="button">As.</prop></defs>
      <template $match><a $when="as = 'a'" href="#"><slot></slot></a><button $else type="button"><slot></slot></button></template></template>`;
    await same([parent(`
      <section><x-action from:as="flag ? 'a' : 'button'" class:hot="count > 1" from:title="label" on:click="bump" $ref="action">Go {count}</x-action></section>`), action], [
      (host) => { host.root.querySelector("button").click(); },
      (_host, update) => { update({ flag: true }); },
      (host) => { host.root.querySelector("a").click(); (globalThis as any).directExtendLog.events.push(`ref ${host.refs.action.localName}`); },
      (host, update) => { host.state.label = "N"; update({ flag: false }); },
      (host) => { host.root.querySelector("button").click(); (globalThis as any).directExtendLog.events.push(`ref ${host.refs.action.localName}`); },
    ]);
  });

  it("renders a custom element no component claims as an element, like live", async () => {
    await same(parent(`
      <section><x-other class="o" from:title="label" class:hot="count > 1" from:data-n="count" on:click="bump" $ref="other"><b>{label}</b><x-deeper $if="flag">{count}</x-deeper></x-other></section>`), [
      (host) => { host.root.querySelector("x-other").click(); (globalThis as any).directExtendLog.events.push(`ref ${host.refs.other.localName}`); },
      (host, update) => { host.state.label = "Q"; update({ flag: true }); },
    ]);
  });

  it("retains nothing from rows it removed: their listeners and invoked components", async () => {
    const compiled = graph([parent(`
      <section><ul><li $each="n of rows" $key="n" from:data-id="n" on:click="bump"><x-badge from:count="n" on:click="bump">{n}</x-badge></li></ul></section>`), badge]);
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

  it("observes each document once however many compiled roots it holds", async () => {
    const action = `<template component="x-action" status="early" summary="Action.">
      <defs><prop name="as" type="keyword" values="button, a" default="button">As.</prop></defs>
      <template $match><a $when="as = 'a'" href="#"><slot></slot></a><button $else type="button"><slot></slot></button></template></template>`;
    const compiled = graph([parent(`
      <section><x-badge $each="n of rows" $key="n" from:count="n"><x-action from:as="flag ? 'a' : 'button'">{n}</x-action></x-badge></section>`), badge, action]);
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
      <template $match><article $when="as = 'article'" class="card"><slot name="head"></slot><slot></slot></article>
        <section $else class="card" from:data-tone="tone"><slot name="head"></slot><slot></slot></section></template></template>`;
    const panel = propsShape(`
      <prop name="title" type="string" required>Title.</prop>
      <prop name="kind" type="keyword" values="section, article" default="section">Kind.</prop>
      <state name="count" type="integer" value="1"></state>
      <handler name="bump"><set name="count" expr:value="count + 1"></set></handler>`, `
      <x-card tone="warn" class="panel" from:as="kind" on:click="bump"><h2 slot="head">{title}</h2><p>{count} <slot></slot></p></x-card>`);
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
      (host) => { host.state.rows = [...host.state.rows].reverse(); },
      (host) => { host.state.rows = []; },
      (host) => { host.state.rows = [{ id: 5, label: "five" }]; },
    ];
    for (const body of [
      `<section><p></p><dl><template $each="row of rows" $key="row.id"><dt from:data-id="row.id">{row.label}</dt><dd $if="row.id = selected">sel</dd>text</template></dl></section>`,
      `<section><p></p><dl><template $each="row of rows"><dt from:data-id="row.id">{row.label}</dt><dd>{loop.index}</dd></template></dl></section>`,
      `<section><p></p><dl><template $each="row, i of rows" $key="row.id"><dt from:data-id="row.id">{i}</dt><dd>{loop.count}</dd></template></dl></section>`,
    ]) {
      await same(component(rows, body), steps);
    }
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
