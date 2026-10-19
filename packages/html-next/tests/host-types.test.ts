import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript-compiler";
import { afterAll, beforeAll, describe, it } from "vitest";

import { writeHostDeclarations } from "../src/host-declarations.js";
import { loadNodeComponents } from "../src/node-loader.js";
import { generateHostTypes } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const checkout = `<link rel="component" href="./line-item.html">
<template component="checkout-form" controller="./checkout-form.ts">
  <defs>
    <prop name="pk" type="string" required>The publishable key.</prop>
    <prop name="currency" type="string" default="USD">The currency.</prop>
    <prop name="limit" type="number">The most lines.</prop>
    <state name="lines" type="list(object({ sku: string, qty: integer }))" value="[]"></state>
    <state name="note" type="string" value=""></state>
    <computed name="count" type="integer" from="$lines.length"></computed>
    <context name="theme" from="app-shell" as="theme"></context>
    <data name="rates" src="/api/rates" type="object({ usd: number })"></data>
    <event name="paid" type="object({ id: string })"></event>
    <event name="cleared"></event>
    <request name="card-token" type="object({ amount: number })" returns="string"></request>
    <request name="ping"></request>
    <script name="stripe" src="https://js.stripe.com/v3/" loading="manual"></script>
  </defs>
  <form>
    <input $ref="email">
    <p $if="$note" $ref="hint">{$note}</p>
    <ul><li $each="line of $lines" $ref="rows">{$line.sku}</li></ul>
    <line-item $ref="item"></line-item>
    <slot name="footer"></slot>
  </form>
</template>`;

const lineItem = `<template component="line-item">
  <defs>
    <event name="remove" type="object({ sku: string })"></event>
    <request name="price" type="string" returns="number"></request>
  </defs>
  <article>An item</article>
</template>`;

const shell = `<link rel="component" href="./checkout-form.html">
<template component="app-shell">
  <defs><state name="theme" type="keyword" values="light, dark" value="light"></state></defs>
  <main><checkout-form pk="pk_test"></checkout-form></main>
</template>`;

const typedController = `import type { Host } from "./checkout-form.host.js";

export default function controller(host: Host) {
  const key: string = host.props.pk.value;
  const currency: string = host.props.currency.value;
  const limit: number | null = host.props.limit.value;
  host.state.lines.push({ sku: "A1", qty: 2 });
  host.state.note = "Added";
  const count: number = host.state.count;
  const theme: "light" | "dark" = host.state.theme;
  const usd: number | undefined = host.data.rates.value?.usd;
  const pending: boolean = host.data.rates.pending || host.scripts.stripe.pending;
  host.refs.email.value = key;
  host.refs.hint?.append(currency);
  const rows: readonly HTMLLIElement[] = host.refs.rows;
  const item: HTMLElement = host.refs.item;
  const footer: readonly Element[] = host.slots.footer;
  void host.scripts.stripe.load().then(() => host.scripts.stripe.ready);
  host.on("connect", () => () => {});
  host.on("paid", (event) => { const id: string = event.detail.id; void id; });
  host.on("price", (event) => event.respondWith(Promise.resolve(limit ?? 0)));
  host.on("remove", (event) => { const sku: string = event.detail.sku; void sku; });
  host.on("click", (event) => { const x: number = event.clientX; void x; });
  host.on("html-next:custom", (event) => { void event.type; });
  host.dispatch("paid", { id: "ch_1" });
  host.dispatch("cleared");
  const answer: Promise<string | null> = host.request("card-token", { amount: count }, { signal: new AbortController().signal });
  const ping: Promise<unknown> = host.request("ping");
  const answered: boolean = host.hasResponder("card-token");
  const doubled = host.computed(() => count * 2);
  const local = host.signal(0);
  local.update((value) => value + doubled.get());
  host.effect(() => { void [theme, usd, pending, rows, item, footer, answer, ping, answered]; });
}
`;

const jsController = `/** @type {import("./checkout-form.host.js").Controller} */
export default function controller(host) {
  host.state.note = host.props.pk.value;
  host.refs.email.focus();
  host.dispatch("paid", { id: "ch_1" });
  return host.on("disconnect", () => {});
}
`;

let directory: string;

