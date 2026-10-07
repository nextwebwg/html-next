import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { generateComponent as generateCompiled, vueHostArtifact, vueControlArtifact, vuePropsArtifact } from "../src/generate.js";
import { liveReference } from "./live-reference.js";
import { parseComponent } from "../src/source-parser.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const generatedRuntimePath = new URL("../src/generated-runtime.ts", import.meta.url).pathname;

/**
 * With HTMLNEXT_LIVE_REFERENCE=1, each generated Vanilla module is the live runtime's reference
 * instead (`live-reference.ts`), under the same factory name, so these browser scripts read what
 * live does: compiled output must match it.
 */
const liveMode = process.env.HTMLNEXT_LIVE_REFERENCE === "1";
const generateComponent: typeof generateCompiled = (definition, options) => {
  const artifacts = generateCompiled(definition, options);
  if (!liveMode) return artifacts;
  return artifacts.map((artifact) => artifact.path !== `vanilla/${definition.contract.name}.js` ? artifact : {
    ...artifact, content: `${liveReference(definition)}\nexport { createReference as create${definition.contract.name} };`,
  });
};
/** A compiled module never imports the live runtime (the live reference does, by definition). */
const assertCompiled = (module: string): void => { if (!liveMode) assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/); };
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;
const reactiveFixtureUrl = new URL("../benchmarks/fixtures/reactive-counter.html", import.meta.url);
const computedFixtureUrl = new URL("../benchmarks/fixtures/computed-counter.html", import.meta.url);

const source = `<template component="demo-counter" controller="./demo-controller.js" status="early" summary="Target parity fixture.">
  <defs>
    <prop name="email" type="string" default="invalid">Email.</prop>
    <prop name="optionalCount" type="number">Optional count.</prop>
    <prop name="title" type="string">Optional title colliding with HTMLElement.title.</prop>
    <state type="number" name="count" value="0"></state>
    <event name="count-change" type="number"></event>
    <event name="invalid-change" type="number"></event>
    <handler name="increment">
      <set name="count" expr:value="count + 1"></set>
      <dispatch event="count-change" expr:value="count"></dispatch>
    </handler>
    <handler name="invalid">
      <dispatch event="invalid-change" expr:value="'not-a-number'"></dispatch>
    </handler>
  </defs>
  <section>
    <header><slot name="title"><h2>Untitled</h2></slot></header>
    <button type="button" on:click="increment"><output $value="count"></output></button>
    <button type="button" data-invalid on:click="invalid">Invalid event</button>
    <input type="email" required from:value="email">
    <slot><strong>Fallback</strong></slot>
  </section>
</template>`;

const panelSource = `<template component="demo-panel" status="early" summary="Direct prop boundary fixture.">
  <props>
    <prop name="align" type="keyword" values="start, center, end">Alignment.</prop>
    <prop name="label" type="string">Label.</prop>
  </props>
  <div class="base" role="group"><span from:data-align="align" from:data-label="label"></span></div>
</template>`;

const selectiveSource = `<template component="split-counter" status="experimental" summary="Static dependency fixture.">
  <defs>
    <state type="number" name="left" value="1"></state>
    <state type="number" name="right" value="10"></state>
    <computed name="left1" from="left + 1"></computed>
    <computed name="left2" from="left1 + 1"></computed>
    <computed name="left3" from="left2 + 1"></computed>
    <computed name="total" from="left3 + right"></computed>
    <handler name="increaseLeft"><set name="left" expr:value="left + 1"></set></handler>
    <handler name="increaseRight"><set name="right" expr:value="right + 1"></set></handler>
  </defs>
  <section><button type="button" on:click="increaseLeft"><output $value="left3"></output></button><button type="button" on:click="increaseRight"><output $value="total"></output></button></section>
</template>`;

const liveBranchSource = `<template component="live-branch" status="experimental" summary="Static live-branch fixture.">
  <defs>
    <state type="number" name="left" value="1"></state>
    <state type="number" name="right" value="10"></state>
    <computed name="visible" from="right + 1"></computed>
    <computed name="unused1" from="left + 1"></computed>
    <computed name="unused2" from="unused1 + 1"></computed>
    <computed name="unused3" from="unused2 + 1"></computed>
    <handler name="increaseLeft"><set name="left" expr:value="left + 1"></set></handler>
    <handler name="increaseRight"><set name="right" expr:value="right + 1"></set></handler>
  </defs>
  <section><button type="button" on:click="increaseLeft"></button><button type="button" on:click="increaseRight"><output $value="visible"></output></button></section>
</template>`;

const roundedSource = `<template component="rounded-counter" status="experimental" summary="Rounded direct fixture.">
  <defs>
    <state type="number" name="position" value="0"></state>
    <computed name="bucket" from="round(position)"></computed>
    <handler name="advance"><set name="position" expr:value="position + 0.1"></set></handler>
  </defs>
  <button type="button" on:click="advance"><output $value="bucket"></output></button>
</template>`;

const mixedSource = `<template component="mixed-counter" status="experimental" summary="Mixed rounded direct fixture.">
  <defs>
    <state type="number" name="position" value="0"></state>
    <computed name="bucket" from="round(position)"></computed>
    <handler name="advance"><set name="position" expr:value="position + 0.1"></set></handler>
  </defs>
  <button type="button" on:click="advance"><output $value="position"></output><output $value="bucket"></output></button>
</template>`;

const dataAttributeSource = `<template component="data-counter" status="experimental" summary="Direct data attribute fixture.">
  <defs>
    <state type="number" name="position" value="0"></state>
    <computed name="bucket" from="round(position)"></computed>
    <handler name="advance"><set name="position" expr:value="position + 0.1"></set></handler>
  </defs>
  <button type="button" on:click="advance" from:data-bucket="bucket"><output $value="position"></output></button>
</template>`;

const ariaAttributeSource = `<template component="aria-counter" status="experimental" summary="Direct ARIA attribute fixture.">
  <defs>
    <state type="number" name="position" value="0"></state>
    <computed name="bucket" from="round(position)"></computed>
    <handler name="advance"><set name="position" expr:value="position + 0.1"></set></handler>
  </defs>
  <button type="button" on:click="advance" role="progressbar" from:aria-valuenow="position" from:aria-valuetext="bucket"><output $value="position"></output></button>
</template>`;

const htmlAttributeSource = `<template component="title-counter" status="experimental" summary="Direct HTML attribute fixture.">
  <defs>
    <state type="number" name="position" value="0"></state>
    <computed name="bucket" from="round(position)"></computed>
    <handler name="advance"><set name="position" expr:value="position + 0.1"></set></handler>
  </defs>
  <button type="button" on:click="advance" from:title="bucket"><output $value="position"></output></button>
</template>`;

const propertySource = `<template component="value-counter" status="experimental" summary="Direct HTML property fixture.">
  <defs>
    <state type="number" name="position" value="0"></state>
    <computed name="bucket" from="round(position)"></computed>
    <handler name="advance"><set name="position" expr:value="position + 0.1"></set></handler>
  </defs>
  <section><button type="button" on:click="advance">Advance</button><input type="number" .value="bucket"><output $value="position"></output></section>
</template>`;

const booleanSource = `<template component="boolean-toggle" status="experimental" summary="Direct primitive boolean fixture.">
  <defs>
    <state type="boolean" name="open" value="false"></state>
    <computed name="closed" from="not open"></computed>
    <handler name="toggle"><set name="open" expr:value="not open"></set></handler>
  </defs>
  <button type="button" on:click="toggle" class:open="open" from:aria-expanded="open" from:hidden="closed"><input type="checkbox" .checked="open"><output $value="closed"></output></button>
</template>`;

const styleSource = `<template component="style-counter" status="experimental" summary="Direct primitive style fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <button type="button" on:click="increment"><svg style:--count="count"><text>Chart</text></svg><output $value="count"></output></button>
</template>`;

const boundTextSource = `<template component="bound-text" status="experimental" summary="Direct native text binding fixture.">
  <defs><state type="string" name="draft" value="Ready"></state></defs>
  <section><label>Draft <input type="text" bind:value="draft"></label><output $value="draft"></output></section>
</template>`;

const boundCheckSource = `<template component="bound-check" status="experimental" summary="Direct native checkbox binding fixture.">
  <defs><state type="boolean" name="done" value="false"></state></defs>
  <section><input type="checkbox" bind:checked="done"><output $value="done"></output></section>
</template>`;

const boundChoiceSource = `<template component="bound-choice" status="experimental" summary="Direct native choice binding fixture.">
  <defs><state type="string" name="choice" value="one"></state></defs>
  <section><textarea bind:value="choice"></textarea><select bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="choice"></output></section>
</template>`;

const boundRangeSource = `<template component="bound-range" status="experimental" summary="Direct native range binding fixture.">
  <defs><state type="number" name="position" value="0"></state></defs>
  <section><input type="range" min="0" max="100" bind:value="position"><output $value="position"></output></section>
</template>`;

const modifierSource = `<template component="event-modifier" status="experimental" summary="Direct native event modifier fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><button type="button" on:click.prevent.stop="increment"><output $value="count"></output></button></section>
</template>`;

const selfSource = `<template component="event-self" status="experimental" summary="Direct native self modifier fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><button type="button" on:click.self="increment"><span>Inner</span><output $value="count"></output></button></section>
</template>`;

const filteredEventSource = `<template component="event-filter" status="experimental" summary="Direct native event filter fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><button class="keys" type="button" on:keydown.enter.ctrl.exact.self.prevent.stop="increment"><span>Inner</span><output $value="count"></output></button><button class="mouse" type="button" on:click.left="increment">Mouse</button></section>
</template>`;

const eventOptionsSource = `<template component="event-options" status="experimental" summary="Direct native event options fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><button type="button" on:click.capture.passive.stop="increment"><span>Inner</span><output $value="count"></output></button></section>
</template>`;

const onceSource = `<template component="event-once" status="experimental" summary="Direct native once fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><button type="button" on:keydown.enter.once="increment"><output $value="count"></output></button></section>
</template>`;

const dispatchSource = `<template component="event-dispatch" status="experimental" summary="Direct declared event dispatch fixture.">
  <defs>
    <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
    <state type="number" name="count" value="0"></state>
    <handler name="save"><set name="count" expr:value="count + 1"></set><dispatch event="saved" expr:value="count"></dispatch></handler>
  </defs>
  <button type="button" on:click="save">Save <output $value="count"></output></button>
</template>`;

const computedDispatchSource = `<template component="computed-event-dispatch" status="experimental" summary="Direct computed declared event dispatch fixture.">
  <defs>
    <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
    <state type="number" name="count" value="0"></state>
    <computed name="savedValue" from="count * 2"></computed>
    <computed name="queuedValue" from="count + 3"></computed>
    <handler name="save"><set name="count" expr:value="count + 1"></set><dispatch event="saved" expr:value="savedValue"></dispatch><set name="count" expr:value="count + 1"></set><dispatch event="saved" expr:value="savedValue"></dispatch></handler>
  </defs>
  <button type="button" on:click="save">Save <output $value="queuedValue"></output></button>
</template>`;

const inlineExpressionSource = `<template component="inline-expression" status="experimental" summary="Direct inline text expression fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <button type="button" on:click="increment">Advance <output $value="count + 1"></output></button>
</template>`;

const inlineAttributesSource = `<template component="inline-attributes" status="experimental" summary="Direct inline native expression fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section from:data-count="count + 1" class:zero="count = 0" style:--count="count + 1"><button type="button" on:click="increment">Advance</button><input type="number" .value="count + 1"></section>
</template>`;

