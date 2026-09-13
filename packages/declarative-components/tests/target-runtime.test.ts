import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { compile as compileSvelte } from "svelte/compiler";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;
const reactiveFixtureUrl = new URL("../benchmarks/fixtures/reactive-counter.html", import.meta.url);

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

describe.skipIf(!enabled)("generated target runtime parity", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
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
const component = createDemoCounter({ children: ["Projected"], slots: { title: [title] } });
component.addEventListener("count-change", event => events.push(event.detail));
document.querySelector("main").append(component);`,
      react: `import React from "react";
import { createRoot } from "react-dom/client";
import { DemoCounter } from "./react/DemoCounter";
const events = []; window.targetEvents = events;
createRoot(document.querySelector("main")).render(<DemoCounter onCountChange={detail => events.push(detail)} slots={{ title: <h1 slot="title">Title</h1> }}>Projected</DemoCounter>);`,
      vue: `import { createApp, h } from "vue";
import DemoCounter from "./vue/DemoCounter";
const events = []; window.targetEvents = events;
createApp({ render: () => h(DemoCounter, { onCountChange: detail => events.push(detail) }, { default: () => "Projected", title: () => h("h1", { slot: "title" }, "Title") }) }).mount(document.querySelector("main"));`,
      svelte: `import { createRawSnippet, mount } from "svelte";
import DemoCounter from "./svelte/DemoCounter";
const events = []; window.targetEvents = events;
const title = createRawSnippet(() => ({ render: () => '<h1 slot="title">Title</h1>' }));
const children = createRawSnippet(() => ({ render: () => 'Projected' }));
mount(DemoCounter, { target: document.querySelector("main"), props: { onCountChange: detail => events.push(detail), children, slots: { title } } });`,
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
        define: { "import.meta.url": JSON.stringify("https://example.test/generated/component.js") },
        jsx: "automatic",
        nodePaths: [nodeModulesPath],
        loader: { ".css": "empty" },
        alias: { "@nextwebwg/declarative-components/runtime": runtimePath },
      });
      bundles.set(target, outfile);
    }
  });

  afterAll(async () => {
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
            projected: root.textContent?.includes("Projected"),
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
          initialFallback: undefined,
          projected: true,
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

describe.skipIf(!enabled)("generated Vanilla AOT runtime", () => {
  let bundlePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vanilla-aot-"));
    const definition = parseComponent(await readFile(reactiveFixtureUrl, "utf8"), reactiveFixtureUrl.href);
    const module = generateComponent(definition)
      .find((artifact) => artifact.path === "vanilla/ReactiveCounter.js")?.content;
    assert.ok(module);
    assert.doesNotMatch(module, /@nextwebwg\/declarative-components\/runtime/);

    await mkdir(join(directory, "vanilla"), { recursive: true });
    await mkdir(join(directory, "styles"), { recursive: true });
    await writeFile(join(directory, "styles/reactive-counter.css"), "");
    const entryPath = join(directory, "vanilla/ReactiveCounter.js");
    bundlePath = join(directory, "bundle.js");
    await writeFile(entryPath, module);
    await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      format: "iife",
      globalName: "ReactiveCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
    });
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];

  for (const [name, browserType] of engines) {
    it(`${name} updates directly compiled state from a native event`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            ReactiveCounter: { createReactiveCounter(): Element };
          }).ReactiveCounter;
          const component = api.createReactiveCounter();
          document.querySelector("main")!.append(component);
          const output = component.querySelector("output")!;
          const before = output.textContent;
          (component as HTMLButtonElement).click();
          await Promise.resolve();
          const connected = output.textContent;
          component.remove();
          (component as HTMLButtonElement).click();
          await Promise.resolve();
          const detached = output.textContent;
          document.querySelector("main")!.append(component);
          (component as HTMLButtonElement).click();
          await Promise.resolve();
          return { before, connected, detached, reconnected: output.textContent };
        });
        assert.deepEqual(result, { before: "0", connected: "1", detached: "1", reconnected: "2" });
      } finally {
        await browser.close();
      }
    });
  }
});
