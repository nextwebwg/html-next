import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, it } from "vitest";
import { compile } from "svelte/compiler";
import type { Component } from "svelte";
import { render } from "svelte/server";
import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";

import { convertComponents } from "../src/index.js";
import { formattingSource } from "../../html-next/tests/formatting-fixture.js";

const temporary: string[] = [];
let serverSerial = 0;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function serverComponent(outDirectory: string, name: string, source: string): Promise<Component<Record<string, unknown>>> {
  const server = compile(source, { filename: `${name}.svelte`, generate: "server" });
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(outDirectory, "node_modules"), "dir")
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const serverPath = join(outDirectory, `server-${serverSerial++}.mjs`);
  await build({
    stdin: { contents: server.js.code, resolveDir: join(outDirectory, "svelte"), sourcefile: `${name}.js` },
    outfile: serverPath, bundle: true, packages: "external", platform: "node", format: "esm",
    loader: { ".css": "empty" }, plugins: [sveltePlugin("server")],
  });
  const module = await import(pathToFileURL(serverPath).href) as { default: Component<Record<string, unknown>> };
  return module.default;
}

async function serverHtml(outDirectory: string, name: string, source: string, props: Record<string, unknown> = {}): Promise<string> {
  return render(await serverComponent(outDirectory, name, source), { props }).body;
}

it("converts a simple component to compilable Svelte 5 in both graph modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-converter-"));
  temporary.push(root);
  await writeFile(join(root, "card.html"), `<template component="x-card" status="early" summary="Card.">
    <props><prop name="label" type="string" default="Ready">Label.</prop></props>
    <article class="card" from:aria-label="$label"><slot></slot></article>
    <style>:host { display: block; }</style>
  </template>`);

  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["card.html"] });
    assert.equal(manifest.target, "svelte");
    assert.equal(manifest.components[0]?.artifact, "svelte/XCard.svelte");
    assert.deepEqual(manifest.package.peerDependencies, { svelte: "^5.57.1" });
    const source = await readFile(join(outDirectory, "svelte/XCard.svelte"), "utf8");
    assert.doesNotMatch(source, /@nextwebwg\/html-next/);
    assert.doesNotMatch(source, /createFormatValue|const formatValue/);
    compile(source, { filename: "XCard.svelte", generate: "client" });
    const html = await serverHtml(outDirectory, "XCard", source, { label: "Hello", id: "case", class: "outside" });
    assert.match(html, /<article[^>]*data-component="x-card"/);
    assert.match(html, /aria-label="Hello"/);
    assert.match(html, /id="case"/);
    assert.match(html, /class="card outside"/);
    const defaulted = await serverHtml(outDirectory, "XCard", source);
    assert.match(defaulted, /aria-label="Ready"/);
    assert.doesNotMatch(defaulted, /data-label=/);
  }
});

it("renders shared inline Intl expressions in public Svelte SSR output", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-formatting-"));
  temporary.push(root);
  await writeFile(join(root, "formatting.html"), formattingSource);
  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["formatting.html"] });
    const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    const html = await serverHtml(outDirectory, "XFormatting", source);
    assert.match(html, /Total: .*\$12\.50.* due\./);
    assert.match(html, /aria-label="\$12\.50"/);
    assert.doesNotMatch(html, /\{format\(|Symbol\(html-next.invalid-result\)/);
  }
});

it("shares computed-only Intl formatters across SSR instances without authored helper-name collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-format-cache-"));
  temporary.push(root);
  await writeFile(join(root, "formatting.html"), `<template component="x-format-cache"><defs>
    <state name="formatValue" type="number" value="12.5"></state>
    <state name="createFormatValue" type="number" value="2"></state>
    <computed name="label" from="format($formatValue + $createFormatValue, 'number', {}, 'en-US')"></computed>
    </defs><output $value="$label"></output></template>`);
  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["formatting.html"] });
    const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    const Component = await serverComponent(outDirectory, "XFormatCache", source);
    const original = Intl.NumberFormat;
    let constructions = 0;
    Intl.NumberFormat = new Proxy(original, { construct(target, args) { constructions++; return Reflect.construct(target, args); } });
    try {
      assert.match(render(Component).body, />14\.5<\/output>/);
      assert.match(render(Component).body, />14\.5<\/output>/);
      assert.equal(constructions, 1, "identical options reuse one formatter across component instances");
    } finally { Intl.NumberFormat = original; }
  }
});

