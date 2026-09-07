import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";
import { compile as compileSvelte } from "svelte/compiler";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/looma-button.html", import.meta.url);

async function targets(): Promise<Map<string, string>> {
  const source = await readFile(fixtureUrl, "utf8");
  return new Map(
    generateComponent(parseComponent(source, "looma-button.html")).map((artifact) => [
      artifact.path,
      artifact.content,
    ]),
  );
}

describe("official target compilers", () => {
  it("parses generated Vanilla and React source", async () => {
    const generated = await targets();
    await transform(generated.get("vanilla/Button.js")!, { loader: "js" });
    await transform(generated.get("react/Button.tsx")!, { loader: "tsx" });
  });

  it("compiles the generated Vue 3.5 SFC", async () => {
    const generated = await targets();
    const source = generated.get("vue/Button.vue")!;
    const parsed = parseVue(source, { filename: "Button.vue" });
    assert.deepEqual(parsed.errors, []);
    const script = compileScript(parsed.descriptor, { id: "html7-button" });
    const template = compileTemplate({
      id: "html7-button",
      filename: "Button.vue",
      source: parsed.descriptor.template!.content,
      compilerOptions: { bindingMetadata: script.bindings ?? {} },
    });
    assert.deepEqual(template.errors, []);
  });

  it("compiles the generated Svelte 5 component", async () => {
    const generated = await targets();
    const result = compileSvelte(generated.get("svelte/Button.svelte")!, {
      filename: "Button.svelte",
      generate: "client",
    });
    assert.ok(result.js.code.length > 0);
  });
});
