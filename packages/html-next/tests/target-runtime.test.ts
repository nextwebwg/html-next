import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { generateComponent, vueHostArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const generatedRuntimePath = new URL("../src/generated-runtime.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;
const reactiveFixtureUrl = new URL("../benchmarks/fixtures/reactive-counter.html", import.meta.url);
const computedFixtureUrl = new URL("../benchmarks/fixtures/computed-counter.html", import.meta.url);

const source = `<template component="demo-counter" controller="./demo-controller.js" status="early" summary="Target parity fixture.">
  <defs>
    <prop name="email" type="string" default="invalid">Email.</prop>
    <prop name="optionalCount" type="number">Optional count.</prop>
    <prop name="title" type="string">Optional title colliding with HTMLElement.title.</prop>
    <state name="count" :value="0"></state>
    <event name="count-change" type="number"></event>
    <event name="invalid-change" type="number"></event>
    <handler name="increment">
      <set name="count" :value="count + 1"></set>
      <dispatch event="count-change" :value="count"></dispatch>
    </handler>
    <handler name="invalid">
      <dispatch event="invalid-change" :value="'not-a-number'"></dispatch>
    </handler>
  </defs>
  <section>
    <header><slot name="title"><h2>Untitled</h2></slot></header>
    <button type="button" on:click="increment"><output $value="count"></output></button>
    <button type="button" data-invalid on:click="invalid">Invalid event</button>
    <input type="email" required :value="email">
    <slot><strong>Fallback</strong></slot>
  </section>
</template>`;

const panelSource = `<template component="demo-panel" status="early" summary="Direct prop boundary fixture.">
  <props>
    <prop name="align" type="start | center | end">Alignment.</prop>
    <prop name="label" type="string">Label.</prop>
  </props>
  <div class="base" role="group"><span :data-align="align" :data-label="label"></span></div>
</template>`;

describe.skipIf(!enabled)("generated target runtime parity", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-targets-"));
    const artifacts = new Map([
      ...generateComponent(parseComponent(source, "demo-counter.html")),
      ...generateComponent(parseComponent(panelSource, "demo-panel.html")),
      vueHostArtifact(),
    ].map((artifact) => [artifact.path, artifact.content]));
    for (const [path, content] of artifacts) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent !== "") await mkdir(join(directory, parent), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    for (const target of ["vanilla", "vue"]) {
      await writeFile(join(directory, target, "demo-controller.js"), "export default function controller() {}\n");
    }

    const vueSource = artifacts.get("vue/DemoCounter.vue")!;
    const vueParsed = parseVue(vueSource, { filename: "DemoCounter.vue" });
    assert.deepEqual(vueParsed.errors, []);
    const vueModule = compileScript(vueParsed.descriptor, {
      id: "demo-counter",
      inlineTemplate: true,
    }).content;
    await writeFile(join(directory, "vue/DemoCounter.ts"), vueModule);
    const panelVueSource = artifacts.get("vue/DemoPanel.vue")!;
    const panelVueParsed = parseVue(panelVueSource, { filename: "DemoPanel.vue" });
    assert.deepEqual(panelVueParsed.errors, []);
    await writeFile(join(directory, "vue/DemoPanel.ts"), compileScript(panelVueParsed.descriptor, {
      id: "demo-panel",
      inlineTemplate: true,
    }).content);

    const entries: Record<string, string> = {
      vanilla: `import { createDemoCounter } from "./vanilla/DemoCounter.js";
import { createDemoPanel } from "./vanilla/DemoPanel.js";
const events = []; window.targetEvents = events; window.invalidTargetEvents = [];
const title = document.createElement("h1"); title.slot = "title"; title.textContent = "Title";
const component = createDemoCounter({ children: ["Projected"], slots: { title: [title] } });
component.addEventListener("count-change", event => events.push(event.detail));
component.addEventListener("invalid-change", event => window.invalidTargetEvents.push(event.detail));
document.querySelector("main").append(component, createDemoPanel({ align: "end", label: "Ready", attributes: { class: "consumer", role: "region" } }));`,
      vue: `import { createApp, h } from "vue";
import DemoCounter from "./vue/DemoCounter";
import DemoPanel from "./vue/DemoPanel";
const events = []; window.targetEvents = events; window.invalidTargetEvents = [];
createApp({ render: () => h("div", [h(DemoCounter, { onCountChange: detail => events.push(detail), onInvalidChange: detail => window.invalidTargetEvents.push(detail) }, { default: () => "Projected", title: () => h("h1", { slot: "title" }, "Title") }), h(DemoPanel, { align: "end", label: "Ready", class: "consumer", role: "region" })]) }).mount(document.querySelector("main"));`,
    };

    for (const [target, entry] of Object.entries(entries)) {
      const extension = "ts";
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
        alias: {
          "@nextwebwg/html-next/generated-runtime": generatedRuntimePath,
          "@nextwebwg/html-next/runtime": runtimePath,
        },
      });
      bundles.set(target, outfile);
    }
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  for (const target of ["vanilla", "vue"] as const) {
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
        await page.waitForSelector('[data-component~="demo-counter"] output', { state: "attached", timeout: 3_000 });
        const result = await page.evaluate(async () => {
          const root = document.querySelector('[data-component~="demo-counter"]') as HTMLElement;
          const output = root.querySelector("output")!;
          const input = root.querySelector("input") as HTMLInputElement;
          const panel = document.querySelector('[data-component~="demo-panel"]') as HTMLElement;
          const before = output;
          panel.setAttribute("data-align", "center");
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
            // The native HTMLElement.title property is untouched by the same-named prop.
            optionalTitle: root.title,
            ownTitle: Object.hasOwn(root, "title"),
            panel: {
              ownAlign: Object.hasOwn(panel, "align"),
              dataAlign: panel.getAttribute("data-align"),
              dataLabel: panel.getAttribute("data-label"),
              className: panel.className,
              role: panel.getAttribute("role"),
            },
            provenance: root.getAttribute("data-component"),
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
          optionalTitle: "",
          ownTitle: false,
          // HTML Next records explicit props as data-* for its rendered form; a converted Vue
          // component owns its props and writes no record.
          panel: { ownAlign: false, dataAlign: "center", dataLabel: target === "vue" ? null : "Ready", className: "base consumer", role: "region" },
          provenance: "demo-counter",
        });
        // Vue reports an error thrown by an event handler through console.error, not as uncaught.
        const invalidError = new Promise<string>((resolve) => {
          page.on("pageerror", (error) => resolve(error.message));
          page.on("console", (message) => { if (message.type() === "error") resolve(message.text()); });
        });
        await page.locator('[data-component~="demo-counter"] button[data-invalid]').click();
        assert.match(await invalidError, /HR002: Event `invalid-change` detail does not satisfy its declared type/);
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as { invalidTargetEvents: unknown[] }).invalidTargetEvents),
          [],
        );
      } finally {
        await browser.close();
      }
    });
  }
});