it("preserves a declared __proto__ prop as an own value in public SSR output", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-proto-prop-"));
  temporary.push(root);
  await writeFile(join(root, "proto.html"), `<template component="x-proto-prop"><defs>
    <prop name="__proto__" type="string" default="Ready">Label.</prop>
    </defs><output $value="$__proto__"></output></template>
    <template component="x-proto-owner"><section>
      <x-proto-prop __proto__="Provided"></x-proto-prop>
      <x-proto-prop from:__proto__="'Bound'"></x-proto-prop>
    </section></template>`);
  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["proto.html"] });
    const component = manifest.components.find((component) => component.tag === "x-proto-prop")!;
    const source = await readFile(join(outDirectory, component.artifact), "utf8");
    const Component = await serverComponent(outDirectory, "XProtoProp", source);
    for (const [input, expected] of [[undefined, "Ready"], ["Provided", "Provided"], [42, "Ready"]] as const) {
      assert.match(render(Component, { props: Object.fromEntries([["__proto__", input]]) }).body, new RegExp(`>${expected}</output>`));
    }
    const owner = manifest.components.find((component) => component.tag === "x-proto-owner")!;
    const ownerSource = await readFile(join(outDirectory, owner.artifact), "utf8");
    assert.match(await serverHtml(outDirectory, "XProtoOwner", ownerSource), />Provided<\/output>.*>Bound<\/output>/s);
  }
});

it("preserves escaped literal braces inside rich bound-select option text", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-option-literal-"));
  temporary.push(root);
  await writeFile(join(root, "option.html"), `<template component="x-option-literal"><defs>
    <state name="choice" type="string" value="{Ready}"></state></defs>
    <select bind:value="choice"><option><span>\\{Ready}</span></option></select></template>`);
  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["option.html"] });
    const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    compile(source, { filename: "XOptionLiteral.svelte", generate: "client" });
    assert.match(await serverHtml(outDirectory, "XOptionLiteral", source), /(?:\{Ready\}|&#123;Ready&#125;)/);
  }
});

it("lowers state, computed text, and declarative handlers to Svelte runes", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-reactive-"));
  temporary.push(root);
  await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
    <defs>
      <state name="count" type="integer" value="0"></state>
      <computed name="double" from="$count * 2"></computed>
      <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
    </defs>
    <button on:click="increment" from:aria-label="$double" $value="$count"></button>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["counter.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /\$state<number>\(0\)/);
  assert.match(source, /cycleCheckedComputed/);
  assert.match(source, /onclick=\{increment\}/);
  compile(source, { filename: "XCounter.svelte", generate: "client" });
  compile(source, { filename: "XCounter.svelte", generate: "server" });
});

