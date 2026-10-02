import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const snapshotUrl = new URL("./snapshots/x-button.json", import.meta.url);

const expectedPaths = [
  "vanilla/XButton.js",
  "vanilla/XButton.d.ts",
  "vue/XButton.vue",
  "styles/x-button.css",
  "docs/x-button.md",
] as const;

// `demo-action` derives the component name `DemoAction`; targets are inferred from the
// bindings the caller writes in `template`.
function componentSource(template: string): string {
  return `<template component="demo-action" status="experimental" summary="An action fixture.">
    <props>
      <prop name="destination" type="string">Submission destination.</prop>
      <prop name="disabled" type="boolean" default="false">Whether the action is disabled.</prop>
      <prop name="selected" type="boolean" default="false">Selected state.</prop>
    </props>
    ${template}
  </template>`;
}

function audioSource(): string {
  return `<template component="demo-player" status="experimental" summary="An audio fixture.">
    <audio controls><slot></slot></audio>
  </template>`;
}

describe("generateComponent", () => {
  it("lowers dollar-prefixed indexed references in both generated targets", () => {
    const definition = parseComponent(`<template component="x-first-item"><defs>
      <state name="items" type="list(object({ name: string }))" value="[{ name: 'Ada' }]"></state>
      <state name="byId" type="object({ '42': object({ name: string }) })" value="{ '42': { name: 'Bea' } }"></state>
    </defs><div><output $value="$items.0.name"></output><b $value="$byId.42.name"></b></div></template>`);
    const artifacts = new Map(generateComponent(definition).map((artifact) => [artifact.path, artifact.content]));
    const vanilla = artifacts.get("vanilla/XFirstItem.js")!;
    const vue = artifacts.get("vue/XFirstItem.vue")!;
    assert.match(vanilla, /items\.0\.name/);
    assert.match(vanilla, /byId\.42\.name/);
    assert.match(vue, /\[0\]/);
    assert.match(vue, /\[42\]/);
  });
  it("snapshots every deterministic projection", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const definition = parseComponent(source, "x-button.html");
    const before = JSON.stringify(definition);

    const first = generateComponent(definition);
    const second = generateComponent(definition);
    const expected = JSON.parse(await readFile(snapshotUrl, "utf8")) as unknown;

    assert.deepEqual(first.map((artifact) => artifact.path), expectedPaths);
    assert.deepEqual(first, second);
    assert.deepEqual(first, expected);
    assert.equal(JSON.stringify(definition), before, "generation must not mutate or enrich the core IR");
  });

  it("carries authored bounds into generated runtime definitions", () => {
    const definition = parseComponent(`<template component="x-bounded"><defs>
      <prop name="amount" type="number" min="1" max="10">Amount.</prop>
      <prop name="label" type="string" minlength="2" maxlength="8">Label.</prop>
    </defs><div from:data-amount="amount" from:data-label="label"></div></template>`);
    const artifacts = generateComponent(definition);
    const vanilla = artifacts.find((artifact) => artifact.path === "vanilla/XBounded.js")!.content;
    assert.match(vanilla, /"min":1,"max":10/);
    assert.match(vanilla, /"minLength":2,"maxLength":8/);
    assert.match(vanilla, /html-next\/runtime/);
  });

  it("keeps the primitive native and makes owned values win over native spreads", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const artifacts = generateComponent(parseComponent(source, "x-button.html"));
    const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));

    const vanilla = byPath.get("vanilla/XButton.js")!;
    assert.match(vanilla, /document\.createElement\("button"\)/);
    assert.ok(vanilla.indexOf("attributes") < vanilla.indexOf('setAttribute("data-x-button"'));

    const vue = byPath.get("vue/XButton.vue")!;
    assert.match(vue, /<script setup lang="ts">/);
    assert.match(vue, /defineOptions\(\{ inheritAttrs: false \}\)/);
    assert.ok(vue.lastIndexOf('v-bind="nativeAttrs($attrs)"') < vue.lastIndexOf("data-x-button"));

    assert.doesNotMatch(vanilla, /<x-button\b|createElement\("x-button"\)/);
    assert.doesNotMatch(vue.slice(vue.indexOf("<template>")), /<x-button\b/);
  });

  it("publishes prominently early-release documentation without a detached contract artifact", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const artifacts = generateComponent(parseComponent(source, "x-button.html"));
    const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));

    assert.equal(byPath.has("contracts/x-button.json"), false);

    const docs = byPath.get("docs/x-button.md")!;
    assert.match(docs.slice(0, 200), /Status: EARLY/);
    assert.doesNotMatch(docs, /Coming soon/);
    assert.match(docs, /## Runtime support/);
    assert.match(docs, /State, computed values, handlers, structural rendering, data, validation/);
  });

  it("preserves native validity pseudo-classes in generated CSS", () => {
    const source =
      `<template component="demo-action" status="experimental" summary="An action fixture.">` +
      `<style>button:invalid { outline: 2px solid red; }</style><button>Save</button></template>`;
    const byPath = new Map(
      generateComponent(parseComponent(source)).map((artifact) => [artifact.path, artifact.content]),
    );

    assert.match(
      byPath.get("styles/demo-action.css")!,
      /button:is\(:invalid, \[data-invalid\]\)/,
    );
  });

  it("keeps list-joining computed expressions on the full-runtime fallback", () => {
    const source = `<template component="computed-label" status="experimental" summary="Fallback fixture.">
      <defs>
        <state type="list(string)" name="parts" value="['a', 'b']"></state>
        <state type="string" name="separator" value=", "></state>
        <computed name="label" from="join(parts, separator)"></computed>
        <handler name="increment"><set name="separator" value=" / "></set></handler>
      </defs>
      <button type="button" on:click="increment"><output $value="label"></output></button>
    </template>`;
    const vanilla = generateComponent(parseComponent(source))
      .find((artifact) => artifact.path === "vanilla/ComputedLabel.js")?.content;

    assert.ok(vanilla);
    assert.match(vanilla, /@nextwebwg\/html-next\/runtime/);
  });

  it("provides and reads ancestor state in generated targets and lowers conditional values", () => {
    const provider = parseComponent(`<template component="x-steps"><defs>` +
      `<state type="number" name="current" value="1"></state></defs><ol><slot></slot></ol></template>`);
    const reader = parseComponent(`<template component="x-step"><defs>` +
      `<prop name="index" type="number" required>Step index.</prop>` +
      `<context name="current" from="x-steps" as="activeStep"></context></defs>` +
      `<li from:aria-current="activeStep = index ? 'step' : null"><slot></slot></li></template>`);
    const artifacts = (definition: typeof provider) => new Map(generateComponent(definition).map((item) => [item.path, item.content]));
    const providerOutput = artifacts(provider);
    const readerOutput = artifacts(reader);
    assert.match(providerOutput.get("vanilla/XSteps.js")!, /@nextwebwg\/html-next\/runtime/);
    assert.match(readerOutput.get("vanilla/XStep.js")!, /@nextwebwg\/html-next\/runtime/);
    assert.match(providerOutput.get("vue/XSteps.vue")!, /provide\('html-next:x-steps:current', current\)/);
    assert.match(readerOutput.get("vue/XStep.vue")!, /inject<any>\('html-next:x-steps:current'\)/);
    assert.match(readerOutput.get("vue/XStep.vue")!, /const props = defineProps/);
    assert.match(readerOutput.get("vue/XStep.vue")!, /activeStep === checkedProps\.index \? 'step' : null/);

    const nestedProvider = parseComponent(`<template component="x-steps"><defs>` +
      `<state type="number" name="current" value="1"></state></defs><section><x-step></x-step></section></template>`);
    assert.match(artifacts(nestedProvider).get("vanilla/XSteps.js")!, /@nextwebwg\/html-next\/runtime/);
    const closedGraphOutput = new Map(generateComponent(nestedProvider, { noContextReaders: true })
      .map((item) => [item.path, item.content]));
    assert.doesNotMatch(closedGraphOutput.get("vanilla/XSteps.js")!, /@nextwebwg\/html-next\/runtime/);
  });

  it("projects typed property bindings, boolean defaults, and escaped literal markup", () => {
    const definition = parseComponent(componentSource(
      `<button title="A &amp; &quot;quote&quot;" .formAction="destination" from:disabled="disabled" from:data-selected="selected">Text &amp; {literal}<slot></slot></button>`,
    ));
    const byPath = new Map(generateComponent(definition).map((artifact) => [artifact.path, artifact.content]));

    assert.match(byPath.get("vanilla/DemoAction.js")!, /=== undefined \? false/);
    assert.match(byPath.get("vanilla/DemoAction.js")!, /\["formAction"\] =/);
    const vue = byPath.get("vue/DemoAction.vue")!;
    assert.match(vue, /:formAction\.prop="checkedProps\.destination as any"/);
    assert.match(vue, /:disabled="checkedProps\.disabled \?\? undefined"/);
    // The root's reflected prop is the final writer for a bound data-* attribute.
    assert.match(vue, /:data-selected="reflectedProp\('selected', 'selected', checkedProps\.selected, undefined, true\)"/);
    assert.match(vue, /title="A & &quot;quote&quot;"/);
    assert.match(vue, /Text &amp; &#123;literal&#125;/);
  });

  it("derives non-button native types from platform and framework contracts", () => {
    const byPath = new Map(
      generateComponent(parseComponent(audioSource())).map((artifact) => [artifact.path, artifact.content]),
    );

    assert.match(byPath.get("vanilla/DemoPlayer.d.ts")!, /interface DemoPlayerElement extends HTMLAudioElement/);
    assert.match(byPath.get("vanilla/DemoPlayer.d.ts")!, /\): DemoPlayerElement;/);
    assert.match(byPath.get("vue/DemoPlayer.vue")!, /<audio data-component="demo-player" controls="" v-bind="nativeAttrs\(\$attrs\)"/);
  });
});
