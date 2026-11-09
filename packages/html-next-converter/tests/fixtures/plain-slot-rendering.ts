import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";

import { dynamicPlainSource, plainSlotFiles, plainSlotInvocations, repeatedPlainSource } from "../../../html-next/tests/fixtures/plain-slot-ownership.js";
import { convertComponents } from "../../src/index.js";

const conditionalSlots = [
  ["direct", '<slot $if="$open"></slot>', "true"],
  ["ancestor", '<div $if="$open"><slot></slot></div>', "true"],
  ["match", '<template $match><p $when="$open"><slot></slot></p><i $else>Closed</i></template>', "true"],
  ["closed", '<slot $if="$open"></slot>', "false"],
  ["lazy", '<slot $if="$open"></slot>', "true"],
].map(([name, outlet, initial]) => `<template component="x-single-${name}"><defs>
<state name="open" type="boolean" value="${initial}"></state><handler name="toggle"><set name="open" expr:value="not $open"></set></handler>
</defs><section data-single-slot="${name}"><button data-single-toggle on:click="toggle">Toggle</button>${outlet}<footer>Tail</footer></section></template>`).join("") +
`<template component="x-single-lazy-page"><x-single-lazy><template slot=""><input value="Initial"></template></x-single-lazy></template>`;

const receivingSlots = `<template component="x-receiving-item"><defs><prop name="label" type="string">Label.</prop>
<state name="count" type="number" value="0"></state><slot name="detail"></slot><context name="tone" from="x-receiving-list"></context>
<handler name="add"><set name="count" expr:value="$count + 1"></set></handler></defs>
<span data-receiving-item><input value="Initial"><button on:click="add">{$label}:{$count}:{$tone}</button><slot name="detail"></slot></span></template>
<template component="x-receiving-list"><defs><slot accepts="x-receiving-item" as="items"></slot>
<state name="first" type="boolean" value="true"></state><state name="second" type="boolean" value="true"></state><state name="tone" type="string" value="Tone"></state>
<handler name="toggle-first"><set name="first" expr:value="not $first"></set></handler><handler name="toggle-second"><set name="second" expr:value="not $second"></set></handler></defs>
<section data-receiving-list><output>{$items.length}</output><button data-receiving-action="first" on:click="toggle-first">First</button><button data-receiving-action="second" on:click="toggle-second">Second</button>
<p $if="$first"><slot>FirstFallback</slot></p><div $if="$second"><slot>SecondFallback</slot></div><aside data-receiving-borrowed><b $each="item of $items"><slot of="$item" name="detail">BorrowedFallback</slot></b></aside><footer>Tail</footer></section></template>
<template component="x-receiving-detail"><defs><context name="count" from="x-receiving-item"></context></defs><strong data-receiving-detail>{$count}</strong></template>
<template component="x-receiving-page"><defs><state name="label" type="string" value="Before"></state><handler name="update"><set name="label" expr:value="'After'"></set></handler></defs>
<aside><button data-receiving-update on:click="update">Update</button><x-receiving-list><x-receiving-item from:label="$label"><x-receiving-detail slot="detail"></x-receiving-detail></x-receiving-item><i data-rejected>Rejected</i>Rejected</x-receiving-list></aside></template>
<template component="x-receiving-outer"><defs><slot accepts="x-receiving-list" as="lists"></slot></defs><article><slot></slot></article></template>`;

const textButton = `<template component="x-text-button"><defs><prop name="link" type="boolean" default="false">Use a link.</prop></defs>
<template $match><a $when="$link" href="#target"><span class="caption"><slot></slot></span></a>
<button $else type="button"><span class="caption"><slot></slot></span></button></template></template>`;

export async function plainSlotRendering(target: "react" | "preact", application?: (entry: string) => string): Promise<{ directory: string; html: string; entry: string }> {
  const directory = await mkdtemp(join(tmpdir(), `html-next-${target}-plain-server-`));
  try {
    const sources = { ...plainSlotFiles, "repeated.html": repeatedPlainSource, "moving.html": dynamicPlainSource, "conditional.html": conditionalSlots, "receiving.html": receivingSlots, "text-button.html": textButton,
      "page.html": `<template component="x-ssr-plain"><main>${plainSlotInvocations}<x-repeat-page></x-repeat-page></main></template>` };
    for (const [name, source] of Object.entries(sources)) await writeFile(join(directory, name), source);
    const output = join(directory, "out");
    const manifest = await convertComponents({ mode: "library", target, root: directory, outDirectory: output, entries: ["*.html"] });
    const entry = join(output, manifest.output.entry);
    const bundle = await build({ ...(application === undefined ? { entryPoints: [entry] } : { stdin: { contents: application(entry) + '\nexport { App };', loader: 'tsx' as const, resolveDir: directory } }), bundle: true, write: false, platform: "node", format: "cjs",
      jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}), packages: "external", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
    const module = { exports: {} as Record<string, ComponentType> };
    const require = createRequire(import.meta.url);
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(require, module, module.exports);
    const component = module.exports[application === undefined ? "XSsrPlain" : "App"]!;
    const node = target === "react" ? createElement(component) : require("preact/compat").createElement(component, {});
    const html: string = target === "react" ? renderToString(node) : require("preact-render-to-string")(node);
    return { directory, html, entry };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