it("lowers conditional and aliased child regions without wrapper elements", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-structure-"));
  temporary.push(root);
  await writeFile(join(root, "panel.html"), `<template component="x-panel" status="early" summary="Panel.">
    <defs><state name="open" type="boolean" value="true"></state></defs>
    <div><span $if="$open">Shown</span><template $with="{ name: 'Ada' } as user"><b $value="$user.name"></b></template></div>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["panel.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(await serverHtml(outDirectory, "XPanel", source), /<span>Shown<\/span>/);
  assert.match(source, /\{@const user =/);
  compile(source, { filename: "XPanel.svelte", generate: "client" });
  compile(source, { filename: "XPanel.svelte", generate: "server" });
});

it("lowers a match inside table markup to one selected native row", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-match-"));
  temporary.push(root);
  await writeFile(join(root, "table.html"), `<template component="x-table" status="early" summary="Table.">
    <props><prop name="status" type="keyword" values="ok, bad" default="ok">Status.</prop></props>
    <table from:data-status="$status"><tbody><template $match="$status as s"><tr $when="$s = 'ok'"><td>OK</td></tr><tr $else><td>No</td></tr></template></tbody></table>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["table.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  const html = await serverHtml(outDirectory, "XTable", source);
  assert.match(html, /<td>OK<\/td>/);
  assert.doesNotMatch(html, /<td>No<\/td>/);
  compile(source, { filename: "XTable.svelte", generate: "client" });
  compile(source, { filename: "XTable.svelte", generate: "server" });
});

it("renders sorted, filtered, limited rows with loop metadata and no wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-each-"));
  temporary.push(root);
  await writeFile(join(root, "list.html"), `<template component="x-list" status="early" summary="List.">
    <ul><li $each="n, i of [3, 1, 2, 5]" $where="$n < 5" $sort="n" $limit="3"
      from:data-i="$i" from:data-last="$loop.last" from:data-count="$loop.count" $value="$n"></li></ul>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["list.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /\{#each /);
  compile(source, { filename: "XList.svelte", generate: "client" });
  const html = await serverHtml(outDirectory, "XList", source);
  assert.deepEqual([...html.matchAll(/<li ([^>]*)>([^<]*)<\/li>/g)].map((match) => [
    /data-i="([^"]*)"/.exec(match[1]!)?.[1],
    /data-count="([^"]*)"/.exec(match[1]!)?.[1],
    /data-last="([^"]*)"/.exec(match[1]!)?.[1] ?? null,
    match[2],
  ]), [["0", "3", null, "1"], ["1", "3", null, "2"], ["2", "3", "", "3"]]);
});

it("treats an absent list as empty and reports duplicate keyed rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-list-cases-"));
  temporary.push(root);
  await writeFile(join(root, "empty.html"), `<template component="x-empty" status="early" summary="Empty list.">
    <defs><state name="rows" type="list(string)"></state></defs>
    <ul><li $each="row of $rows" $value="$row"></li></ul>
  </template>`);
  await writeFile(join(root, "duplicate.html"), `<template component="x-duplicate" status="early" summary="Duplicate list.">
    <defs><state name="rows" type="list(string)" value="['a', 'a']"></state></defs>
    <ul><li $each="row of $rows" $key="$row" $value="$row"></li></ul>
  </template>`);
  for (const [name, expected] of [["empty", "no rows"], ["duplicate", "HR004"]] as const) {
    const outDirectory = join(root, `out-${name}`);
    const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: [`${name}.html`] });
    const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    compile(source, { filename: `${name}.svelte`, generate: "client" });
    if (expected === "no rows") assert.doesNotMatch(await serverHtml(outDirectory, `X${name}`, source), /<li/);
    else await assert.rejects(serverHtml(outDirectory, `X${name}`, source), /HR004/);
  }
});

it("converts nested-folder component graphs and parses child HTML literals by their declared prop types", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-graph-"));
  temporary.push(root);
  await mkdir(join(root, "components", "nested"), { recursive: true });
  await writeFile(join(root, "components", "parent.html"), `<template component="x-parent" status="early" summary="Parent.">
    <div><x-child amount="2" from:label="'Ready'"></x-child></div>
  </template>`);
  await writeFile(join(root, "components", "nested", "child.html"), `<template component="x-child" status="early" summary="Child."><defs>
    <prop name="amount" type="number" required>Amount.</prop><prop name="label" type="string">Label.</prop>
  </defs><output from:data-label="$label" $value="$amount + 1"></output></template>`);
  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["components/**"] });
    assert.deepEqual(manifest.components.map((component) => component.artifact), [
      "svelte/components/nested/XChild.svelte", "svelte/components/XParent.svelte",
    ]);
    const parent = await readFile(join(outDirectory, "svelte/components/XParent.svelte"), "utf8");
    assert.match(parent, /import XChild from '\.\/nested\/XChild\.svelte'/);
    assert.match(parent, /amount=\{2\}/);
    assert.match(parent, /label="Ready"|label=\{"Ready"\}/);
    compile(parent, { filename: "XParent.svelte", generate: "client" });
    const entry = join(outDirectory, "server-entry.ts");
    await writeFile(entry, `import { render } from "svelte/server";
import XParent from "./svelte/components/XParent.svelte";
export const html = render(XParent).body;`);
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(outDirectory, "node_modules"), "dir");
    const outfile = join(outDirectory, "server.mjs");
    await build({ entryPoints: [entry], outfile, bundle: true, packages: "external", platform: "node", format: "esm",
      loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
    const rendered = await import(pathToFileURL(outfile).href) as { html: string };
    assert.match(rendered.html, /<output[^>]*data-label="Ready"[^>]*>3<\/output>/);
  }
});

it("checks a prop against the type selected by another prop", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-selected-prop-"));
  temporary.push(root);
  await writeFile(join(root, "selected.html"), `<template component="x-selected" status="early" summary="Selected value."><defs>
    <prop name="kind" type="keyword" values="text, number" default="text">Kind.</prop>
    <prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
  </defs><output from:data-kind="$kind" $value="$value"></output></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["selected.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  compile(source, { filename: "XSelected.svelte", generate: "client" });
  assert.match(await serverHtml(outDirectory, "XSelected", source, { kind: "number", value: 2 }), /<output[^>]*>2<\/output>/);
  assert.match(await serverHtml(outDirectory, "XSelected", source, { value: "Ready" }), /<output[^>]*>Ready<\/output>/);
});