const guardedHandlerSource = `<template component="guarded-handler" status="experimental" summary="Direct state-only guarded handler fixture.">
  <defs>
    <event name="saved" type="number"></event>
    <state type="boolean" name="enabled" value="true"></state>
    <state type="number" name="count" value="0"></state>
    <handler name="advance"><set name="count" expr:value="count + 1" $if="enabled"></set><dispatch event="saved" expr:value="count" $if="enabled"></dispatch><set name="enabled" expr:value="not enabled"></set></handler>
  </defs>
  <button type="button" on:click="advance">Advance <output $value="count"></output></button>
</template>`;

const computedGuardSource = `<template component="computed-guard" status="experimental" summary="Direct computed guarded handler fixture.">
  <defs>
    <event name="saved" type="number"></event>
    <state type="number" name="count" value="0"></state>
    <state type="number" name="hits" value="0"></state>
    <computed name="even" from="count % 2 = 0"></computed>
    <handler name="advance"><set name="count" expr:value="count + 1"></set><dispatch event="saved" expr:value="count" $if="even"></dispatch><set name="hits" expr:value="hits + 1" $if="even"></set></handler>
  </defs>
  <button type="button" on:click="advance">Advance <output $value="count"></output><output $value="hits"></output></button>
</template>`;

const refActionSource = `<template component="ref-action" status="experimental" summary="Direct static ref action fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="submit"><validate target="form"></validate><focus ref="field"></focus><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><form $ref="form"><input required $ref="field"></form><button type="button" on:click="submit">Submit</button><output $value="count"></output></section>
</template>`;

const literalTextSource = `<template component="literal-text" status="experimental" summary="Direct literal text fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section><output class="status" $value="'Ready'"></output><button type="button" on:click="increment"><output $value="count"></output></button></section>
</template>`;

const literalNativeSource = `<template component="literal-native" status="experimental" summary="Direct literal native bindings fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section from:data-status="'ready'" from:aria-hidden="false" from:hidden="true" class:fixed="true" style:--gap="4"><input .value="'Fixed'"><button type="button" on:click="increment"><output $value="count"></output></button></section>
</template>`;

const staticComputedSource = `<template component="static-computed" status="experimental" summary="Static computed direct construction fixture.">
  <defs>
    <event name="saved" type="string"></event>
    <state type="number" name="count" value="0"></state>
    <computed name="prefix" from="'Ready'"></computed>
    <computed name="label" from="concat(prefix, '!')"></computed>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
    <handler name="save"><dispatch event="saved" expr:value="label"></dispatch></handler>
  </defs>
  <section from:data-status="label" class:ready="label = 'Ready!'" style:--label="prefix"><input .value="label"><output class="status" $value="label"></output><button type="button" on:click="increment"><output $value="count"></output></button><button type="button" on:click="save">Save</button></section>
</template>`;

const readOnlySource = `<template component="read-only-label" status="experimental" summary="Read-only direct leaf fixture.">
  <defs>
    <state type="number" name="count" value="1"></state>
    <computed name="label" from="concat('Ready ', count)"></computed>
  </defs>
  <section from:data-label="label" class:ready="count = 1"><input .value="label"><output $value="label"></output><article class="child" aria-label="Ready child"><span class="projected">Projected<strong title="Ready grandchild"></strong></span></article></section>
</template>`;

const stringSource = `<template component="string-tabs" status="experimental" summary="Direct primitive string fixture.">
  <defs>
    <state type="string" name="tab" value="one"></state>
    <handler name="showOne"><set name="tab" expr:value="'one'"></set></handler>
    <handler name="showTwo"><set name="tab" expr:value="'two'"></set></handler>
  </defs>
  <section from:data-tab="tab" from:title="tab"><button type="button" on:click="showOne">One</button><button type="button" on:click="showTwo">Two</button><input .value="tab"><output $value="tab"></output></section>
</template>`;

const formatSource = `<template component="format-counter" status="experimental" summary="Direct primitive format fixture.">
  <defs>
    <state type="number" name="count" value="0"></state>
    <computed name="label" from="concat('Step ', count)"></computed>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  </defs>
  <section from:aria-label="label"><button type="button" on:click="increment">Increment</button><input .value="label"><output $value="label"></output></section>
</template>`;
const stepsSource = `<template component="x-steps"><defs>
  <state type="number" name="current" value="1"></state>
  <handler name="next"><set name="current" expr:value="current + 1"></set></handler>
  </defs><section><button type="button" on:click="next">Next</button><ol><slot></slot></ol></section></template>`;

const stepSource = `<template component="x-step"><defs>
  <prop name="index" type="number" required>Step index.</prop>
  <context name="current" from="x-steps" as="activeStep"></context>
  </defs><li from:aria-current="activeStep = index ? 'step' : null"><slot></slot></li></template>`;

