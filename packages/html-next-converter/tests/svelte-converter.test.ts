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