it("initializes a state-selected prop after seeding the selector state", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-state-selected-"));
  temporary.push(root);
  await writeFile(join(root, "selected.html"), `<template component="x-selected" status="early" summary="Selected value."><defs>
    <state name="kind" type="keyword" values="text, number" value="text"></state>
    <prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
  </defs><output $value="$value"></output></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["selected.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  compile(source, { filename: "XSelected.svelte", generate: "client" });
  const html = await serverHtml(outDirectory, "XSelected", source, { value: "Ready" });
  assert.match(html, /<output[^>]*>Ready<\/output>/);
});

it("sanitizes dynamic HTML on the server with the shared safe-default policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-html-"));
  temporary.push(root);
  await writeFile(join(root, "body.html"), `<template component="x-body" status="early" summary="Safe body."><defs>
    <prop name="body" type="string">Body.</prop>
  </defs><div $html="$body"></div></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["body.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /retainedSanitizedHtml/);
  assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "svelte/html.ts"));
  assert.deepEqual(manifest.package.dependencies, { parse5: "^8.0.1" });
  compile(source, { filename: "XBody.svelte", generate: "client" });
  const html = await serverHtml(outDirectory, "XBody", source, {
    body: `<b>OK</b><script>bad()</script><img src="x" onerror="bad()"><a href="javascript:bad()">Link</a>`,
  });
  const fragment = parseFragment(html);
  const div = fragment.childNodes.find((node) => "tagName" in node && node.tagName === "div");
  assert.ok(div);
  const content = serialize(div as DefaultTreeAdapterTypes.ParentNode);
  assert.match(content, /<b>OK<\/b>/);
  assert.doesNotMatch(content, /<script|onerror|javascript:/);
});