/** TypeScript's errors for one file of the fixture project, as flattened messages. */
function typeErrors(file: string, source: string): string[] {
  const path = join(directory, file);
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [],
    exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, allowJs: true, checkJs: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = (name) => name === path ? source : read(name);
  return ts.getPreEmitDiagnostics(ts.createProgram([path], options, host))
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("typed controller hosts", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-host-types-"));
    await writeFile(join(directory, "package.json"), '{ "type": "module" }\n');
    await writeFile(join(directory, "checkout-form.html"), checkout);
    await writeFile(join(directory, "line-item.html"), lineItem);
    await writeFile(join(directory, "app-shell.html"), shell);
    const graph = await loadNodeComponents([pathToFileURL(join(directory, "app-shell.html")).href],
      { baseURL: pathToFileURL(`${directory}/`).href });
    // Only a component with a controller has a host to type.
    assert.deepEqual(await writeHostDeclarations(graph), [join(directory, "checkout-form.host.d.ts")]);
    await writeFile(join(directory, "x-module.host.d.ts"), generateHostTypes(parseComponent('<template component="x-module" module="./module.js"><defs><prop name="title" type="string" required>Title.</prop><state name="count" type="number" value="0"></state></defs><section></section></template>')));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("types a TypeScript controller's host from its <defs>", () => {
    assert.deepEqual(typeErrors("checkout-form.ts", typedController), []);
  });

  it("types a JavaScript controller through JSDoc", () => {
    assert.deepEqual(typeErrors("checkout-form.js", jsController), []);
  });

  it("types a named connect's signal, mutable state and readonly props", () => {
    const source = 'import type { Connect } from "./x-module.host.js"; export const connect: Connect = (host, { signal }) => { const abort: AbortSignal = signal; host.state.count += 1; const title: string = host.props.title.value; return () => { void [abort, title]; }; };';
    assert.deepEqual(typeErrors("module.ts", source), []);
    assert.match(typeErrors("module.ts", source.replace('host.state.count += 1;', 'host.state.count = "wrong";'))[0]!, /Type 'string' is not assignable to type 'number'/);
    assert.match(typeErrors("module.ts", source.replace('host.state.count += 1;', 'host.props.title.value = "wrong";'))[0]!, /read-only/);
  });

  it("rejects a misspelled state name", () => {
    const errors = typeErrors("checkout-form.ts", typedController.replace("host.state.note = ", "host.state.notes = "));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Property 'notes' does not exist on type .*Did you mean 'note'\?/s);
  });

  it("rejects a wrong request detail", () => {
    const errors = typeErrors("checkout-form.ts", typedController.replace("{ amount: count }", "{ amount: String(count) }"));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Type 'string' is not assignable to type 'number'/);
  });

  it("rejects an undeclared script name", () => {
    const errors = typeErrors("checkout-form.ts", typedController.replace("host.scripts.stripe.load()", "host.scripts.paypal.load()"));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Property 'paypal' does not exist on type '\{ readonly stripe: HostScript; \}'/);
  });

  it("rejects a wrong dispatch detail type", () => {
    const errors = typeErrors("checkout-form.js", jsController.replace('{ id: "ch_1" }', "{ id: 1 }"));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Type 'number' is not assignable to type 'string'/);
  });

  it("rejects writes to computed state and requests it doesn't declare", () => {
    const errors = typeErrors("checkout-form.ts", typedController
      .replace("const count: number = host.state.count;", "const count: number = host.state.count = 1;")
      .replace('host.hasResponder("card-token")', 'host.hasResponder("card")'));
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /Cannot assign to 'count' because it is a read-only property/);
    assert.match(errors[1]!, /Argument of type '"card"' is not assignable to parameter of type '"card-token" \| "ping"'/);
  });

  it("leaves a declaration it did not generate in place", async () => {
    const path = join(directory, "checkout-form.host.d.ts");
    const generated = await readFile(path, "utf8");
    await writeFile(path, "export type Host = unknown;\n");
    const graph = await loadNodeComponents([pathToFileURL(join(directory, "checkout-form.html")).href],
      { baseURL: pathToFileURL(`${directory}/`).href });
    await assert.rejects(writeHostDeclarations(graph), /will not overwrite an authored declaration/);
    await writeFile(path, generated);
  });
});
