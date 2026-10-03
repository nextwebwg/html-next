import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    const server = compile(source, { filename: "XCard.svelte", generate: "server" });
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(outDirectory, "node_modules"), "dir");
    const serverPath = join(outDirectory, "server.mjs");
    await build({
      stdin: { contents: server.js.code, resolveDir: join(outDirectory, "svelte"), sourcefile: "XCard.js" },
      outfile: serverPath,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      loader: { ".css": "empty" },
    });
    const module = await import(pathToFileURL(serverPath).href) as { default: Component<{ label?: string; id?: string; class?: string }> };
    const html = render(module.default, { props: { label: "Hello", id: "case", class: "outside" } }).body;
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