describe.skipIf(!enabled)("generated target runtime parity", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-targets-"));
    const artifacts = new Map([
      ...generateComponent(parseComponent(source, "demo-counter.html")),
      ...generateComponent(parseComponent(panelSource, "demo-panel.html")),
      ...generateComponent(parseComponent(stepsSource, "x-steps.html")),
      ...generateComponent(parseComponent(stepSource, "x-step.html")),
      vueHostArtifact(),
      vueControlArtifact(),
      vuePropsArtifact(),
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
    for (const name of ["XSteps", "XStep"]) {
      const parsed = parseVue(artifacts.get(`vue/${name}.vue`)!, { filename: `${name}.vue` });
      assert.deepEqual(parsed.errors, []);
      await writeFile(join(directory, `vue/${name}.ts`), compileScript(parsed.descriptor, {
        id: name.toLowerCase(),
        inlineTemplate: true,
      }).content);
    }

    const entries: Record<string, string> = {
      vanilla: `import { createDemoCounter } from "./vanilla/DemoCounter.js";
import { createDemoPanel } from "./vanilla/DemoPanel.js";
import { createXSteps } from "./vanilla/XSteps.js";
import { createXStep } from "./vanilla/XStep.js";
const events = []; window.targetEvents = events; window.invalidTargetEvents = [];
const title = document.createElement("h1"); title.slot = "title"; title.textContent = "Title";
const component = createDemoCounter({ children: ["Projected"], slots: { title: [title] } });
component.addEventListener("count-change", event => events.push(event.detail));
component.addEventListener("invalid-change", event => window.invalidTargetEvents.push(event.detail));
document.querySelector("main").append(component, createDemoPanel({ align: "end", label: "Ready", attributes: { class: "consumer", role: "region" } }), createXSteps({ children: [createXStep({ index: 1, children: ["One"] }), createXStep({ index: 2, children: ["Two"] })] }));`,
      vue: `import { createApp, h } from "vue";
import DemoCounter from "./vue/DemoCounter";
import DemoPanel from "./vue/DemoPanel";
import XSteps from "./vue/XSteps";
import XStep from "./vue/XStep";
const events = []; window.targetEvents = events; window.invalidTargetEvents = [];
createApp({ render: () => h("div", [h(DemoCounter, { onCountChange: event => events.push(event.detail), onInvalidChange: event => window.invalidTargetEvents.push(event.detail) }, { default: () => "Projected", title: () => h("h1", { slot: "title" }, "Title") }), h(DemoPanel, { align: "end", label: "Ready", class: "consumer", role: "region" }), h(XSteps, null, { default: () => [h(XStep, { index: 1 }, () => "One"), h(XStep, { index: 2 }, () => "Two")] })]) }).mount(document.querySelector("main"));`,
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
          "@nextwebwg/html-next/validation": new URL("../src/validation.ts", import.meta.url).pathname,
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
          // Both targets record explicit props as data-* for the rendered form.
          panel: { ownAlign: false, dataAlign: "end", dataLabel: "Ready", className: "base consumer", role: "region" },
          provenance: "demo-counter",
        });
        const context = await page.evaluate(async () => {
          const read = () => Array.from(document.querySelectorAll('[data-component="x-step"]'), (step) => step.getAttribute("aria-current"));
          const before = read();
          (document.querySelector('[data-component="x-steps"] button') as HTMLButtonElement).click();
          await Promise.resolve();
          await Promise.resolve();
          return { before, after: read() };
        });
        assert.deepEqual(context, { before: ["step", null], after: [null, "step"] });
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
      [...generateComponent(definition), vueHostArtifact(), vuePropsArtifact()].map((artifact) => [artifact.path, artifact.content]),
    );
    for (const [path, content] of artifacts) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent !== "") await mkdir(join(directory, parent), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    assert.doesNotMatch(artifacts.get("vue/ComputedCounter.vue")!, /from ['"]@nextwebwg\//);

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
        alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath },
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
  let selectiveBundlePath = "";
  let liveBranchBundlePath = "";
  let roundedBundlePath = "";
  let mixedBundlePath = "";
  let dataAttributeBundlePath = "";
  let ariaAttributeBundlePath = "";
  let htmlAttributeBundlePath = "";
  let propertyBundlePath = "";
  let booleanBundlePath = "";
  let styleBundlePath = "";
  let boundTextBundlePath = "";
  let boundCheckBundlePath = "";
  let boundChoiceBundlePath = "";
  let boundRangeBundlePath = "";
  let modifierBundlePath = "";
  let selfBundlePath = "";
  let filteredEventBundlePath = "";
  let eventOptionsBundlePath = "";
  let onceBundlePath = "";
  let dispatchBundlePath = "";
  let computedDispatchBundlePath = "";
  let inlineExpressionBundlePath = "";
  let inlineAttributesBundlePath = "";
  let guardedHandlerBundlePath = "";
  let computedGuardBundlePath = "";
  let refActionBundlePath = "";
  let literalTextBundlePath = "";
  let literalNativeBundlePath = "";
  let staticComputedBundlePath = "";
  let readOnlyBundlePath = "";
  let stringBundlePath = "";
  let formatBundlePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vanilla-aot-"));
    const definition = parseComponent((await readFile(reactiveFixtureUrl, "utf8")).replace('<output $value="count"></output>', '<output>{$count}</output>'), reactiveFixtureUrl.href);
    const module = generateComponent(definition)
      .find((artifact) => artifact.path === "vanilla/ReactiveCounter.js")?.content;
    assert.ok(module);
    assertCompiled(module);

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
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const computedDefinition = parseComponent(
      await readFile(computedFixtureUrl, "utf8"),
      computedFixtureUrl.href,
    );
    const computedModule = generateComponent(computedDefinition)
      .find((artifact) => artifact.path === "vanilla/ComputedCounter.js")?.content;
    assert.ok(computedModule);
    assertCompiled(computedModule);
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
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const selectiveModule = generateComponent(parseComponent(selectiveSource, "split-counter.html"))
      .find((artifact) => artifact.path === "vanilla/SplitCounter.js")?.content;
    assert.ok(selectiveModule);
    assertCompiled(selectiveModule);
    await writeFile(join(directory, "styles/split-counter.css"), "");
    const selectiveEntryPath = join(directory, "vanilla/SplitCounter.js");
    selectiveBundlePath = join(directory, "selective-bundle.js");
    await writeFile(selectiveEntryPath, selectiveModule);
    await build({
      entryPoints: [selectiveEntryPath],
      outfile: selectiveBundlePath,
      bundle: true,
      format: "iife",
      globalName: "SplitCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const liveBranchModule = generateComponent(parseComponent(liveBranchSource, "live-branch.html"))
      .find((artifact) => artifact.path === "vanilla/LiveBranch.js")?.content;
    assert.ok(liveBranchModule);
    await writeFile(join(directory, "styles/live-branch.css"), "");
    const liveBranchEntryPath = join(directory, "vanilla/LiveBranch.js");
    liveBranchBundlePath = join(directory, "live-branch-bundle.js");
    await writeFile(liveBranchEntryPath, liveBranchModule);
    await build({
      entryPoints: [liveBranchEntryPath],
      outfile: liveBranchBundlePath,
      bundle: true,
      format: "iife",
      globalName: "LiveBranch",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const roundedModule = generateComponent(parseComponent(roundedSource, "rounded-counter.html"))
      .find((artifact) => artifact.path === "vanilla/RoundedCounter.js")?.content;
    assert.ok(roundedModule);
    await writeFile(join(directory, "styles/rounded-counter.css"), "");
    const roundedEntryPath = join(directory, "vanilla/RoundedCounter.js");
    roundedBundlePath = join(directory, "rounded-bundle.js");
    await writeFile(roundedEntryPath, roundedModule);
    await build({
      entryPoints: [roundedEntryPath],
      outfile: roundedBundlePath,
      bundle: true,
      format: "iife",
      globalName: "RoundedCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const mixedModule = generateComponent(parseComponent(mixedSource, "mixed-counter.html"))
      .find((artifact) => artifact.path === "vanilla/MixedCounter.js")?.content;
    assert.ok(mixedModule);
    await writeFile(join(directory, "styles/mixed-counter.css"), "");
    const mixedEntryPath = join(directory, "vanilla/MixedCounter.js");
    mixedBundlePath = join(directory, "mixed-bundle.js");
    await writeFile(mixedEntryPath, mixedModule);
    await build({
      entryPoints: [mixedEntryPath],
      outfile: mixedBundlePath,
      bundle: true,
      format: "iife",
      globalName: "MixedCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const dataAttributeModule = generateComponent(parseComponent(dataAttributeSource, "data-counter.html"))
      .find((artifact) => artifact.path === "vanilla/DataCounter.js")?.content;
    assert.ok(dataAttributeModule);
    assertCompiled(dataAttributeModule);
    await writeFile(join(directory, "styles/data-counter.css"), "");
    const dataAttributeEntryPath = join(directory, "vanilla/DataCounter.js");
    dataAttributeBundlePath = join(directory, "data-attribute-bundle.js");
    await writeFile(dataAttributeEntryPath, dataAttributeModule);
    await build({
      entryPoints: [dataAttributeEntryPath],
      outfile: dataAttributeBundlePath,
      bundle: true,
      format: "iife",
      globalName: "DataCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const ariaAttributeModule = generateComponent(parseComponent(ariaAttributeSource, "aria-counter.html"))
      .find((artifact) => artifact.path === "vanilla/AriaCounter.js")?.content;
    assert.ok(ariaAttributeModule);
    assertCompiled(ariaAttributeModule);
    await writeFile(join(directory, "styles/aria-counter.css"), "");
    const ariaAttributeEntryPath = join(directory, "vanilla/AriaCounter.js");
    ariaAttributeBundlePath = join(directory, "aria-attribute-bundle.js");
    await writeFile(ariaAttributeEntryPath, ariaAttributeModule);
    await build({
      entryPoints: [ariaAttributeEntryPath],
      outfile: ariaAttributeBundlePath,
      bundle: true,
      format: "iife",
      globalName: "AriaCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const htmlAttributeModule = generateComponent(parseComponent(htmlAttributeSource, "title-counter.html"))
      .find((artifact) => artifact.path === "vanilla/TitleCounter.js")?.content;
    assert.ok(htmlAttributeModule);
    assertCompiled(htmlAttributeModule);
    await writeFile(join(directory, "styles/title-counter.css"), "");
    const htmlAttributeEntryPath = join(directory, "vanilla/TitleCounter.js");
    htmlAttributeBundlePath = join(directory, "html-attribute-bundle.js");
    await writeFile(htmlAttributeEntryPath, htmlAttributeModule);
    await build({
      entryPoints: [htmlAttributeEntryPath],
      outfile: htmlAttributeBundlePath,
      bundle: true,
      format: "iife",
      globalName: "TitleCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const propertyModule = generateComponent(parseComponent(propertySource, "value-counter.html"))
      .find((artifact) => artifact.path === "vanilla/ValueCounter.js")?.content;
    assert.ok(propertyModule);
    assertCompiled(propertyModule);
    await writeFile(join(directory, "styles/value-counter.css"), "");
    const propertyEntryPath = join(directory, "vanilla/ValueCounter.js");
    propertyBundlePath = join(directory, "property-bundle.js");
    await writeFile(propertyEntryPath, propertyModule);
    await build({
      entryPoints: [propertyEntryPath],
      outfile: propertyBundlePath,
      bundle: true,
      format: "iife",
      globalName: "ValueCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const booleanModule = generateComponent(parseComponent(booleanSource, "boolean-toggle.html"))
      .find((artifact) => artifact.path === "vanilla/BooleanToggle.js")?.content;
    assert.ok(booleanModule);
    assertCompiled(booleanModule);
    await writeFile(join(directory, "styles/boolean-toggle.css"), "");
    const booleanEntryPath = join(directory, "vanilla/BooleanToggle.js");
    booleanBundlePath = join(directory, "boolean-bundle.js");
    await writeFile(booleanEntryPath, booleanModule);
    await build({
      entryPoints: [booleanEntryPath],
      outfile: booleanBundlePath,
      bundle: true,
      format: "iife",
      globalName: "BooleanToggle",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const styleModule = generateComponent(parseComponent(styleSource, "style-counter.html"))
      .find((artifact) => artifact.path === "vanilla/StyleCounter.js")?.content;
    assert.ok(styleModule);
    assertCompiled(styleModule);
    await writeFile(join(directory, "styles/style-counter.css"), "");
    const styleEntryPath = join(directory, "vanilla/StyleCounter.js");
    styleBundlePath = join(directory, "style-bundle.js");
    await writeFile(styleEntryPath, styleModule);
    await build({
      entryPoints: [styleEntryPath],
      outfile: styleBundlePath,
      bundle: true,
      format: "iife",
      globalName: "StyleCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const boundTextModule = generateComponent(parseComponent(boundTextSource, "bound-text.html"))
      .find((artifact) => artifact.path === "vanilla/BoundText.js")?.content;
    assert.ok(boundTextModule);
    assertCompiled(boundTextModule);
    await writeFile(join(directory, "styles/bound-text.css"), "");
    const boundTextEntryPath = join(directory, "vanilla/BoundText.js");
    boundTextBundlePath = join(directory, "bound-text-bundle.js");
    await writeFile(boundTextEntryPath, boundTextModule);
    await build({
      entryPoints: [boundTextEntryPath],
      outfile: boundTextBundlePath,
      bundle: true,
      format: "iife",
      globalName: "BoundText",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const boundCheckModule = generateComponent(parseComponent(boundCheckSource, "bound-check.html"))
      .find((artifact) => artifact.path === "vanilla/BoundCheck.js")?.content;
    assert.ok(boundCheckModule);
    assertCompiled(boundCheckModule);
    await writeFile(join(directory, "styles/bound-check.css"), "");
    const boundCheckEntryPath = join(directory, "vanilla/BoundCheck.js");
    boundCheckBundlePath = join(directory, "bound-check-bundle.js");
    await writeFile(boundCheckEntryPath, boundCheckModule);
    await build({
      entryPoints: [boundCheckEntryPath],
      outfile: boundCheckBundlePath,
      bundle: true,
      format: "iife",
      globalName: "BoundCheck",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const boundChoiceModule = generateComponent(parseComponent(boundChoiceSource, "bound-choice.html"))
      .find((artifact) => artifact.path === "vanilla/BoundChoice.js")?.content;
    assert.ok(boundChoiceModule);
    assertCompiled(boundChoiceModule);
    await writeFile(join(directory, "styles/bound-choice.css"), "");
    const boundChoiceEntryPath = join(directory, "vanilla/BoundChoice.js");
    boundChoiceBundlePath = join(directory, "bound-choice-bundle.js");
    await writeFile(boundChoiceEntryPath, boundChoiceModule);
    await build({
      entryPoints: [boundChoiceEntryPath],
      outfile: boundChoiceBundlePath,
      bundle: true,
      format: "iife",
      globalName: "BoundChoice",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const boundRangeModule = generateComponent(parseComponent(boundRangeSource, "bound-range.html"))
      .find((artifact) => artifact.path === "vanilla/BoundRange.js")?.content;
    assert.ok(boundRangeModule);
    assertCompiled(boundRangeModule);
    await writeFile(join(directory, "styles/bound-range.css"), "");
    const boundRangeEntryPath = join(directory, "vanilla/BoundRange.js");
    boundRangeBundlePath = join(directory, "bound-range-bundle.js");
    await writeFile(boundRangeEntryPath, boundRangeModule);
    await build({
      entryPoints: [boundRangeEntryPath],
      outfile: boundRangeBundlePath,
      bundle: true,
      format: "iife",
      globalName: "BoundRange",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const modifierModule = generateComponent(parseComponent(modifierSource, "event-modifier.html"))
      .find((artifact) => artifact.path === "vanilla/EventModifier.js")?.content;
    assert.ok(modifierModule);
    assertCompiled(modifierModule);
    await writeFile(join(directory, "styles/event-modifier.css"), "");
    const modifierEntryPath = join(directory, "vanilla/EventModifier.js");
    modifierBundlePath = join(directory, "event-modifier-bundle.js");
    await writeFile(modifierEntryPath, modifierModule);
    await build({
      entryPoints: [modifierEntryPath],
      outfile: modifierBundlePath,
      bundle: true,
      format: "iife",
      globalName: "EventModifier",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const selfModule = generateComponent(parseComponent(selfSource, "event-self.html"))
      .find((artifact) => artifact.path === "vanilla/EventSelf.js")?.content;
    assert.ok(selfModule);
    assertCompiled(selfModule);
    await writeFile(join(directory, "styles/event-self.css"), "");
    const selfEntryPath = join(directory, "vanilla/EventSelf.js");
    selfBundlePath = join(directory, "event-self-bundle.js");
    await writeFile(selfEntryPath, selfModule);
    await build({
      entryPoints: [selfEntryPath],
      outfile: selfBundlePath,
      bundle: true,
      format: "iife",
      globalName: "EventSelf",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const filteredEventModule = generateComponent(parseComponent(filteredEventSource, "event-filter.html"))
      .find((artifact) => artifact.path === "vanilla/EventFilter.js")?.content;
    assert.ok(filteredEventModule);
    assertCompiled(filteredEventModule);
    await writeFile(join(directory, "styles/event-filter.css"), "");
    const filteredEventEntryPath = join(directory, "vanilla/EventFilter.js");
    filteredEventBundlePath = join(directory, "event-filter-bundle.js");
    await writeFile(filteredEventEntryPath, filteredEventModule);
    await build({
      entryPoints: [filteredEventEntryPath],
      outfile: filteredEventBundlePath,
      bundle: true,
      format: "iife",
      globalName: "EventFilter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const eventOptionsModule = generateComponent(parseComponent(eventOptionsSource, "event-options.html"))
      .find((artifact) => artifact.path === "vanilla/EventOptions.js")?.content;
    assert.ok(eventOptionsModule);
    assertCompiled(eventOptionsModule);
    await writeFile(join(directory, "styles/event-options.css"), "");
    const eventOptionsEntryPath = join(directory, "vanilla/EventOptions.js");
    eventOptionsBundlePath = join(directory, "event-options-bundle.js");
    await writeFile(eventOptionsEntryPath, eventOptionsModule);
    await build({
      entryPoints: [eventOptionsEntryPath],
      outfile: eventOptionsBundlePath,
      bundle: true,
      format: "iife",
      globalName: "EventOptions",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const onceModule = generateComponent(parseComponent(onceSource, "event-once.html"))
      .find((artifact) => artifact.path === "vanilla/EventOnce.js")?.content;
    assert.ok(onceModule);
    assertCompiled(onceModule);
    await writeFile(join(directory, "styles/event-once.css"), "");
    const onceEntryPath = join(directory, "vanilla/EventOnce.js");
    onceBundlePath = join(directory, "event-once-bundle.js");
    await writeFile(onceEntryPath, onceModule);
    await build({
      entryPoints: [onceEntryPath],
      outfile: onceBundlePath,
      bundle: true,
      format: "iife",
      globalName: "EventOnce",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const dispatchModule = generateComponent(parseComponent(dispatchSource, "event-dispatch.html"))
      .find((artifact) => artifact.path === "vanilla/EventDispatch.js")?.content;
    assert.ok(dispatchModule);
    assertCompiled(dispatchModule);
    await writeFile(join(directory, "styles/event-dispatch.css"), "");
    const dispatchEntryPath = join(directory, "vanilla/EventDispatch.js");
    dispatchBundlePath = join(directory, "event-dispatch-bundle.js");
    await writeFile(dispatchEntryPath, dispatchModule);
    await build({
      entryPoints: [dispatchEntryPath],
      outfile: dispatchBundlePath,
      bundle: true,
      format: "iife",
      globalName: "EventDispatch",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const computedDispatchModule = generateComponent(parseComponent(computedDispatchSource, "computed-event-dispatch.html"))
      .find((artifact) => artifact.path === "vanilla/ComputedEventDispatch.js")?.content;
    assert.ok(computedDispatchModule);
    assertCompiled(computedDispatchModule);
    await writeFile(join(directory, "styles/computed-event-dispatch.css"), "");
    const computedDispatchEntryPath = join(directory, "vanilla/ComputedEventDispatch.js");
    computedDispatchBundlePath = join(directory, "computed-event-dispatch-bundle.js");
    await writeFile(computedDispatchEntryPath, computedDispatchModule);
    await build({
      entryPoints: [computedDispatchEntryPath],
      outfile: computedDispatchBundlePath,
      bundle: true,
      format: "iife",
      globalName: "ComputedEventDispatch",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const inlineExpressionModule = generateComponent(parseComponent(inlineExpressionSource, "inline-expression.html"))
      .find((artifact) => artifact.path === "vanilla/InlineExpression.js")?.content;
    assert.ok(inlineExpressionModule);
    assertCompiled(inlineExpressionModule);
    await writeFile(join(directory, "styles/inline-expression.css"), "");
    const inlineExpressionEntryPath = join(directory, "vanilla/InlineExpression.js");
    inlineExpressionBundlePath = join(directory, "inline-expression-bundle.js");
    await writeFile(inlineExpressionEntryPath, inlineExpressionModule);
    await build({
      entryPoints: [inlineExpressionEntryPath],
      outfile: inlineExpressionBundlePath,
      bundle: true,
      format: "iife",
      globalName: "InlineExpression",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const inlineAttributesModule = generateComponent(parseComponent(inlineAttributesSource, "inline-attributes.html"))
      .find((artifact) => artifact.path === "vanilla/InlineAttributes.js")?.content;
    assert.ok(inlineAttributesModule);
    assertCompiled(inlineAttributesModule);
    await writeFile(join(directory, "styles/inline-attributes.css"), "");
    const inlineAttributesEntryPath = join(directory, "vanilla/InlineAttributes.js");
    inlineAttributesBundlePath = join(directory, "inline-attributes-bundle.js");
    await writeFile(inlineAttributesEntryPath, inlineAttributesModule);
    await build({
      entryPoints: [inlineAttributesEntryPath],
      outfile: inlineAttributesBundlePath,
      bundle: true,
      format: "iife",
      globalName: "InlineAttributes",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const guardedHandlerModule = generateComponent(parseComponent(guardedHandlerSource, "guarded-handler.html"))
      .find((artifact) => artifact.path === "vanilla/GuardedHandler.js")?.content;
    assert.ok(guardedHandlerModule);
    assertCompiled(guardedHandlerModule);
    await writeFile(join(directory, "styles/guarded-handler.css"), "");
    const guardedHandlerEntryPath = join(directory, "vanilla/GuardedHandler.js");
    guardedHandlerBundlePath = join(directory, "guarded-handler-bundle.js");
    await writeFile(guardedHandlerEntryPath, guardedHandlerModule);
    await build({
      entryPoints: [guardedHandlerEntryPath],
      outfile: guardedHandlerBundlePath,
      bundle: true,
      format: "iife",
      globalName: "GuardedHandler",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const computedGuardModule = generateComponent(parseComponent(computedGuardSource, "computed-guard.html"))
      .find((artifact) => artifact.path === "vanilla/ComputedGuard.js")?.content;
    assert.ok(computedGuardModule);
    assertCompiled(computedGuardModule);
    await writeFile(join(directory, "styles/computed-guard.css"), "");
    const computedGuardEntryPath = join(directory, "vanilla/ComputedGuard.js");
    computedGuardBundlePath = join(directory, "computed-guard-bundle.js");
    await writeFile(computedGuardEntryPath, computedGuardModule);
    await build({
      entryPoints: [computedGuardEntryPath],
      outfile: computedGuardBundlePath,
      bundle: true,
      format: "iife",
      globalName: "ComputedGuard",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const refActionModule = generateComponent(parseComponent(refActionSource, "ref-action.html"))
      .find((artifact) => artifact.path === "vanilla/RefAction.js")?.content;
    assert.ok(refActionModule);
    assertCompiled(refActionModule);
    await writeFile(join(directory, "styles/ref-action.css"), "");
    const refActionEntryPath = join(directory, "vanilla/RefAction.js");
    refActionBundlePath = join(directory, "ref-action-bundle.js");
    await writeFile(refActionEntryPath, refActionModule);
    await build({
      entryPoints: [refActionEntryPath],
      outfile: refActionBundlePath,
      bundle: true,
      format: "iife",
      globalName: "RefAction",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const literalTextModule = generateComponent(parseComponent(literalTextSource, "literal-text.html"))
      .find((artifact) => artifact.path === "vanilla/LiteralText.js")?.content;
    assert.ok(literalTextModule);
    assertCompiled(literalTextModule);
    await writeFile(join(directory, "styles/literal-text.css"), "");
    const literalTextEntryPath = join(directory, "vanilla/LiteralText.js");
    literalTextBundlePath = join(directory, "literal-text-bundle.js");
    await writeFile(literalTextEntryPath, literalTextModule);
    await build({
      entryPoints: [literalTextEntryPath],
      outfile: literalTextBundlePath,
      bundle: true,
      format: "iife",
      globalName: "LiteralText",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const literalNativeModule = generateComponent(parseComponent(literalNativeSource, "literal-native.html"))
      .find((artifact) => artifact.path === "vanilla/LiteralNative.js")?.content;
    assert.ok(literalNativeModule);
    assertCompiled(literalNativeModule);
    await writeFile(join(directory, "styles/literal-native.css"), "");
    const literalNativeEntryPath = join(directory, "vanilla/LiteralNative.js");
    literalNativeBundlePath = join(directory, "literal-native-bundle.js");
    await writeFile(literalNativeEntryPath, literalNativeModule);
    await build({
      entryPoints: [literalNativeEntryPath],
      outfile: literalNativeBundlePath,
      bundle: true,
      format: "iife",
      globalName: "LiteralNative",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const staticComputedModule = generateComponent(parseComponent(staticComputedSource, "static-computed.html"))
      .find((artifact) => artifact.path === "vanilla/StaticComputed.js")?.content;
    assert.ok(staticComputedModule);
    assertCompiled(staticComputedModule);
    await writeFile(join(directory, "styles/static-computed.css"), "");
    const staticComputedEntryPath = join(directory, "vanilla/StaticComputed.js");
    staticComputedBundlePath = join(directory, "static-computed-bundle.js");
    await writeFile(staticComputedEntryPath, staticComputedModule);
    await build({
      entryPoints: [staticComputedEntryPath],
      outfile: staticComputedBundlePath,
      bundle: true,
      format: "iife",
      globalName: "StaticComputed",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const readOnlyModule = generateComponent(parseComponent(readOnlySource, "read-only-label.html"))
      .find((artifact) => artifact.path === "vanilla/ReadOnlyLabel.js")?.content;
    assert.ok(readOnlyModule);
    assertCompiled(readOnlyModule);
    await writeFile(join(directory, "styles/read-only-label.css"), "");
    const readOnlyEntryPath = join(directory, "vanilla/ReadOnlyLabel.js");
    readOnlyBundlePath = join(directory, "read-only-bundle.js");
    await writeFile(readOnlyEntryPath, readOnlyModule);
    await build({
      entryPoints: [readOnlyEntryPath],
      outfile: readOnlyBundlePath,
      bundle: true,
      format: "iife",
      globalName: "ReadOnlyLabel",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const stringModule = generateComponent(parseComponent(stringSource, "string-tabs.html"))
      .find((artifact) => artifact.path === "vanilla/StringTabs.js")?.content;
    assert.ok(stringModule);
    assertCompiled(stringModule);
    await writeFile(join(directory, "styles/string-tabs.css"), "");
    const stringEntryPath = join(directory, "vanilla/StringTabs.js");
    stringBundlePath = join(directory, "string-bundle.js");
    await writeFile(stringEntryPath, stringModule);
    await build({
      entryPoints: [stringEntryPath],
      outfile: stringBundlePath,
      bundle: true,
      format: "iife",
      globalName: "StringTabs",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });

    const formatModule = generateComponent(parseComponent(formatSource, "format-counter.html"))
      .find((artifact) => artifact.path === "vanilla/FormatCounter.js")?.content;
    assert.ok(formatModule);
    assertCompiled(formatModule);
    await writeFile(join(directory, "styles/format-counter.css"), "");
    const formatEntryPath = join(directory, "vanilla/FormatCounter.js");
    formatBundlePath = join(directory, "format-bundle.js");
    await writeFile(formatEntryPath, formatModule);
    await build({
      entryPoints: [formatEntryPath],
      outfile: formatBundlePath,
      bundle: true,
      format: "iife",
      globalName: "FormatCounter",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
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
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          const before = output.textContent;
          (component as HTMLButtonElement).click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = output.textContent;
          component.remove();
          (component as HTMLButtonElement).click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = output.textContent;
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          (component as HTMLButtonElement).click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { before, connected, detached, reconnected: output.textContent };
        });
        // A click in the same task as remove() still reaches the instance: like live, the disconnect
        // is observed after the task, so that click counts and shows once the root reconnects.
        assert.deepEqual(result, { before: "0", connected: "1", detached: "1", reconnected: "3" });
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
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          const before = output.textContent;
          (component as HTMLButtonElement).click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { before, after: output.textContent };
        });
        assert.deepEqual(result, { before: "2", after: "4" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} only updates affected directly compiled numeric branches`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: selectiveBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            SplitCounter: { createSplitCounter(): Element };
          }).SplitCounter;
          const component = api.createSplitCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const buttons = Array.from(component.querySelectorAll("button"));
          const outputs = Array.from(component.querySelectorAll("output"));
          const values = () => outputs.map((output) => output.textContent);
          const initial = values();
          buttons[1]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterRight = values();
          buttons[0]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, afterRight, afterLeft: values() };
        });
        assert.deepEqual(result, {
          initial: ["4", "14"],
          afterRight: ["4", "15"],
          afterLeft: ["5", "16"],
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves the visible direct branch when unused branches are elided`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: liveBranchBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            LiveBranch: { createLiveBranch(): Element };
          }).LiveBranch;
          const component = api.createLiveBranch();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const buttons = component.querySelectorAll("button");
          const output = component.querySelector("output")!;
          const initial = output.textContent;
          buttons[1]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterRight = output.textContent;
          buttons[0]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, afterRight, afterLeft: output.textContent };
        });
        assert.deepEqual(result, { initial: "11", afterRight: "12", afterLeft: "12" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves rounded direct output across equal and changed updates`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: roundedBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            RoundedCounter: { createRoundedCounter(): Element };
          }).RoundedCounter;
          const component = api.createRoundedCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          const initial = output.textContent;
          for (let index = 0; index < 4; index += 1) {
            component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const afterEqual = output.textContent;
          component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, afterEqual, afterChanged: output.textContent };
        });
        assert.deepEqual(result, { initial: "0", afterEqual: "0", afterChanged: "1" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} updates ordinary and rounded direct outputs independently`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: mixedBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            MixedCounter: { createMixedCounter(): Element };
          }).MixedCounter;
          const component = api.createMixedCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const outputs = Array.from(component.querySelectorAll("output"));
          const values = () => outputs.map((output) => output.textContent);
          for (let index = 0; index < 4; index += 1) {
            component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const afterEqual = values();
          component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { afterEqual, afterChanged: values() };
        });
        assert.deepEqual(result, { afterEqual: ["0.4", "0"], afterChanged: ["0.5", "1"] });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled numeric data attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: dataAttributeBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            DataCounter: { createDataCounter(): Element };
          }).DataCounter;
          const component = api.createDataCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          for (let index = 0; index < 4; index += 1) {
            component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const afterEqual = { value: output.textContent, bucket: component.getAttribute("data-bucket") };
          component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { afterEqual, afterChanged: { value: output.textContent, bucket: component.getAttribute("data-bucket") } };
        });
        assert.deepEqual(result, {
          afterEqual: { value: "0.4", bucket: "0" },
          afterChanged: { value: "0.5", bucket: "1" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled numeric ARIA attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: ariaAttributeBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            AriaCounter: { createAriaCounter(): Element };
          }).AriaCounter;
          const component = api.createAriaCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          for (let index = 0; index < 4; index += 1) {
            component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const afterEqual = {
            value: component.getAttribute("aria-valuenow"),
            text: component.getAttribute("aria-valuetext"),
          };
          component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            afterEqual,
            afterChanged: {
              value: component.getAttribute("aria-valuenow"),
              text: component.getAttribute("aria-valuetext"),
            },
          };
        });
        assert.deepEqual(result, {
          afterEqual: { value: "0.4", text: "0" },
          afterChanged: { value: "0.5", text: "1" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled numeric HTML attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: htmlAttributeBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            TitleCounter: { createTitleCounter(): Element };
          }).TitleCounter;
          const component = api.createTitleCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          for (let index = 0; index < 4; index += 1) {
            component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const afterEqual = { output: component.querySelector("output")!.textContent, title: component.getAttribute("title") };
          component.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { afterEqual, afterChanged: { output: component.querySelector("output")!.textContent, title: component.getAttribute("title") } };
        });
        assert.deepEqual(result, {
          afterEqual: { output: "0.4", title: "0" },
          afterChanged: { output: "0.5", title: "1" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled numeric HTML properties`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: propertyBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            ValueCounter: { createValueCounter(): Element };
          }).ValueCounter;
          const component = api.createValueCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const button = component.querySelector("button")!;
          const input = component.querySelector("input")!;
          for (let index = 0; index < 4; index += 1) {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const afterEqual = { output: component.querySelector("output")!.textContent, value: input.value };
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { afterEqual, afterChanged: { output: component.querySelector("output")!.textContent, value: input.value } };
        });
        assert.deepEqual(result, {
          afterEqual: { output: "0.4", value: "0" },
          afterChanged: { output: "0.5", value: "1" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled boolean attributes and properties`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: booleanBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            BooleanToggle: { createBooleanToggle(): HTMLButtonElement };
          }).BooleanToggle;
          const component = api.createBooleanToggle();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({
            expanded: component.getAttribute("aria-expanded"),
            hidden: component.getAttribute("hidden"),
            open: component.classList.contains("open"),
            checked: input.checked,
            output: output.textContent,
          });
          const initial = snapshot();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { expanded: "false", hidden: "", open: false, checked: false, output: "true" },
          connected: { expanded: "true", hidden: null, open: true, checked: true, output: "false" },
          detached: { expanded: "true", hidden: null, open: true, checked: true, output: "false" },
          // The click in the same task as remove() toggled it back; a second toggle shows on reconnect.
          reconnected: { expanded: "true", hidden: null, open: true, checked: true, output: "false" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled primitive styles and honors connection lifecycle`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: styleBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            StyleCounter: { createStyleCounter(): HTMLButtonElement };
          }).StyleCounter;
          const component = api.createStyleCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          const chart = component.querySelector("svg")!;
          const snapshot = () => ({ count: chart.style.getPropertyValue("--count"), output: output.textContent });
          const initial = snapshot();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { count: "0", output: "0" },
          connected: { count: "1", output: "1" },
          detached: { count: "1", output: "1" },
          // The click in the same task as remove() counts, as in live.
          reconnected: { count: "3", output: "3" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} binds directly compiled text controls without resetting their native dirty value`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: boundTextBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            BoundText: { createBoundText(): HTMLElement };
          }).BoundText;
          const component = api.createBoundText();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({ value: input.value, output: output.textContent });
          const initial = snapshot();
          input.value = "Changed";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          input.value = "Detached";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          input.value = "Reconnected";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { value: "Ready", output: "Ready" },
          connected: { value: "Changed", output: "Changed" },
          detached: { value: "Detached", output: "Changed" },
          reconnected: { value: "Reconnected", output: "Reconnected" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} binds directly compiled checkboxes and honors connection lifecycle`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: boundCheckBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            BoundCheck: { createBoundCheck(): HTMLElement };
          }).BoundCheck;
          const component = api.createBoundCheck();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({ checked: input.checked, output: output.textContent });
          const initial = snapshot();
          input.checked = true;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          input.checked = false;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          input.checked = false;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { checked: false, output: "false" },
          connected: { checked: true, output: "true" },
          detached: { checked: false, output: "true" },
          reconnected: { checked: false, output: "false" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} binds directly compiled textarea and single-select controls`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: boundChoiceBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            BoundChoice: { createBoundChoice(): HTMLElement };
          }).BoundChoice;
          const component = api.createBoundChoice();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const textarea = component.querySelector("textarea")!;
          const select = component.querySelector("select")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({ textarea: textarea.value, select: select.value, output: output.textContent });
          const initial = snapshot();
          textarea.value = "two";
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const textChanged = snapshot();
          select.value = "one";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const selectChanged = snapshot();
          component.remove();
          textarea.value = "detached";
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, textChanged, selectChanged, detached: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { textarea: "one", select: "one", output: "one" },
          textChanged: { textarea: "two", select: "two", output: "two" },
          selectChanged: { textarea: "one", select: "one", output: "one" },
          detached: { textarea: "detached", select: "one", output: "one" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} binds directly compiled ranges through their finite numeric value`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: boundRangeBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            BoundRange: { createBoundRange(): HTMLElement };
          }).BoundRange;
          const component = api.createBoundRange();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({ value: input.value, number: input.valueAsNumber, output: output.textContent });
          const initial = snapshot();
          input.value = "25";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          input.value = "50";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          input.value = "75";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { value: "0", number: 0, output: "0" },
          connected: { value: "25", number: 25, output: "25" },
          detached: { value: "50", number: 50, output: "25" },
          reconnected: { value: "75", number: 75, output: "75" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} applies direct prevent and stop modifiers only while connected`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: modifierBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            EventModifier: { createEventModifier(): HTMLElement };
          }).EventModifier;
          const component = api.createEventModifier();
          const main = document.querySelector("main")!;
          let bubbled = 0;
          main.addEventListener("click", () => { bubbled += 1; });
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const button = component.querySelector("button")!;
          const output = component.querySelector("output")!;
          const dispatch = () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          const connected = { accepted: dispatch(), bubbled, output: output.textContent };
          component.remove();
          const detached = { accepted: dispatch(), bubbled, output: output.textContent };
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const reconnected = { accepted: dispatch(), bubbled, output: output.textContent };
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { connected, detached, reconnected: { ...reconnected, output: output.textContent } };
        });
        // A click in the same task as remove() still reaches the instance: like live, the disconnect
        // is observed after the task, so that click counts and shows once the root reconnects.
        assert.deepEqual(result, {
          connected: { accepted: false, bubbled: 0, output: "0" },
          detached: { accepted: false, bubbled: 0, output: "0" },
          reconnected: { accepted: false, bubbled: 0, output: "3" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} applies direct self modifiers before handler scheduling`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: selfBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            EventSelf: { createEventSelf(): HTMLElement };
          }).EventSelf;
          const component = api.createEventSelf();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const button = component.querySelector("button")!;
          const inner = component.querySelector("span")!;
          const output = component.querySelector("output")!;
          inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const innerClick = output.textContent;
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const buttonClick = output.textContent;
          component.remove();
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { innerClick, buttonClick, detached: output.textContent };
        });
        assert.deepEqual(result, { innerClick: "0", buttonClick: "1", detached: "1" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves native filtered-event behavior in the direct emitter`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: filteredEventBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            EventFilter: { createEventFilter(): HTMLElement };
          }).EventFilter;
          const component = api.createEventFilter();
          const main = document.querySelector("main")!;
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const keys = component.querySelector<HTMLButtonElement>(".keys")!;
          const inner = component.querySelector("span")!;
          const mouse = component.querySelector<HTMLButtonElement>(".mouse")!;
          const output = component.querySelector("output")!;
          let bubbled = 0;
          main.addEventListener("keydown", () => { bubbled += 1; });
          const dispatchKey = (target: EventTarget, init: KeyboardEventInit) =>
            target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
          const snapshot = (accepted: boolean) => ({ accepted, bubbled, output: output.textContent });
          const innerKey = snapshot(dispatchKey(inner, { key: "Enter", ctrlKey: true }));
          const wrongKey = snapshot(dispatchKey(keys, { key: "Escape", ctrlKey: true }));
          const inexactKey = snapshot(dispatchKey(keys, { key: "Enter", ctrlKey: true, shiftKey: true }));
          const plainKey = snapshot(keys.dispatchEvent(new Event("keydown", { bubbles: true, cancelable: true })));
          const matchedKey = snapshot(dispatchKey(keys, { key: "Enter", ctrlKey: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterKey = output.textContent;
          const middleMouse = mouse.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 1 }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterMiddle = output.textContent;
          const plainMouse = mouse.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterPlainMouse = output.textContent;
          component.remove();
          const detached = dispatchKey(keys, { key: "Enter", ctrlKey: true });
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { innerKey, wrongKey, inexactKey, plainKey, matchedKey, afterKey, middleMouse, afterMiddle, plainMouse, afterPlainMouse, detached, afterDetached: output.textContent };
        });
        assert.deepEqual(result, {
          innerKey: { accepted: true, bubbled: 1, output: "0" },
          wrongKey: { accepted: true, bubbled: 2, output: "0" },
          inexactKey: { accepted: true, bubbled: 3, output: "0" },
          plainKey: { accepted: true, bubbled: 4, output: "0" },
          matchedKey: { accepted: false, bubbled: 4, output: "0" },
          afterKey: "1",
          middleMouse: true,
          afterMiddle: "1",
          plainMouse: true,
          afterPlainMouse: "2",
          detached: false,
          afterDetached: "2",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves capture, passive, and detached listener behavior in the direct emitter`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: eventOptionsBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            EventOptions: { createEventOptions(): HTMLElement };
          }).EventOptions;
          const component = api.createEventOptions();
          const main = document.querySelector("main")!;
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const button = component.querySelector("button")!;
          const inner = component.querySelector("span")!;
          const output = component.querySelector("output")!;
          const order: string[] = [];
          main.addEventListener("click", () => order.push("main-capture"), true);
          button.addEventListener("click", () => order.push("button-after"), true);
          inner.addEventListener("click", () => order.push("inner-target"));
          main.addEventListener("click", () => order.push("main-bubble"));
          const dispatch = () => inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          const connected = dispatch();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connectedResult = { accepted: connected, order: [...order], output: output.textContent };
          component.remove();
          order.length = 0;
          const detached = dispatch();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detachedResult = { accepted: detached, order: [...order], output: output.textContent };
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          order.length = 0;
          const reconnected = dispatch();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { connected: connectedResult, detached: detachedResult, reconnected: { accepted: reconnected, order, output: output.textContent } };
        });
        // A click in the same task as remove() still reaches the instance: like live, the disconnect
        // is observed after the task, so that click counts and shows once the root reconnects.
        assert.deepEqual(result, {
          connected: { accepted: true, order: ["main-capture", "button-after"], output: "1" },
          detached: { accepted: true, order: ["button-after"], output: "1" },
          reconnected: { accepted: true, order: ["main-capture", "button-after"], output: "3" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} consumes a direct once listener once, across connected periods, as live does`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: onceBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            EventOnce: { createEventOnce(): HTMLElement };
          }).EventOnce;
          const component = api.createEventOnce();
          const main = document.querySelector("main")!;
          const button = component.querySelector("button")!;
          const output = component.querySelector("output")!;
          const dispatch = (key: string) => button.dispatchEvent(new KeyboardEvent("keydown", {
            key, bubbles: true, cancelable: true,
          }));
          const initiallyDetached = dispatch("Enter");
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const nonmatchingConsumes = dispatch("Escape");
          const sameConnection = dispatch("Enter");
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterFirstConnection = output.textContent;
          component.remove();
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detachedAgain = dispatch("Enter");
          main.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const reconnected = dispatch("Enter");
          const consumedAgain = dispatch("Enter");
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initiallyDetached, nonmatchingConsumes, sameConnection, afterFirstConnection, detachedAgain, reconnected, consumedAgain, afterReconnect: output.textContent };
        });
        assert.deepEqual(result, {
          initiallyDetached: true,
          nonmatchingConsumes: true,
          sameConnection: true,
          afterFirstConnection: "0",
          detachedAgain: true,
          reconnected: true,
          consumedAgain: true,
          // A `.once` listener is consumed for the instance's life, not each connected period (live's rule).
          afterReconnect: "0",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} dispatches declared primitive events directly while connected`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: dispatchBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            EventDispatch: { createEventDispatch(): HTMLButtonElement };
          }).EventDispatch;
          const component = api.createEventDispatch();
          const events: Array<{ readonly detail: unknown; readonly bubbles: boolean; readonly composed: boolean; readonly cancelable: boolean }> = [];
          component.addEventListener("saved", (event) => {
            events.push({
              detail: (event as CustomEvent).detail,
              bubbles: event.bubbles,
              composed: event.composed,
              cancelable: event.cancelable,
            });
          });
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connectedOutput = output.textContent;
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { events, connectedOutput, detachedOutput: output.textContent };
        });
        // A click in the same task as remove() still reaches the instance: like live, the disconnect
        // is observed after the task, so that click counts and shows once the root reconnects.
        assert.deepEqual(result, {
          events: [{ detail: 1, bubbles: false, composed: false, cancelable: true }, { detail: 2, bubbles: false, composed: false, cancelable: true }],
          connectedOutput: "1",
          detachedOutput: "1",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} dispatches fresh primitive computed event detail directly`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: computedDispatchBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            ComputedEventDispatch: { createComputedEventDispatch(): HTMLButtonElement };
          }).ComputedEventDispatch;
          const component = api.createComputedEventDispatch();
          const events: unknown[] = [];
          component.addEventListener("saved", (event) => events.push((event as CustomEvent).detail));
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connectedOutput = output.textContent;
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { events, connectedOutput, detachedOutput: output.textContent };
        });
        // A click in the same task as remove() still reaches the instance: like live, the disconnect
        // is observed after the task, so that click counts and shows once the root reconnects.
        assert.deepEqual(result, { events: [2, 4, 6, 8], connectedOutput: "5", detachedOutput: "5" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders inline primitive text expressions directly`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: inlineExpressionBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            InlineExpression: { createInlineExpression(): HTMLButtonElement };
          }).InlineExpression;
          const component = api.createInlineExpression();
          const output = component.querySelector("output")!;
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const initial = output.textContent;
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = output.textContent;
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached: output.textContent };
        });
        assert.deepEqual(result, { initial: "1", connected: "2", detached: "2" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders inline primitive native expressions directly`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: inlineAttributesBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            InlineAttributes: { createInlineAttributes(): HTMLElement };
          }).InlineAttributes;
          const component = api.createInlineAttributes();
          const button = component.querySelector("button")!;
          const input = component.querySelector("input")!;
          const snapshot = () => ({
            count: component.getAttribute("data-count"),
            zero: component.classList.contains("zero"),
            style: component.style.getPropertyValue("--count"),
            value: input.value,
          });
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const initial = snapshot();
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { count: "1", zero: true, style: "1", value: "1" },
          connected: { count: "2", zero: false, style: "2", value: "2" },
          detached: { count: "2", zero: false, style: "2", value: "2" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves guarded direct handler ordering and detachment`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: guardedHandlerBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            GuardedHandler: { createGuardedHandler(): HTMLButtonElement };
          }).GuardedHandler;
          const component = api.createGuardedHandler();
          const events: unknown[] = [];
          component.addEventListener("saved", (event) => events.push((event as CustomEvent).detail));
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = component.querySelector("output")!;
          component.click();
          component.click();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = output.textContent;
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { events, connected, detached: output.textContent };
        });
        assert.deepEqual(result, { events: [1, 2], connected: "2", detached: "2" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} pulls computed guards after prior writes and preserves guarded event ordering`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: computedGuardBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            ComputedGuard: { createComputedGuard(): HTMLButtonElement };
          }).ComputedGuard;
          const component = api.createComputedGuard();
          const events: unknown[] = [];
          component.addEventListener("saved", (event) => events.push((event as CustomEvent).detail));
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const outputs = component.querySelectorAll("output");
          component.click();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = Array.from(outputs, (output) => output.textContent);
          component.remove();
          component.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { events, connected, detached: Array.from(outputs, (output) => output.textContent) };
        });
        assert.deepEqual(result, { events: [2], connected: ["2", "1"], detached: ["2", "1"] });
      } finally {
        await browser.close();
      }
    });

    it(`${name} runs direct validation and static ref focus while connected`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: refActionBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            RefAction: { createRefAction(): HTMLElement };
          }).RefAction;
          const component = api.createRefAction();
          const inputs = component.querySelectorAll("input");
          const button = component.querySelector("button")!;
          const output = component.querySelector("output")!;
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = {
            count: output.textContent,
            invalid: inputs[0]!.validity.valueMissing,
            focusedRef: document.activeElement === inputs[0],
          };
          component.remove();
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { connected, detached: output.textContent };
        });
        assert.deepEqual(result, {
          connected: { count: "1", invalid: true, focusedRef: true },
          detached: "1",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders direct literal text beside dynamic output and stays inert when detached`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: literalTextBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            LiteralText: { createLiteralText(): HTMLElement };
          }).LiteralText;
          const component = api.createLiteralText();
          const status = component.querySelector("output.status")!;
          const count = component.querySelector("button output")!;
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const initial = { status: status.textContent, count: count.textContent };
          component.querySelector("button")!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = { status: status.textContent, count: count.textContent };
          component.remove();
          component.querySelector("button")!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached: { status: status.textContent, count: count.textContent } };
        });
        assert.deepEqual(result, {
          initial: { status: "Ready", count: "0" },
          connected: { status: "Ready", count: "1" },
          detached: { status: "Ready", count: "1" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} initializes direct literal native bindings without reapplying them on updates`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: literalNativeBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            LiteralNative: { createLiteralNative(): HTMLElement };
          }).LiteralNative;
          const component = api.createLiteralNative();
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({
            status: component.getAttribute("data-status"),
            ariaHidden: component.getAttribute("aria-hidden"),
            hidden: component.hasAttribute("hidden"),
            fixed: component.classList.contains("fixed"),
            gap: component.style.getPropertyValue("--gap"),
            value: input.value,
            count: output.textContent,
          });
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const initial = snapshot();
          input.value = "Draft";
          component.querySelector("button")!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          component.querySelector("button")!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { status: "ready", ariaHidden: "false", hidden: true, fixed: true, gap: "4", value: "Fixed", count: "0" },
          connected: { status: "ready", ariaHidden: "false", hidden: true, fixed: true, gap: "4", value: "Draft", count: "1" },
          detached: { status: "ready", ariaHidden: "false", hidden: true, fixed: true, gap: "4", value: "Draft", count: "1" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps transitively constant direct computeds at construction while handlers can read them`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: staticComputedBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            StaticComputed: { createStaticComputed(): HTMLElement };
          }).StaticComputed;
          const component = api.createStaticComputed();
          const status = component.querySelector("output.status")!;
          const count = component.querySelector("button output")!;
          const input = component.querySelector("input")!;
          const buttons = component.querySelectorAll("button");
          const events: unknown[] = [];
          component.addEventListener("saved", (event) => events.push((event as CustomEvent).detail));
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const snapshot = () => ({
            status: status.textContent,
            count: count.textContent,
            dataStatus: component.getAttribute("data-status"),
            ready: component.classList.contains("ready"),
            style: component.style.getPropertyValue("--label"),
            value: input.value,
          });
          const initial = snapshot();
          input.value = "Draft";
          buttons[0]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          buttons[1]!.click();
          const connected = { ...snapshot(), events: [...events] };
          component.remove();
          buttons[0]!.click();
          buttons[1]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached: { ...snapshot(), events } };
        });
        assert.deepEqual(result, {
          initial: { status: "Ready!", count: "0", dataStatus: "Ready!", ready: true, style: "Ready", value: "Ready!" },
          connected: { status: "Ready!", count: "1", dataStatus: "Ready!", ready: true, style: "Ready", value: "Draft", events: ["Ready!"] },
          // The save in the same task as remove() still dispatches, as in live.
          detached: { status: "Ready!", count: "1", dataStatus: "Ready!", ready: true, style: "Ready", value: "Draft", events: ["Ready!", "Ready!"] },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} constructs a read-only direct reactive leaf without lifecycle runtime work`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: readOnlyBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            ReadOnlyLabel: { createReadOnlyLabel(): HTMLElement };
          }).ReadOnlyLabel;
          const component = api.createReadOnlyLabel();
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({
            label: component.getAttribute("data-label"),
            ready: component.classList.contains("ready"),
            input: input.value,
            output: output.textContent,
            child: component.querySelector("article.child")?.getAttribute("aria-label"),
            projected: component.querySelector("article.child > span")?.textContent,
            grandchild: component.querySelector("article.child > span > strong")?.localName,
            grandchildTitle: component.querySelector("article.child > span > strong")?.getAttribute("title"),
          });
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const initial = snapshot();
          input.value = "Draft";
          await new Promise((resolve) => setTimeout(resolve, 0));
          component.remove();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, detached: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { label: "Ready 1", ready: true, input: "Ready 1", output: "Ready 1", child: "Ready child", projected: "Projected", grandchild: "strong", grandchildTitle: "Ready grandchild" },
          detached: { label: "Ready 1", ready: true, input: "Draft", output: "Ready 1", child: "Ready child", projected: "Projected", grandchild: "strong", grandchildTitle: "Ready grandchild" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled string modes and honors connection lifecycle`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: stringBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            StringTabs: { createStringTabs(): HTMLElement };
          }).StringTabs;
          const component = api.createStringTabs();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const buttons = component.querySelectorAll("button");
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({
            tab: component.getAttribute("data-tab"),
            title: component.getAttribute("title"),
            value: input.value,
            output: output.textContent,
          });
          const initial = snapshot();
          buttons[1]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          buttons[0]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          buttons[0]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { tab: "one", title: "one", value: "one", output: "one" },
          connected: { tab: "two", title: "two", value: "two", output: "two" },
          detached: { tab: "two", title: "two", value: "two", output: "two" },
          reconnected: { tab: "one", title: "one", value: "one", output: "one" },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} publishes directly compiled literal formatted text`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: formatBundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as {
            FormatCounter: { createFormatCounter(): HTMLElement };
          }).FormatCounter;
          const component = api.createFormatCounter();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const button = component.querySelector("button")!;
          const input = component.querySelector("input")!;
          const output = component.querySelector("output")!;
          const snapshot = () => ({
            label: component.getAttribute("aria-label"),
            value: input.value,
            output: output.textContent,
          });
          const initial = snapshot();
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const connected = snapshot();
          component.remove();
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = snapshot();
          document.querySelector("main")!.append(component);
          await new Promise((resolve) => setTimeout(resolve, 0));
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, connected, detached, reconnected: snapshot() };
        });
        assert.deepEqual(result, {
          initial: { label: "Step 0", value: "Step 0", output: "Step 0" },
          connected: { label: "Step 1", value: "Step 1", output: "Step 1" },
          detached: { label: "Step 1", value: "Step 1", output: "Step 1" },
          // The click in the same task as remove() counts, as in live.
          reconnected: { label: "Step 3", value: "Step 3", output: "Step 3" },
        });
      } finally {
        await browser.close();
      }
    });
  }
});

describe.skipIf(!enabled)("generated Vanilla handler value dependencies", () => {
  let directory = "";
  let bundlePath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-handler-values-"));
    await mkdir(join(directory, "vanilla"), { recursive: true });
    await mkdir(join(directory, "styles"), { recursive: true });
    const sources = [
      `<template component="set-input" status="experimental" summary="Set input dependency.">
        <defs><state type="number" name="count" value="0"></state><state type="number" name="snapshot" value="0"></state><handler name="save"><set name="snapshot" expr:value="count + 1"></set></handler></defs>
        <button on:click="save"><output $value="snapshot"></output></button>
      </template>`,
      `<template component="sequential-sets" status="experimental" summary="Sequential sets.">
        <defs><state type="number" name="count" value="0"></state><state type="number" name="snapshot" value="0"></state><computed name="double" from="count * 2"></computed><handler name="advance"><set name="count" expr:value="count + 1"></set><set name="snapshot" expr:value="double"></set></handler></defs>
        <button on:click="advance"><output $value="snapshot"></output></button>
      </template>`,
    ];
    for (const source of sources) {
      const artifacts = generateComponent(parseComponent(source));
      const module = artifacts.find(({ path }) => path.startsWith("vanilla/") && path.endsWith(".js"));
      assert.ok(module);
      assertCompiled(module.content);
      await writeFile(join(directory, module.path), module.content);
      const css = artifacts.find(({ path }) => path.endsWith(".css"));
      assert.ok(css);
      await writeFile(join(directory, css.path), css.content);
    }
    const entryPath = join(directory, "entry.ts");
    bundlePath = join(directory, "bundle.js");
    await writeFile(entryPath, `export { createSetInput } from "./vanilla/SetInput.js";\nexport { createSequentialSets } from "./vanilla/SequentialSets.js";`);
    await build({
      entryPoints: [entryPath], outfile: bundlePath, bundle: true, format: "iife",
      globalName: "HandlerValues", platform: "browser", target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  for (const [name, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${name} reads hidden set dependencies and refreshes sequential computed values`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as { HandlerValues: {
            createSetInput(): HTMLElement;
            createSequentialSets(): HTMLElement;
          } }).HandlerValues;
          const first = api.createSetInput();
          const second = api.createSequentialSets();
          document.querySelector("main")!.append(first, second);
          await new Promise((resolve) => setTimeout(resolve, 0));
          first.click();
          second.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return [first.querySelector("output")?.textContent, second.querySelector("output")?.textContent];
        });
        assert.deepEqual(result, ["1", "2"]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
});

describe.skipIf(!enabled)("generated Vanilla AOT props", () => {
  let bundlePath = "";
  let mixedBundlePath = "";
  let singleBundlePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vanilla-props-"));
    const definition = parseComponent(`<template component="demo-props" status="experimental" summary="Props.">
      <props>
        <prop name="count" type="number" default="1">Count.</prop>
        <prop name="label" type="string" default="Ready">Label.</prop>
        <prop name="tone" type="keyword" values="quiet, loud" default="quiet">Tone.</prop>
      </props>
      <section from:data-count="count" from:data-tone="tone"><output $value="count"></output><span from:aria-label="label">{$label} / {$count}</span><slot></slot></section>
    </template>`);
    const module = generateComponent(definition)
      .find((artifact) => artifact.path === "vanilla/DemoProps.js")?.content;
    assert.ok(module);
    assert.match(module, /html-next\/generated-runtime/);
    assert.doesNotMatch(module, /html-next\/runtime/);

    await mkdir(join(directory, "vanilla"), { recursive: true });
    await mkdir(join(directory, "styles"), { recursive: true });
    await writeFile(join(directory, "styles/demo-props.css"), "");
    await writeFile(join(directory, "vanilla/DemoProps.js"), module);
    const entryPath = join(directory, "entry.ts");
    bundlePath = join(directory, "bundle.js");
    await writeFile(
      entryPath,
      `export { createDemoProps } from "./vanilla/DemoProps.js";\n` +
      `export { updateGeneratedProps } from "@nextwebwg/html-next/generated-runtime";\n`,
    );
    await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      format: "iife",
      globalName: "DemoProps",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
    });
    const singleDefinition = parseComponent(`<template component="single-prop" status="experimental" summary="Single prop.">
      <props><prop name="value" type="number" default="1">Value.</prop></props>
      <input type="number" .value="value">
    </template>`);
    const singleModule = generateComponent(singleDefinition)
      .find((artifact) => artifact.path === "vanilla/SingleProp.js")?.content;
    assert.ok(singleModule);
    assertCompiled(singleModule);
    await writeFile(join(directory, "styles/single-prop.css"), "");
    await writeFile(join(directory, "vanilla/SingleProp.js"), singleModule);
    const singleEntryPath = join(directory, "single.ts");
    singleBundlePath = join(directory, "single.js");
    await writeFile(
      singleEntryPath,
      `export { createSingleProp } from "./vanilla/SingleProp.js";\n` +
      `export { updateGeneratedProps } from "@nextwebwg/html-next/generated-runtime";\n`,
    );
    await build({
      entryPoints: [singleEntryPath],
      outfile: singleBundlePath,
      bundle: true,
      format: "iife",
      globalName: "SingleProp",
      platform: "browser",
      target: ["es2022"],
      loader: { ".css": "empty" },
      alias: { "@nextwebwg/html-next/generated-runtime": generatedRuntimePath, "@nextwebwg/html-next/runtime": runtimePath },
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
    it(`${name} updates a compact scalar native property prop`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: singleBundlePath });
        const result = await page.evaluate(async () => {
          const { createSingleProp: create, updateGeneratedProps: update } = (window as unknown as {
            SingleProp: {
              createSingleProp(options?: Record<string, unknown>): HTMLInputElement;
              updateGeneratedProps(element: Element, props: Record<string, unknown>): void;
            };
          }).SingleProp;
          const root = create();
          document.querySelector("main")!.append(root);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const initial = root.value;
          update(root, { value: 2 });
          const synchronous = root.value;
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const updated = root.value;
          root.remove();
          await new Promise((resolve) => setTimeout(resolve, 0));
          update(root, { value: 3 });
          await new Promise((resolve) => setTimeout(resolve, 0));
          const detached = root.value;
          document.querySelector("main")!.append(root);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const reconnected = root.value;
          root.remove();
          await new Promise((resolve) => setTimeout(resolve, 0));
          root.value = "999";
          document.querySelector("main")!.append(root);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, synchronous, updated, detached, reconnected, restored: root.value };
        });
        assert.deepEqual(result, { initial: "1", synchronous: "1", updated: "2", detached: "2", reconnected: "3", restored: "3" });
      } finally {
        await browser.close();
      }
    });

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
          const { createDemoProps: create, updateGeneratedProps: update } = (window as unknown as {
            DemoProps: {
              createDemoProps(options?: Record<string, unknown>): Element;
              updateGeneratedProps(element: Element, props: Record<string, unknown>): void;
            };
          }).DemoProps;
          const projected = document.createElement("em");
          projected.textContent = "Projected";
          const root = create({ children: [projected] });
          const second = create();
          document.querySelector("main")!.append(root, second);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const output = root.querySelector("output")!;
          const label = root.querySelector("span")!;
          const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
          const initial = {
            mixed: label.textContent,
            // Template-bound attributes show defaults; the unbound label default is not reflected.
            count: root.getAttribute("data-count"),
            text: output.textContent,
            label: label.getAttribute("aria-label"),
            tone: root.getAttribute("data-tone"),
            reflectedLabel: root.hasAttribute("data-label"),
            ownProperties: ["count", "label", "tone"].filter((key) => Object.hasOwn(root, key)),
            projectedMarker: projected.getAttribute("data-slotted"),
          };

          update(root, { count: 2, label: "First" });
          update(root, { label: "Second" });
          const synchronous = {
            text: output.textContent,
            label: label.getAttribute("aria-label"),
          };
          await tick();
          const batched = {
            text: output.textContent,
            label: label.getAttribute("aria-label"),
            reflected: root.getAttribute("data-label"),
            mixed: label.textContent,
          };

          // data-label records the configuration; writing it is not a prop update.
          root.setAttribute("data-label", "External");
          await tick();
          const external = { label: label.getAttribute("aria-label") };

          root.remove();
          await new Promise((resolve) => setTimeout(resolve, 0));
          update(root, { count: 3 });
          await tick();
          const detached = {
            text: output.textContent,
            reflected: root.getAttribute("data-count"),
          };
          document.querySelector("main")!.append(root);
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const reconnected = {
            text: output.textContent,
            reflected: root.getAttribute("data-count"),
          };

          update(root, { tone: "unknown" });
          await tick();
          const invalid = { tone: root.getAttribute("data-tone"),
            typeMismatch: (root as Element & { validity: ValidityState }).validity.typeMismatch };
          return {
            invalid,
            initial,
            synchronous,
            batched,
            external,
            detached,
            reconnected,
            observedTargets: (window as unknown as { observedTargets: string[] }).observedTargets,
          };
        });
        assert.deepEqual(result.initial, { count: "1", text: "1", label: "Ready", tone: "quiet", reflectedLabel: false, ownProperties: [], projectedMarker: "", mixed: "Ready / 1" });
        assert.deepEqual(result.synchronous, { text: "1", label: "Ready" });
        assert.deepEqual(result.batched, { text: "2", label: "Second", reflected: "Second", mixed: "Second / 2" });
        assert.deepEqual(result.external, { label: "Second" });
        assert.deepEqual(result.detached, { text: "2", reflected: "2" });
        assert.deepEqual(result.reconnected, { text: "3", reflected: "3" });
        assert.deepEqual(result.invalid, { tone: "unknown", typeMismatch: true });
        assert.deepEqual(pageErrors, []);
        // Only the shared document hub observes; no per-element attribute observers.
        assert.deepEqual(result.observedTargets, ["#document"]);
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
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    <prop name="as" type="keyword" values="button, a" default="button">Native root.</prop>
    <prop name="href" type="string">Link.</prop>
    <prop name="disabled" type="boolean" default="false">Off.</prop>
    <computed name="linked" from="as = 'a'"></computed>
  </defs>
  <template $match>
    <a $when="linked" from:href="{ true: null, false: href }[concat(disabled)]"><slot></slot></a>
    <button $else type="button" from:disabled="disabled"><slot></slot></button>
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
    const host = vueHostArtifact();
    await writeFile(join(directory, host.path), host.content);
    const props = vuePropsArtifact();
    await writeFile(join(directory, props.path), props.content);
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
window.switchSave = () => updateComponentProps(save, { as: "a", href: "/save" });
window.switchSaveBack = () => updateComponentProps(save, { as: "button" });`,
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
        alias: {
          "@nextwebwg/html-next/runtime": runtimePath,
          "@nextwebwg/html-next/generated-runtime": generatedRuntimePath,
          "@nextwebwg/html-next/validation": new URL("../src/validation.ts", import.meta.url).pathname,
        },
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
        const read = () => {
          const element = document.querySelector("main > *")!;
          return { tag: element.localName, href: element.getAttribute("href"), type: element.getAttribute("type"), text: element.textContent };
        };
        const api = window as unknown as { switchSave(): void; switchSaveBack(): void };
        api.switchSave();
        await settle();
        const linked = read();
        // The factory's element reference still reaches the component after its root switched.
        api.switchSaveBack();
        await settle();
        return [linked, read()];
      });
      assert.deepEqual(root, [
        { tag: "a", href: "/save", type: null, text: "Save" },
        { tag: "button", href: null, type: "button", text: "Save" },
      ]);
    } finally {
      await browser.close();
    }
  });
});

describe.skipIf(!enabled)("generated Vanilla direct-extend", () => {
  let directory = "";
  const bundles = new Map<string, string>();
  const fixtures = new URL("./fixtures/direct-extend/", import.meta.url);
  // Each fixture builds twice: the live runtime attached to the definition (the reference) and the
  // compiled module.
  const components = [
    { name: "parity", source: "parity.html", controller: "controller.js", factory: "createXParity" },
    { name: "benchmark", source: "benchmark-app.html", controller: "benchmark-controller.js", factory: "createBenchmarkApp" },
  ];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-direct-extend-"));
    const actions = await readFile(new URL("actions.js", fixtures), "utf8");
    for (const component of components) {
      const text = await readFile(new URL(component.source, fixtures), "utf8");
      const controller = await readFile(new URL(component.controller, fixtures), "utf8");
      for (const directExtend of [false, true]) {
        const variant = join(directory, component.name, directExtend ? "direct" : "runtime");
        const definition = parseComponent(text, component.source);
        const artifacts = generateComponent(definition);
        for (const artifact of artifacts) {
          const path = join(variant, artifact.path);
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, artifact.content);
        }
        const module = artifacts.find((artifact) => artifact.path.startsWith("vanilla/") && artifact.path.endsWith(".js"))!;
        assert.doesNotMatch(module.content, /@nextwebwg\/html-next\/runtime/);
        await writeFile(join(variant, "vanilla", "controller.js"), controller);
        await writeFile(join(variant, "vanilla", "reference.js"), liveReference({ ...definition, controller: "./controller.js" }));
        await writeFile(join(variant, "entry.js"), directExtend
          ? `import { ${component.factory} as create } from "./${module.path}";\n${actions}`
          : `import { createReference as create } from "./vanilla/reference.js";\n${actions}`);
        const outfile = join(variant, "bundle.js");
        await build({
          entryPoints: [join(variant, "entry.js")],
          outfile,
          bundle: true,
          format: "iife",
          platform: "browser",
          target: ["es2022"],
          define: { "import.meta.url": JSON.stringify("https://example.test/generated/component.js") },
          loader: { ".css": "empty" },
          alias: {
            "@nextwebwg/html-next/generated-runtime": generatedRuntimePath,
            "@nextwebwg/html-next/runtime": runtimePath,
          },
        });
        bundles.set(`${component.name} ${directExtend ? "direct" : "runtime"}`, outfile);
      }
    }
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  /** Opens a page with one bundle; `errors` collects uncaught page errors. */
  const open = async (browser: Browser, bundle: string): Promise<{ page: Page; errors: string[] }> => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // A same-origin page and script: WebKit reports errors from about:blank as "Script error."
    await page.route("https://example.test/**", (route) => route.fulfill(route.request().url().endsWith(".js")
      ? { contentType: "text/javascript", path: bundles.get(bundle)! }
      : { contentType: "text/html", body: "<main></main><script src=\"/bundle.js\"></script>" }));
    await page.goto("https://example.test/");
    return { page, errors };
  };
  /** Runs `window[action]()` against the general-runtime and the direct bundle of one fixture. */
  const both = async (browser: Browser, component: string, action: string): Promise<[unknown, unknown]> => {
    const results: unknown[] = [];
    for (const variant of ["runtime", "direct"]) {
      const { page, errors } = await open(browser, `${component} ${variant}`);
      results.push(await page.evaluate((name) => (window as unknown as Record<string, () => Promise<unknown>>)[name]!(), action));
      assert.deepEqual(errors, []);
      await page.close();
    }
    return results as [unknown, unknown];
  };

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];
  for (const [name, browserType] of engines) {
    it(`${name} matches the general runtime on list transitions, diagnostics, the controller contract and lifecycle`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const [live, compiled] = await both(browser, "parity", "runParity") as Array<Record<string, string[]>>;
        assert.equal(live!.snapshots!.length, 36);
        assert.deepEqual(compiled!.snapshots, live!.snapshots);
        assert.deepEqual(compiled!.identities, live!.identities);
        assert.deepEqual(compiled!.warnings, live!.warnings);
        assert.equal(live!.warnings!.length, 8);
        assert.deepEqual(compiled!.errors, live!.errors);
        assert.deepEqual(live!.errors!.map((error) => /H[RB]00\d/.exec(error)?.[0]), ["HR004", "HB001", "HB001", "HB001"]);
        // HR004 and HB001 throw before the list touches its DOM.
        assert.deepEqual(compiled!.quiet, [0, 0, 0, 0]);
        assert.deepEqual(live!.quiet, [0, 0, 0, 0]);
        assert.deepEqual(compiled!.contract, live!.contract);
        assert.deepEqual(compiled!.events, live!.events);
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps the coordinator's light-DOM scope, batch order and controller cleanup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const [live, compiled] = await both(browser, "parity", "runLifecycle") as Array<Record<string, unknown[]>>;
        assert.deepEqual(compiled, live);
        assert.ok(live!.events!.includes("3 late cleanup"));
        assert.deepEqual(live!.warnings, []);
        assert.deepEqual(live!.errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders the benchmark operations like the general runtime`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const [live, compiled] = await both(browser, "benchmark", "runBenchmark") as Array<{
          steps: Array<{ name: string; rows: number; same: number }>; warnings: string[]; errors: string[];
        }>;
        assert.deepEqual(compiled!.steps, live!.steps);
        assert.deepEqual(live!.steps.map((step) => [step.rows, step.same]), [
          [0, 0], [1000, 0], [1000, 0], [1000, 1000], [1000, 1000], [1000, 1000], [999, 999], [979, 979],
          [1979, 979], [1979, 0], [1979, 1979], [0, 0], [10000, 0], [10000, 10000], [0, 0],
        ]);
        assert.deepEqual([compiled!.warnings, compiled!.errors, live!.warnings, live!.errors], [[], [], [], []]);
      } finally {
        await browser.close();
      }
    });
  }

  // Experiment 006's forced-GC probe: nine create/clear cycles must not retain rows or DOM.
  it("Chromium releases cleared rows after forced garbage collection", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const measured: Record<string, { nodes: number; heap: number; retained: number }> = {};
      for (const variant of ["runtime", "direct"]) {
        const { page, errors } = await open(browser, `benchmark ${variant}`);
        const session = await page.context().newCDPSession(page);
        await session.send("Performance.enable");
        const sample = async (): Promise<Record<string, number>> => {
          await session.send("HeapProfiler.collectGarbage");
          await session.send("HeapProfiler.collectGarbage");
          const { metrics } = await session.send("Performance.getMetrics");
          return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
        };
        await page.evaluate(() => (window as unknown as { mountBenchmark(): Promise<unknown> }).mountBenchmark().then(() => undefined));
        await page.evaluate(() => (window as unknown as { retentionCycle(): Promise<void> }).retentionCycle());
        const before = await sample();
        for (let cycle = 0; cycle < 9; cycle += 1) {
          await page.evaluate(() => (window as unknown as { retentionCycle(): Promise<void> }).retentionCycle());
        }
        const after = await sample();
        const retained = await page.evaluate(() =>
          (window as unknown as { released: WeakRef<Element>[] }).released.filter((row) => row.deref() !== undefined).length
        );
        measured[variant] = { nodes: after.Nodes! - before.Nodes!, heap: after.JSHeapUsedSize! - before.JSHeapUsedSize!, retained };
        assert.deepEqual(errors, []);
        await page.close();
      }
      // Before 006 the live runtime kept +90,000 nodes and 13.6 MiB over nine cycles; one leaked row
      // per cycle shows here as +90 nodes. Both variants measure 0 nodes.
      for (const result of Object.values(measured)) {
        assert.equal(result.retained, 0, JSON.stringify(measured));
        assert.ok(result.nodes < 9, JSON.stringify(measured));
        assert.ok(result.heap < 2 * 1024 * 1024, JSON.stringify(measured));
      }
    } finally {
      await browser.close();
    }
  });
});