it("keeps each row's sanitized HTML boundary local to that row", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-row-html-"));
  temporary.push(root);
  await writeFile(join(root, "rows.html"), `<template component="x-rows" status="early" summary="HTML rows."><defs>
    <state name="rows" type="list(string)" value="['&lt;b&gt;A&lt;/b&gt;', '&lt;i&gt;B&lt;/i&gt;']"></state>
  </defs><ul><li $each="row of $rows" $html="$row"></li></ul></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["rows.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /\{#each [^\n]*? as \{[^}]*\}[^}]*\}\{@const htmlSite0 = retainedSanitizedHtml\(\)\}/);
  compile(source, { filename: "XRows.svelte", generate: "client" });
  const html = (await serverHtml(outDirectory, "XRows", source)).replace(/<!--[\s\S]*?-->/g, "");
  assert.match(html, /<li[^>]*><b>A<\/b><\/li>.*<li[^>]*><i>B<\/i><\/li>/);
});

it.each([
  { name: "generic bind", defs: '<state name="value" value="Ready"></state>',
    root: '<div><output bind:value="value"></output></div>', expected: /<output[^>]*value="Ready"/ },
  { name: "pending data", defs: '<data name="feed"></data><computed name="pending" from="$feed.pending"></computed>',
    root: '<div $value="$pending"></div>', expected: />true</ },
  { name: "keyword-named data", defs: '<data name="default"></data><state name="htmlNextData0" value="kept"></state>',
    root: '<div><i $value="$default.pending"></i><b $value="$htmlNextData0"></b></div>', expected: /<i>true<\/i><b>kept<\/b>/ },
  { name: "bindings with generated-name collisions", defs: '<state name="boundAttribute" value="kept"></state><state name="boundValue" value="Ready"></state>',
    root: '<div><output bind:value="boundValue"></output><b $value="$boundAttribute"></b></div>', expected: /<output[^>]*value="Ready"[^>]*><\/output><b>kept<\/b>/ },
  { name: "nullable reflected properties", defs: '<state name="record" type="object" value="{}"></state>',
    root: '<button .title="null" .name="$record.missing"></button>', expected: /title="null"[^>]*name="undefined"/ },
  { name: "initially invalid reflected string property", defs: '<state name="count" type="number" value="0"></state>',
    root: '<button title="Authored" .title="40px / $count"></button>', expected: /<button[^>]*title="Authored"/ },
  { name: "initially invalid reflected boolean property", defs: '<state name="count" type="number" value="0"></state>',
    root: '<button disabled .disabled="40px / $count"></button>', expected: /<button[^>]* disabled/ },
  { name: "initially invalid property with incoming attribute", defs: '<state name="count" type="number" value="0"></state>',
    root: '<button title="Authored" .title="40px / $count"></button>', props: { title: "Incoming" }, expected: /<button[^>]*title="Incoming"/ },
  { name: "initially invalid control property", defs: '<state name="count" type="number" value="0"></state>',
    root: '<input value="Authored" .value="40px / $count">', expected: /<input[^>]*value="Authored"/ },
  { name: "native scroll property", defs: '', root: '<div .scrollTop="10"></div>', expected: /<div/ },
  { name: "native property", defs: '', root: '<button .disabled="true"></button>', expected: /<button[^>]* disabled/ },
])("renders $name in Svelte server output", async (testCase) => {
  const { defs, root: markup, expected } = testCase;
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-shared-"));
  temporary.push(root);
  await writeFile(join(root, "case.html"), `<template component="x-case" status="early" summary="Shared behavior."><defs>${defs}</defs>${markup}</template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["case.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  compile(source, { filename: "XCase.svelte", generate: "client" });
  const html = (await serverHtml(outDirectory, "XCase", source, "props" in testCase ? testCase.props : {})).replace(/<!--[\s\S]*?-->/g, "");
  assert.match(html, expected);
});

it("emits a resource helper only for sourced data and keeps SSR pending without requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-resource-"));
  temporary.push(root);
  await writeFile(join(root, "case.html"), `<template component="x-case" status="early" summary="Resource output."><defs>
    <data name="feed" src="/api/feed" type="object({ label: string })"></data>
    </defs><output $value="$feed.pending"></output></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["case.html"] });
  assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "svelte/data.svelte.ts"));
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  compile(source, { filename: "XCase.svelte", generate: "client" });
  assert.match(await serverHtml(outDirectory, "XCase", source), /<output[^>]*>true<\/output>/);
});

it("keeps keyword declarations, handler event names, and reserved local aliases compilable", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-identifiers-"));
  temporary.push(root);
  await writeFile(join(root, "case.html"), `<template component="x-names" status="early" summary="Authored names."><defs>
    <state name="class" type="number" value="1"></state><state name="event" type="number" value="2"></state>
    <state name="rootElement" type="number" value="3"></state><computed name="checkedProps" from="$class + $event + $rootElement"></computed>
    <handler name="switch"><set name="class" expr:value="$class + 1"></set><set name="event" expr:value="$event + 1"></set></handler>
    </defs><button on:click="switch"><template $with="{ total: $checkedProps } as default"><span $value="$default.total"></span></template>
      <template $match="$class as class"><b $when="$class = 1">First</b><b $else>Next</b></template></button></template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["case.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  compile(source, { filename: "XNames.svelte", generate: "client" });
  const html = (await serverHtml(outDirectory, "XNames", source)).replace(/<!--[\s\S]*?-->/g, "");
  assert.match(html, /<span>6<\/span>/);
  assert.match(html, /<b>First<\/b>/);
});
