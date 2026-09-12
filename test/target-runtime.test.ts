import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium } from "playwright";
import { compile as compileSvelte } from "svelte/compiler";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

const source = `<template component="demo-counter" status="early" summary="Target parity fixture.">
  <defs>
    <prop name="email" type="string" default="invalid">Email.</prop>
    <state name="count" :value="0"></state>
    <event name="count-change" type="number"></event>
    <handler name="increment">
      <set name="count" :value="count + 1"></set>
      <dispatch event="count-change" :value="count"></dispatch>
    </handler>
  </defs>
  <section>
    <header><slot name="title"><h2>Untitled</h2></slot></header>
    <button type="button" on:click="increment"><output $value="count"></output></button>
    <input type="email" required :value="email">
    <slot><strong>Fallback</strong></slot>
  </section>
</template>`;

describe("generated target runtime parity", { skip: !enabled }, () => {
  let directory = "";
  const bundles = new Map<string, string>();

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-targets-"));
    const artifacts = new Map(
      generateComponent(parseComponent(source, "demo-counter.html"))
        .map((artifact) => [artifact.path, artifact.content]),
    );
    for (const [path, content] of artifacts) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent !== "") await mkdir(join(directory, parent), { recursive: true });
      await writeFile(join(directory, path), content);
    }

    const vueSource = artifacts.get("vue/DemoCounter.vue")!;
    const vueParsed = parseVue(vueSource, { filename: "DemoCounter.vue" });
    assert.deepEqual(vueParsed.errors, []);
    const vueModule = compileScript(vueParsed.descriptor, {
      id: "demo-counter",
      inlineTemplate: true,
    }).content;
    await writeFile(join(directory, "vue/DemoCounter.ts"), vueModule);

    const svelteModule = compileSvelte(artifacts.get("svelte/DemoCounter.svelte")!, {
      filename: "DemoCounter.svelte",
      generate: "client",
    }).js.code;
    await writeFile(join(directory, "svelte/DemoCounter.js"), svelteModule);

    const entries: Record<string, string> = {
      vanilla: `import { createDemoCounter } from "./vanilla/DemoCounter.js";
const events = []; window.targetEvents = events;
const title = document.createElement("h1"); title.slot = "title"; title.textContent = "Title";
const component = createDemoCounter({ slots: { title: [title] } });
component.addEventListener("count-change", event => events.push(event.detail));
document.querySelector("main").append(component);`,
      react: `import React from "react";
import { createRoot } from "react-dom/client";
import { DemoCounter } from "./react/DemoCounter";
const events = []; window.targetEvents = events;
createRoot(document.querySelector("main")).render(<DemoCounter onCountChange={detail => events.push(detail)} slots={{ title: <h1 slot="title">Title</h1> }} />);`,
      vue: `import { createApp, h } from "vue";
import DemoCounter from "./vue/DemoCounter";
const events = []; window.targetEvents = events;
createApp({ render: () => h(DemoCounter, { onCountChange: detail => events.push(detail) }, { title: () => h("h1", { slot: "title" }, "Title") }) }).mount(document.querySelector("main"));`,
      svelte: `import { createRawSnippet, mount } from "svelte";
import DemoCounter from "./svelte/DemoCounter";
const events = []; window.targetEvents = events;
const title = createRawSnippet(() => ({ render: () => '<h1 slot="title">Title</h1>' }));
mount(DemoCounter, { target: document.querySelector("main"), props: { onCountChange: detail => events.push(detail), slots: { title } } });`,
    };

    for (const [target, entry] of Object.entries(entries)) {
      const extension = target === "react" ? "tsx" : "ts";
      const entryPath = join(directory, `${target}.${extension}`);
      const outfile = join(directory, `${target}.js`);
      await writeFile(entryPath, entry);
      await build({
        entryPoints: [entryPath],
        outfile,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        jsx: "automatic",
        nodePaths: [nodeModulesPath],
        loader: { ".css": "empty" },
        alias: { "@nextwebwg/html/runtime": runtimePath },
      });
      bundles.set(target, outfile);
    }
  });

  after(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  for (const target of ["vanilla", "react", "vue", "svelte"] as const) {
    it(`${target} preserves shared state, events, identity, slots, and native validation`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.waitForTimeout(50);
        assert.deepEqual(pageErrors, []);
        await page.waitForSelector('[data-component-root~="demo-counter"] output', { state: "attached", timeout: 3_000 });
        const result = await page.evaluate(async () => {
          const root = document.querySelector('[data-component-root~="demo-counter"]')!;
          const output = root.querySelector("output")!;
          const input = root.querySelector("input") as HTMLInputElement;
          const before = output;
          (root.querySelector("button") as HTMLButtonElement).click();
          await Promise.resolve();
          await Promise.resolve();
          return {
            root: root.localName,
            initialFallback: root.querySelector("strong")?.textContent,
            title: root.querySelector("header")?.textContent,
            count: output.textContent,
            identity: output === before,
            events: (window as unknown as { targetEvents: unknown[] }).targetEvents,
            invalid: input.validity.typeMismatch && input.matches(":invalid"),
            provenance: root.getAttribute("data-component-root"),
          };
        });
        assert.deepEqual(result, {
          root: "section",
          initialFallback: "Fallback",
          title: "Title",
          count: "1",
          identity: true,
          events: [1],
          invalid: true,
          provenance: "demo-counter",
        });
      } finally {
        await browser.close();
      }
    });
  }
});