describe.skipIf(!enabled)("framework-native reactive conversion", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-native-targets-"));
    const definition = parseComponent(
      await readFile(computedFixtureUrl, "utf8"),
      computedFixtureUrl.href,
    );
    const artifacts = new Map(
      [...generateComponent(definition), vueHostArtifact()].map((artifact) => [artifact.path, artifact.content]),
    );
    for (const [path, content] of artifacts) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent !== "") await mkdir(join(directory, parent), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    assert.doesNotMatch(artifacts.get("vue/ComputedCounter.vue")!, /@nextwebwg|html-next/);

    const vueParsed = parseVue(artifacts.get("vue/ComputedCounter.vue")!, {
      filename: "ComputedCounter.vue",
    });
    assert.deepEqual(vueParsed.errors, []);
    await writeFile(join(directory, "vue/ComputedCounter.ts"), compileScript(vueParsed.descriptor, {
      id: "computed-counter",
      inlineTemplate: true,
    }).content);
    const entries: Readonly<Record<string, string>> = {
      vue: `import { createApp, h } from "vue";
import ComputedCounter from "./vue/ComputedCounter";
createApp({ render: () => h(ComputedCounter) }).mount(document.querySelector("main"));`,
    };
    for (const [target, entry] of Object.entries(entries)) {
      const entryPath = join(directory, `${target}.ts`);
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
      });
      bundles.set(target, outfile);
    }
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  for (const target of ["vue"] as const) {
    it(`${target} owns state, computed updates, and event scheduling`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.waitForSelector('[data-component~="computed-counter"] output');
        const result = await page.evaluate(async () => {
          const root = document.querySelector('[data-component~="computed-counter"]')!;
          const output = root.querySelector("output")!;
          const before = output.textContent;
          (root as HTMLButtonElement).click();
          await Promise.resolve();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { before, after: output.textContent };
        });
        assert.deepEqual(result, { before: "2", after: "4" });
      } finally {
        await browser.close();
      }
    });
  }
});

