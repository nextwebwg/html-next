import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

/**
 * A compiled page whose `<ui-panel>` module is evaluated a second time with a changed template, as a
 * development server's hot update does. `/first.js` defines the page's components, `/second.js` the
 * changed panel, and `/scenario.js` exports `run(replace)`, which renders the page, changes state,
 * calls `replace` to import `/second.js`, and reports what the replaced instance shows. Every module
 * shares one generated runtime, as a page's modules do.
 */
const source = fileURLToPath(new URL("../src/", import.meta.url));

const count = `<template component="x-count"><defs><state name="n" type="number" value="0"></state>
  <handler name="add"><set name="n" expr:value="$n + 1"></set></handler></defs><button on:click="add">{$n}</button></template>`;
const panel = (root: string, extra: string) => `<template component="ui-panel"><defs>
  <prop name="title" type="string" default="Untitled">Title.</prop>
  <state name="count" type="number" value="0"></state>${extra}</defs>${root}</template>`;
const before = panel(`<section class="panel" title="Old"><h2>{$title}</h2><x-count></x-count><slot></slot></section>`,
  '<state name="open" type="boolean" value="false"></state>');
const after = panel(`<article class="panel2"><h3>{$title}: {$count} {$label}</h3><x-count></x-count><slot></slot></article>`,
  '<state name="label" type="string" value="new"></state>');
const outer = `<template component="ui-outer"><defs><state name="label" type="string" value="one"></state></defs>
  <div><ui-panel id="p" class="mine" from:title="$label"><x-count data-slotted=""></x-count></ui-panel></div></template>`;

const scenario = `import { createUiOuter } from "./outer.js";
import { generatedHost } from "@nextwebwg/html-next/generated-runtime";
export async function run(replace) {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const main = document.querySelector("main");
  const page = createUiOuter();
  main.append(page);
  await settle();
  const slotted = page.querySelector("[data-slotted]");
  slotted.click();
  slotted.click();
  page.querySelector("#p button:not([data-slotted])").click();
  generatedHost(page.querySelector("#p")).state.count = 5;
  await settle();
  await replace();
  await settle();
  const root = page.querySelector("#p");
  const nested = root.querySelector("button:not([data-slotted])");
  const replaced = { tag: root.localName, className: root.getAttribute("class"), title: root.getAttribute("title"),
    heading: root.querySelector("h3")?.textContent, slotted: page.querySelector("[data-slotted]") === slotted,
    counts: [nested.textContent, slotted.textContent], open: generatedHost(root).state.open };
  nested.click();
  slotted.click();
  generatedHost(page).state.label = "two";
  await settle();
  return { replaced, counts: [nested.textContent, slotted.textContent], heading: root.querySelector("h3").textContent };
}
`;

/** The scenario's modules, by URL path. */
export async function hotReplacementFiles(): Promise<Record<string, string>> {
  const definitions = { count: parseComponent(count, "https://hot.example/count.html"), panel: parseComponent(before, "https://hot.example/panel.html"),
    after: parseComponent(after, "https://hot.example/panel.html"), outer: parseComponent(outer, "https://hot.example/outer.html") };
  const invocations = new Map([["x-count", { module: "./count.js", definition: definitions.count }], ["ui-panel", { module: "./panel.js", definition: definitions.panel }]]);
  const vanilla = (definition: typeof definitions.count) => generateComponent(definition, { invocations, hot: true })
    .find((artifact) => artifact.path.startsWith("vanilla/") && artifact.path.endsWith(".js"))!.content;
  const modules: Record<string, string> = {
    "count.js": vanilla(definitions.count), "panel.js": vanilla(definitions.panel), "panel2.js": vanilla(definitions.after), "outer.js": vanilla(definitions.outer),
    "first.js": 'import "./outer.js";', "second.js": 'import "./panel2.js";', "scenario.js": scenario,
  };
  const result = await build({
    entryPoints: ["first.js", "second.js", "scenario.js"], outdir: "/out", entryNames: "[name]", splitting: true,
    bundle: true, format: "esm", write: false, platform: "browser", target: ["es2022"],
    alias: { "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts` },
    plugins: [{ name: "modules", setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
      builder.onResolve({ filter: /^\.?\/?[a-z0-9]+\.js$/ }, (args) => {
        const path = args.path.replace(/^\.?\//, "");
        return Object.hasOwn(modules, path) ? { path, namespace: "modules" } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "modules" }, (args) => ({ contents: modules[args.path]!, loader: "js", resolveDir: source }));
    } }],
  });
  return Object.fromEntries(result.outputFiles.map((file) => [file.path.slice("/out".length), file.text]));
}

/** What `run` reports when the replacement keeps state, props, attributes, slotted children and bindings. */
export const hotReplacementResult = {
  replaced: { tag: "article", className: "panel2 mine", title: null, heading: "one: 5 new", slotted: true, counts: ["1", "2"], open: undefined },
  counts: ["2", "3"],
  heading: "two: 5 new",
};
