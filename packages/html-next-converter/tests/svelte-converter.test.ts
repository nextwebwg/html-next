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

import { convertComponents } from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function serverHtml(outDirectory: string, name: string, source: string, props: Record<string, unknown> = {}): Promise<string> {
  const server = compile(source, { filename: `${name}.svelte`, generate: "server" });
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(outDirectory, "node_modules"), "dir");
  const serverPath = join(outDirectory, "server.mjs");
  await build({
    stdin: { contents: server.js.code, resolveDir: join(outDirectory, "svelte"), sourcefile: `${name}.js` },
    outfile: serverPath, bundle: true, packages: "external", platform: "node", format: "esm",
    loader: { ".css": "empty" },
  });
  const module = await import(pathToFileURL(serverPath).href) as { default: Component<Record<string, unknown>> };
  return render(module.default, { props }).body;
}

it("converts a simple component to compilable Svelte 5 in both graph modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-converter-"));
  temporary.push(root);
  await writeFile(join(root, "card.html"), `<template component="x-card" status="early" summary="Card.">
    <props><prop name="label" type="string" default="Ready">Label.</prop></props>
    <article class="card" from:aria-label="label"><slot></slot></article>
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
    assert.match(source, /data-component="x-card"/);
    compile(source, { filename: "XCard.svelte", generate: "client" });
    const html = await serverHtml(outDirectory, "XCard", source, { label: "Hello", id: "case", class: "outside" });
    assert.match(html, /<article[^>]*data-component="x-card"/);
    assert.match(html, /aria-label="Hello"/);
    assert.match(html, /id="case"/);
    assert.match(html, /class="card outside"/);
  }
});

it("lowers state, computed text, and declarative handlers to Svelte runes", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-reactive-"));
  temporary.push(root);
  await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
    <defs>
      <state name="count" type="integer" value="0"></state>
      <computed name="double" from="count * 2"></computed>
      <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
    </defs>
    <button on:click="increment" from:aria-label="double" $value="count"></button>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["counter.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /\$state\(0\)/);
  assert.match(source, /\$derived\(count \* 2\)/);
  assert.match(source, /onclick=\{increment\}/);
  compile(source, { filename: "XCounter.svelte", generate: "client" });
  compile(source, { filename: "XCounter.svelte", generate: "server" });
});

it("lowers conditional and aliased child regions without wrapper elements", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-structure-"));
  temporary.push(root);
  await writeFile(join(root, "panel.html"), `<template component="x-panel" status="early" summary="Panel.">
    <defs><state name="open" type="boolean" value="true"></state></defs>
    <div><span $if="open">Shown</span><template $with="{ name: 'Ada' } as user"><b $value="user.name"></b></template></div>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["panel.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /\{#if open\}/);
  assert.match(source, /\{@const user =/);
  compile(source, { filename: "XPanel.svelte", generate: "client" });
  compile(source, { filename: "XPanel.svelte", generate: "server" });
});

it("lowers a match inside table markup to one selected native row", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-match-"));
  temporary.push(root);
  await writeFile(join(root, "table.html"), `<template component="x-table" status="early" summary="Table.">
    <props><prop name="status" type="keyword" values="ok, bad" default="ok">Status.</prop></props>
    <table from:data-status="status"><tbody><template $match="status as s"><tr $when="s = 'ok'"><td>OK</td></tr><tr $else><td>No</td></tr></template></tbody></table>
  </template>`);
  const outDirectory = join(root, "out");
  const manifest = await convertComponents({ mode: "library", target: "svelte", root, outDirectory, entries: ["table.html"] });
  const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
  assert.match(source, /\{#if s === "ok"\}/);
  compile(source, { filename: "XTable.svelte", generate: "client" });
  compile(source, { filename: "XTable.svelte", generate: "server" });
});

it("renders sorted, filtered, limited rows with loop metadata and no wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "html-next-svelte-each-"));
  temporary.push(root);
  await writeFile(join(root, "list.html"), `<template component="x-list" status="early" summary="List.">
    <ul><li $each="n, i of [3, 1, 2, 5]" $where="n < 5" $sort="n" $limit="3"
      from:data-i="i" from:data-last="loop.last" from:data-count="loop.count" $value="n"></li></ul>
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
    <ul><li $each="row of rows" $value="row"></li></ul>
  </template>`);
  await writeFile(join(root, "duplicate.html"), `<template component="x-duplicate" status="early" summary="Duplicate list.">
    <defs><state name="rows" type="list(string)" value="['a', 'a']"></state></defs>
    <ul><li $each="row of rows" $key="row" $value="row"></li></ul>
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
  </defs><output from:data-label="label" $value="amount + 1"></output></template>`);
  for (const mode of ["application", "library"] as const) {
    const outDirectory = join(root, mode);
    const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory, entries: ["components/**"] });
    assert.deepEqual(manifest.components.map((component) => component.artifact), [
      "svelte/components/nested/XChild.svelte", "svelte/components/XParent.svelte",
    ]);
    const parent = await readFile(join(outDirectory, "svelte/components/XParent.svelte"), "utf8");
    assert.match(parent, /import XChild from "\.\/nested\/XChild\.svelte"/);
    assert.match(parent, /amount=\{2\}/);
    assert.match(parent, /label=\{"Ready"\}/);
    compile(parent, { filename: "XParent.svelte", generate: "client" });
    const entry = join(outDirectory, "server-entry.ts");
    await writeFile(entry, `import { render } from "svelte/server";
import XParent from "./svelte/components/XParent.svelte";
export const html = render(XParent).body;`);
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(outDirectory, "node_modules"), "dir");
    const outfile = join(outDirectory, "server.mjs");
    await build({ entryPoints: [entry], outfile, bundle: true, packages: "external", platform: "node", format: "esm",
      loader: { ".css": "empty" }, plugins: [{ name: "svelte-server", setup(plugin) {
        plugin.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
          contents: compile(await readFile(path, "utf8"), { filename: path, generate: "server" }).js.code,
          loader: "js",
          resolveDir: join(path, ".."),
        }));
      } }] });
    const rendered = await import(pathToFileURL(outfile).href) as { html: string };
    assert.match(rendered.html, /<output[^>]*data-label="Ready"[^>]*>3<\/output>/);
  }
});