describe.skipIf(!enabled)("generated Vanilla AOT runtime", () => {
  let bundlePath = "";
  let computedBundlePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vanilla-aot-"));
    const definition = parseComponent(await readFile(reactiveFixtureUrl, "utf8"), reactiveFixtureUrl.href);
    const module = generateComponent(definition)
      .find((artifact) => artifact.path === "vanilla/ReactiveCounter.js")?.content;
    assert.ok(module);
    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);

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

    const computedDefinition = parseComponent(
      await readFile(computedFixtureUrl, "utf8"),
      computedFixtureUrl.href,
    );
    const computedModule = generateComponent(computedDefinition)
      .find((artifact) => artifact.path === "vanilla/ComputedCounter.js")?.content;
    assert.ok(computedModule);
    assert.doesNotMatch(computedModule, /@nextwebwg\/html-next\/runtime/);
    await writeFile(join(directory, "styles/computed-counter.css"), "");
    const computedEntryPath = join(directory, "vanilla/ComputedCounter.js");
    computedBundlePath = join(directory, "computed-bundle.js");
    await writeFile(computedEntryPath, computedModule);
    await build({
      entryPoints: [computedEntryPath],
      outfile: computedBundlePath,
      bundle: true,
      format: "iife",
      globalName: "ComputedCounter",
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

    it(`${name} recomputes directly compiled numeric computed state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: computedBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            ComputedCounter: { createComputedCounter(): Element };
          }).ComputedCounter;
          const component = api.createComputedCounter();
          document.querySelector("main")!.append(component);
          const output = component.querySelector("output")!;
          const before = output.textContent;
          (component as HTMLButtonElement).click();
          await Promise.resolve();
          return { before, after: output.textContent };
        });
        assert.deepEqual(result, { before: "2", after: "4" });
      } finally {
        await browser.close();
      }
    });
  }
});

describe.skipIf(!enabled)("generated Vanilla AOT props", () => {
  let bundlePath = "";
  let mixedBundlePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vanilla-props-"));
    const definition = parseComponent(`<template component="demo-props" status="experimental" summary="Props.">
      <props>
        <prop name="count" type="number" default="1">Count.</prop>
        <prop name="label" type="string" default="Ready">Label.</prop>
        <prop name="tone" type="quiet | loud" default="quiet">Tone.</prop>
      </props>
      <section :data-count="count" :data-tone="tone"><output $value="count"></output><span :aria-label="label"></span><slot></slot></section>
    </template>`);
    const module = generateComponent(definition)
      .find((artifact) => artifact.path === "vanilla/DemoProps.js")?.content;
    assert.ok(module);
    assert.match(module, /html-next\/generated-runtime/);
    assert.doesNotMatch(module, /html-next\/runtime/);

    await mkdir(join(directory, "vanilla"), { recursive: true });
    await mkdir(join(directory, "styles"), { recursive: true });
    await writeFile(join(directory, "styles/demo-props.css"), "");
    const entryPath = join(directory, "vanilla/DemoProps.js");
    bundlePath = join(directory, "bundle.js");
    await writeFile(entryPath, module);
    await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      format: "iife",
      globalName: "DemoProps",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath },
    });
    const mixedEntryPath = join(directory, "mixed.ts");
    mixedBundlePath = join(directory, "mixed.js");
    await writeFile(
      mixedEntryPath,
      `export { createDemoProps } from "./vanilla/DemoProps.js";\n` +
      `export { observeDocument } from "@nextwebwg/html-next/runtime";\n`,
    );
    await build({
      entryPoints: [mixedEntryPath],
      outfile: mixedBundlePath,
      bundle: true,
      format: "iife",
      globalName: "MixedProps",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: {
        "@nextwebwg/html-next/generated-runtime": generatedRuntimePath,
        "@nextwebwg/html-next/runtime": runtimePath,
      },
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
    it(`${name} batches reflected props and pauses DOM work while detached`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.setContent("<main></main>");
        await page.evaluate(() => {
          const NativeObserver = MutationObserver;
          (window as unknown as { observedTargets: string[] }).observedTargets = [];
          window.MutationObserver = class extends NativeObserver {
            override observe(target: Node, options?: MutationObserverInit): void {
              (window as unknown as { observedTargets: string[] }).observedTargets.push(
                target === document ? "#document" : target.nodeName,
              );
              super.observe(target, options);
            }
          };
        });
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(async () => {
          (window as unknown as { observedTargets: string[] }).observedTargets = [];
          const create = (window as unknown as {
            DemoProps: { createDemoProps(options?: Record<string, unknown>): Element };
          }).DemoProps.createDemoProps;
          const root = create({ children: ["Projected"] });
          const second = create();
          document.querySelector("main")!.append(root, second);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = root.querySelector("output")!;
          const label = root.querySelector("span")!;
          const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
          const initial = {
            // Template-bound attributes show defaults; the unbound label default is not reflected.
            count: root.getAttribute("data-count"),
            text: output.textContent,
            label: label.getAttribute("aria-label"),
            tone: root.getAttribute("data-tone"),
            reflectedLabel: root.hasAttribute("data-label"),
            ownProperties: ["count", "label", "tone"].filter((key) => Object.hasOwn(root, key)),
          };

          root.setAttribute("data-count", "2");
          root.setAttribute("data-label", "First");
          root.setAttribute("data-label", "Second");
          const synchronous = {
            text: output.textContent,
            label: label.getAttribute("aria-label"),
          };
          await tick();
          const batched = {
            text: output.textContent,
            label: label.getAttribute("aria-label"),
            reflected: root.getAttribute("data-label"),
          };

          root.setAttribute("data-label", "External");
          await tick();
          const external = { label: label.getAttribute("aria-label") };

          root.remove();
          await new Promise((resolve) => setTimeout(resolve, 0));
          root.setAttribute("data-count", "3");
          await tick();
          const detached = {
            text: output.textContent,
            reflected: root.getAttribute("data-count"),
          };
          document.querySelector("main")!.append(root);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const reconnected = {
            text: output.textContent,
            reflected: root.getAttribute("data-count"),
          };

          // An invalid attribute value is rejected at the type boundary (reported as a page error).
          root.setAttribute("data-tone", "unknown");
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            initial,
            synchronous,
            batched,
            external,
            detached,
            reconnected,
            observedTargets: (window as unknown as { observedTargets: string[] }).observedTargets,
          };
        });
        assert.deepEqual(result.initial, { count: "1", text: "1", label: "Ready", tone: "quiet", reflectedLabel: false, ownProperties: [] });
        assert.deepEqual(result.synchronous, { text: "1", label: "Ready" });
        assert.deepEqual(result.batched, { text: "2", label: "Second", reflected: "Second" });
        assert.deepEqual(result.external, { label: "External" });
        assert.deepEqual(result.detached, { text: "2", reflected: "3" });
        assert.deepEqual(result.reconnected, { text: "3", reflected: "3" });
        await expect.poll(() => pageErrors.join("\n")).toMatch(/HR002/);
        assert.deepEqual(result.observedTargets, ["#document", "SECTION", "SECTION", "SECTION"]);
      } finally {
        await browser.close();
      }
    });
  }

  it("shares its document mutation hub with the live runtime", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      await page.evaluate(() => {
        const NativeObserver = MutationObserver;
        (window as unknown as { documentObservations: number }).documentObservations = 0;
        window.MutationObserver = class extends NativeObserver {
          override observe(target: Node, options?: MutationObserverInit): void {
            if (target === document) {
              (window as unknown as { documentObservations: number }).documentObservations += 1;
            }
            super.observe(target, options);
          }
        };
      });
      await page.addScriptTag({ path: mixedBundlePath });
      const count = await page.evaluate(async () => {
        (window as unknown as { documentObservations: number }).documentObservations = 0;
        const api = (window as unknown as {
          MixedProps: {
            createDemoProps(): Element;
            observeDocument(): () => void;
          };
        }).MixedProps;
        const root = api.createDemoProps();
        document.querySelector("main")!.append(root);
        const stop = api.observeDocument();
        await new Promise((resolve) => setTimeout(resolve, 0));
        stop();
        return (window as unknown as { documentObservations: number }).documentObservations;
      });
      assert.equal(count, 1);
    } finally {
      await browser.close();
    }
  });
});

const actionSource = `<template component="x-action" status="early" summary="Button or link.">
  <defs>
    <prop name="as" type="button | a" default="button">Native root.</prop>
    <prop name="href" type="string">Link.</prop>
    <prop name="disabled" type="boolean" default="false">Off.</prop>
  </defs>
  <template $match>
    <a $when="as = 'a'" :href="{ true: null, false: href }[format('%s', disabled)]"><slot></slot></a>
    <button $else type="button" :disabled="disabled"><slot></slot></button>
  </template>
</template>`;

describe.skipIf(!enabled)("polymorphic roots in generated targets", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-polymorphic-"));
    for (const folder of ["docs", "styles", "vanilla", "vue"]) await mkdir(join(directory, folder), { recursive: true });
    for (const artifact of generateComponent(parseComponent(actionSource, "x-action.html"))) {
      await writeFile(join(directory, artifact.path), artifact.content);
    }
    const parsed = parseVue(await readFile(join(directory, "vue/XAction.vue"), "utf8"), { filename: "XAction.vue" });
    assert.deepEqual(parsed.errors, []);
    await writeFile(join(directory, "vue/XAction.ts"), compileScript(parsed.descriptor, { id: "x-action", inlineTemplate: true }).content);
    const entries: Record<string, string> = {
      vanilla: `import { updateComponentProps } from "@nextwebwg/html-next/runtime";
import { createXAction } from "./vanilla/XAction.js";
const save = createXAction({ children: ["Save"] });
document.querySelector("main").append(
  save,
  createXAction({ as: "a", href: "/next", children: ["Next"] }),
  createXAction({ as: "a", href: "/next", disabled: true, children: ["Off"] }),
);
window.switchSave = () => updateComponentProps(save, { as: "a", href: "/save" });`,
      vue: `import { createApp, h } from "vue";
import XAction from "./vue/XAction";
createApp({ render: () => [
  h(XAction, null, () => "Save"),
  h(XAction, { as: "a", href: "/next" }, () => "Next"),
  h(XAction, { as: "a", href: "/next", disabled: true }, () => "Off"),
] }).mount(document.querySelector("main"));`,
    };
    for (const [target, entry] of Object.entries(entries)) {
      const entryPath = join(directory, `${target}.ts`);
      const outfile = join(directory, `${target}.js`);
      await writeFile(entryPath, entry);
      await build({
        entryPoints: [entryPath],
        outfile,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        define: { "import.meta.url": JSON.stringify("https://example.test/generated/x-action.js") },
        nodePaths: [nodeModulesPath],
        loader: { ".css": "empty" },
        alias: { "@nextwebwg/html-next/runtime": runtimePath },
      });
      bundles.set(target, outfile);
    }
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  for (const target of ["vanilla", "vue"] as const) {
    it(`${target} renders the native root its props choose`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundles.get(target)! });
        const roots = await page.evaluate(async () => {
          await new Promise((resolve) => setTimeout(resolve));
          return Array.from(document.querySelectorAll("main > *"), (element) => ({
            tag: element.localName,
            component: element.getAttribute("data-component"),
            href: element.getAttribute("href"),
            type: element.getAttribute("type"),
            disabled: element.hasAttribute("disabled"),
            text: element.textContent,
          }));
        });
        assert.deepEqual(roots, [
          { tag: "button", component: "x-action", href: null, type: "button", disabled: false, text: "Save" },
          { tag: "a", component: "x-action", href: "/next", type: null, disabled: false, text: "Next" },
          { tag: "a", component: "x-action", href: null, type: null, disabled: false, text: "Off" },
        ]);
      } finally {
        await browser.close();
      }
    });
  }

  it("vanilla replaces a factory's root when its props choose another arm", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      await page.addScriptTag({ path: bundles.get("vanilla")! });
      const root = await page.evaluate(async () => {
        const settle = () => new Promise((resolve) => setTimeout(resolve));
        await settle();
        (window as unknown as { switchSave(): void }).switchSave();
        await settle();
        const element = document.querySelector("main > *")!;
        return { tag: element.localName, href: element.getAttribute("href"), type: element.getAttribute("type"), text: element.textContent };
      });
      assert.deepEqual(root, { tag: "a", href: "/save", type: null, text: "Save" });
    } finally {
      await browser.close();
    }
  });
});
