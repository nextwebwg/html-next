import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";
import { compile as compileSvelte } from "svelte/compiler";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

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
