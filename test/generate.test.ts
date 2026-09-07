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
  "contracts/x-button.json",
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
    assert.match(react, /ref\?: Ref<ComponentRef<"button">>/);
    assert.doesNotMatch(react, /forwardRef/);
    assert.ok(react.indexOf("{...nativeProps}") < react.indexOf("data-x-button"));

    const vue = byPath.get("vue/XButton.vue")!;
    assert.match(vue, /<script setup lang="ts">/);
    assert.match(vue, /defineOptions\(\{ inheritAttrs: false \}\)/);
    assert.ok(vue.indexOf('v-bind="$attrs"') < vue.indexOf("data-x-button"));

    const svelte = byPath.get("svelte/XButton.svelte")!;
    assert.match(svelte, /from "svelte\/elements"/);
    assert.match(svelte, /Snippet/);
    assert.match(svelte, /\$props\(\)/);
    assert.ok(svelte.indexOf("{...nativeProps}") < svelte.indexOf("data-x-button"));

    for (const content of [vanilla, react, vue, svelte]) {
      assert.doesNotMatch(content, /<x-button\b|createElement\("x-button"\)/);
    }
  });

  it("publishes normalized contract data and prominently early-release documentation", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const artifacts = generateComponent(parseComponent(source, "x-button.html"));
    const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));

    const contract = JSON.parse(byPath.get("contracts/x-button.json")!) as {
      status: string;
      props: Record<string, unknown>;
    };
    assert.equal(contract.status, "early");
    assert.deepEqual(Object.keys(contract.props), ["size", "variant"]);

    const docs = byPath.get("docs/x-button.md")!;
    assert.match(docs.slice(0, 200), /Status: EARLY/);
    assert.match(docs, /## Coming soon/);
    assert.match(docs, /State, computed values, data sources, control flow, filters, and actions/);
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

    assert.match(byPath.get("vanilla/DemoPlayer.d.ts")!, /\): HTMLAudioElement;/);
    assert.match(byPath.get("react/DemoPlayer.tsx")!, /ComponentPropsWithoutRef<"audio">/);
    assert.match(byPath.get("react/DemoPlayer.tsx")!, /Ref<ComponentRef<"audio">>/);
    assert.match(byPath.get("svelte/DemoPlayer.svelte")!, /SvelteHTMLElements\["audio"\]/);
  });
});
