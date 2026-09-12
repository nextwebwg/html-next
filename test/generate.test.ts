import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const snapshotUrl = new URL("./snapshots/x-button.json", import.meta.url);

const expectedPaths = [
  "vanilla/XButton.js",
  "vanilla/XButton.d.ts",
  "react/XButton.tsx",
  "vue/XButton.vue",
  "svelte/XButton.svelte",
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

  it("keeps the primitive native and makes owned values win over native spreads", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const artifacts = generateComponent(parseComponent(source, "x-button.html"));
    const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));

    const vanilla = byPath.get("vanilla/XButton.js")!;
    assert.match(vanilla, /document\.createElement\("button"\)/);
    assert.ok(vanilla.indexOf("attributes") < vanilla.indexOf('setAttribute("data-x-button"'));

    const react = byPath.get("react/XButton.tsx")!;
    assert.match(react, /ref\?: Ref<XButtonHandle>/);
    assert.doesNotMatch(react, /forwardRef/);
    assert.ok(react.lastIndexOf("{...nativeProps}") < react.lastIndexOf("data-x-button"));

    const vue = byPath.get("vue/XButton.vue")!;
    assert.match(vue, /<script setup lang="ts">/);
    assert.match(vue, /defineOptions\(\{ inheritAttrs: false \}\)/);
    assert.ok(vue.lastIndexOf('v-bind="$attrs"') < vue.lastIndexOf("data-x-button"));

    const svelte = byPath.get("svelte/XButton.svelte")!;
    assert.match(svelte, /from "svelte\/elements"/);
    assert.match(svelte, /Snippet/);
    assert.match(svelte, /\$props\(\)/);
    assert.ok(svelte.lastIndexOf("{...nativeProps}") < svelte.lastIndexOf("data-x-button"));

    for (const content of [vanilla, react, vue, svelte]) {
      assert.doesNotMatch(content, /<x-button\b|createElement\("x-button"\)/);
    }
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
    assert.match(docs, /State, computed values, handlers, structural rendering, data, enhanced forms/);
  });

  it("makes authored validity pseudo-classes work in generated CSS", () => {
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

  it("projects typed property bindings, boolean defaults, and escaped literal markup", () => {
    const definition = parseComponent(componentSource(
      `<button title="A &amp; &quot;quote&quot;" .formAction="destination" :disabled="disabled" :data-selected="selected">Text &amp; {literal}<slot></slot></button>`,
    ));
    const byPath = new Map(generateComponent(definition).map((artifact) => [artifact.path, artifact.content]));

    assert.match(byPath.get("vanilla/DemoAction.js")!, /=== undefined \? false/);
    assert.match(byPath.get("vanilla/DemoAction.js")!, /\["formAction"\] =/);
    assert.match(byPath.get("react/DemoAction.tsx")!, /formAction=\{prop0\}/);
    assert.match(byPath.get("react/DemoAction.tsx")!, /disabled=\{prop1\}/);
    assert.match(byPath.get("react/DemoAction.tsx")!, /data-selected=\{prop2 \? "" : undefined\}/);
    assert.match(byPath.get("vue/DemoAction.vue")!, /:formAction="props.destination"/);
    assert.match(byPath.get("vue/DemoAction.vue")!, /:disabled="props.disabled"/);
    assert.match(byPath.get("vue/DemoAction.vue")!, /:data-selected="props.selected \? '' : undefined"/);
    assert.match(byPath.get("svelte/DemoAction.svelte")!, /formAction=\{prop0\}/);
    assert.match(byPath.get("svelte/DemoAction.svelte")!, /disabled=\{prop1\}/);
    assert.match(byPath.get("svelte/DemoAction.svelte")!, /data-selected=\{prop2 \? "" : undefined\}/);
    assert.match(byPath.get("vue/DemoAction.vue")!, /A &amp; &quot;quote&quot;/);
    assert.match(byPath.get("svelte/DemoAction.svelte")!, /&#123;literal&#125;/);
  });

  it("derives non-button native types from platform and framework contracts", () => {
    const byPath = new Map(
      generateComponent(parseComponent(audioSource())).map((artifact) => [artifact.path, artifact.content]),
    );

    assert.match(byPath.get("vanilla/DemoPlayer.d.ts")!, /interface DemoPlayerElement extends HTMLAudioElement/);
    assert.match(byPath.get("vanilla/DemoPlayer.d.ts")!, /\): DemoPlayerElement;/);
    assert.match(byPath.get("react/DemoPlayer.tsx")!, /ComponentPropsWithoutRef<"audio">/);
    assert.match(byPath.get("react/DemoPlayer.tsx")!, /type DemoPlayerHandle = ComponentRef<"audio">/);
    assert.match(byPath.get("react/DemoPlayer.tsx")!, /ref\?: Ref<DemoPlayerHandle>/);
    assert.match(byPath.get("svelte/DemoPlayer.svelte")!, /SvelteHTMLElements\["audio"\]/);
  });
});
