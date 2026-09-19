import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";
import { compile as compileSvelte } from "svelte/compiler";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);

// The component name is derived from `tag` and the native root inferred from `template`;
// `props` supplies the `<prop>` declarations for the bindings in `template`.
function componentSource(tag: string, props: string, template: string): string {
  const group = props === "" ? "" : `<props>${props}</props>`;
  return `<template component="${tag}" status="experimental" summary="A target compiler fixture.">${group}${template}</template>`;
}

function generated(source: string): Map<string, string> {
  return new Map(
    generateComponent(parseComponent(source)).map((artifact) => [artifact.path, artifact.content]),
  );
}

async function targets(): Promise<Map<string, string>> {
  const source = await readFile(fixtureUrl, "utf8");
  return new Map(
    generateComponent(parseComponent(source, "x-button.html")).map((artifact) => [
      artifact.path,
      artifact.content,
    ]),
  );
}

describe("official target compilers", () => {
  it("parses generated Vanilla and React source", async () => {
    const generated = await targets();
    await transform(generated.get("vanilla/XButton.js")!, { loader: "js" });
    await transform(generated.get("react/XButton.tsx")!, { loader: "tsx" });
  });

  it("compiles the generated Vue 3.5 SFC", async () => {
    const generated = await targets();
    const source = generated.get("vue/XButton.vue")!;
    const parsed = parseVue(source, { filename: "XButton.vue" });
    assert.deepEqual(parsed.errors, []);
    const script = compileScript(parsed.descriptor, { id: "html-next-button" });
    const template = compileTemplate({
      id: "html-next-button",
      filename: "XButton.vue",
      source: parsed.descriptor.template!.content,
      compilerOptions: { bindingMetadata: script.bindings ?? {} },
    });
    assert.deepEqual(template.errors, []);
  });

  it("compiles the generated Svelte 5 component", async () => {
    const generated = await targets();
    const result = compileSvelte(generated.get("svelte/XButton.svelte")!, {
      filename: "XButton.svelte",
      generate: "client",
    });
    assert.ok(result.js.code.length > 0);
  });

  it("uses framework rendering directly for prop-and-slot components", async () => {
    const output = await targets();
    for (const path of ["react/XButton.tsx", "vue/XButton.vue", "svelte/XButton.svelte"]) {
      assert.doesNotMatch(output.get(path)!, /declarative-components\/runtime|attachComponent/);
    }
  });

  it("installs the declarative prop boundary when framework templates do not bind public props", () => {
    const output = generated(componentSource(
      "demo-panel",
      `<prop name="align" type="start | center | end">Alignment.</prop>
       <prop name="label" type="string">Label.</prop>`,
      `<div><span :data-align="align" :data-label="label"></span><slot></slot></div>`,
    ));

    for (const path of ["react/DemoPanel.tsx", "vue/DemoPanel.vue", "svelte/DemoPanel.svelte"]) {
      const module = output.get(path)!;
      assert.match(module, /manageGeneratedProps/);
      assert.match(module, /data-align/);
      assert.match(module, /data-label/);
      assert.doesNotMatch(module, /declarative-components\/runtime|attachComponent/);
    }
  });

  it("keeps property-only structured framework props on the complete runtime path", () => {
    const output = generated(componentSource(
      "demo-list",
      `<prop name="items" type="list(unknown)">Items.</prop>`,
      `<div><span .items="items"></span><slot></slot></div>`,
    ));

    for (const path of ["react/DemoList.tsx", "vue/DemoList.vue", "svelte/DemoList.svelte"]) {
      const module = output.get(path)!;
      assert.match(module, /declarative-components\/runtime|attachComponent/);
      assert.doesNotMatch(module, /manageGeneratedProps/);
      assert.doesNotMatch(module, /(?:^|\s)(?::)?items=/m);
    }
  });

  it("compiles non-button and native-boolean target projections", async () => {
    const audio = generated(componentSource(
      "demo-player",
      "",
      `<audio controls><slot></slot></audio>`,
    ));
    const action = generated(componentSource(
      "demo-action",
      `<prop name="disabled" type="boolean" default="false">Disabled state.</prop>`,
      `<button :disabled="disabled"><slot></slot></button>`,
    ));

    await transform(audio.get("react/DemoPlayer.tsx")!, { loader: "tsx" });
    await transform(action.get("react/DemoAction.tsx")!, { loader: "tsx" });
    await transform(audio.get("vanilla/DemoPlayer.js")!, { loader: "js" });
    for (const [source, filename] of [
      [audio.get("svelte/DemoPlayer.svelte")!, "DemoPlayer.svelte"],
      [action.get("svelte/DemoAction.svelte")!, "DemoAction.svelte"],
    ] as const) {
      assert.ok(compileSvelte(source, { filename, generate: "client" }).js.code.length > 0);
    }
  });

  it("emits a standalone Vanilla module when the component has no runtime behavior", () => {
    const module = generated(componentSource(
      "demo-card",
      "",
      `<article><h2>Card</h2><slot></slot></article>`,
    )).get("vanilla/DemoCard.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/declarative-components\/runtime/);
    assert.doesNotMatch(module, /manageComponentLifecycle|const definition/);
    assert.match(module, /document\.createElement\("article"\)/);
  });

  it("compiles simple numeric state directly to native browser primitives", async () => {
    const module = generated(`<template component="demo-counter" status="experimental" summary="Counter.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment">
          <set name="count" :value="count + 1"></set>
          <set name="count" :value="count + 1"></set>
        </handler>
      </defs>
      <button type="button" on:click="increment"><output $value="count"></output></button>
    </template>`).get("vanilla/DemoCounter.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/declarative-components\/runtime/);
    assert.match(module, /queueMicrotask\(update\)/);
    assert.match(module, /addEventListener\("click", handler0\)/);
    assert.match(module, /const next0 = state0 \+ 1/);
    assert.match(module, /const next1 = state0 \+ 1/);
    await transform(module, { loader: "js" });
  });

  it("compiles scalar prop reflection without the live interpreter", async () => {
    const module = generated(componentSource(
      "demo-label",
      `<prop name="label" type="string" default="Ready">Label.</prop>`,
      `<output :data-label="label"><span $value="label"></span></output>`,
    )).get("vanilla/DemoLabel.js")!;

    assert.match(module, /declarative-components\/generated-runtime/);
    assert.doesNotMatch(module, /declarative-components\/runtime/);
    assert.match(module, /manageGeneratedProps/);
    await transform(module, { loader: "js" });
  });

  it("keeps unsafe attribute sinks on the complete runtime path", () => {
    const module = generated(componentSource(
      "demo-link",
      `<prop name="target" type="string" default="https://example.test">Target.</prop>`,
      `<a :href="target"><slot></slot></a>`,
    )).get("vanilla/DemoLink.js")!;

    assert.match(module, /declarative-components\/runtime/);
    assert.doesNotMatch(module, /declarative-components\/generated-runtime/);
  });

  it("keeps the complete runtime for reactive shapes outside the direct subset", () => {
    const module = generated(`<template component="demo-derived" status="experimental" summary="Derived output.">
      <defs><state name="count" :value="0"></state></defs>
      <output $value="count + 1"></output>
    </template>`).get("vanilla/DemoDerived.js")!;

    assert.match(module, /@nextwebwg\/declarative-components\/runtime/);
    assert.match(module, /manageComponentLifecycle/);
  });

  it("emits provenance-scoped CSS and matching target markers", async () => {
    const artifacts = generated(componentSource(
      "demo-card",
      "",
      `<article><div class="body"><x-badge></x-badge></div></article><style>.body, x-badge { color: red; }</style>`,
    ));
    const css = artifacts.get("styles/demo-card.css")!;

    assert.match(css, /\.body:where\(\[data-component~="demo-card"\]\)/);
    assert.match(css, /data-component-root~="x-badge"[\s\S]*data-component~="demo-card"/);
    for (const path of [
      "vanilla/DemoCard.js",
      "react/DemoCard.tsx",
      "vue/DemoCard.vue",
      "svelte/DemoCard.svelte",
    ]) {
      assert.match(artifacts.get(path)!, /data-component/);
      assert.match(artifacts.get(path)!, /data-component-root/);
    }
  });
});
