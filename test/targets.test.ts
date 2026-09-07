import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";
import { compile as compileSvelte } from "svelte/compiler";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/looma-button.html", import.meta.url);

function componentSource(
  name: string,
  tag: string,
  nativeElement: string,
  props: Record<string, unknown>,
  template: string,
): string {
  return `<html7-component>
    <script type="application/html7-contract+json">${JSON.stringify({
      version: 1,
      name,
      tag,
      status: "experimental",
      summary: "A target compiler fixture.",
      nativeElement,
      props,
    })}</script>
    <template>${template}</template>
  </html7-component>`;
}

function generated(source: string): Map<string, string> {
  return new Map(
    generateComponent(parseComponent(source)).map((artifact) => [artifact.path, artifact.content]),
  );
}

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

  it("compiles non-button and native-boolean target projections", async () => {
    const audio = generated(componentSource(
      "Player",
      "demo-player",
      "audio",
      {},
      `<audio controls><slot></slot></audio>`,
    ));
    const action = generated(componentSource(
      "Action",
      "demo-action",
      "button",
      {
        disabled: {
          type: "boolean",
          default: false,
          target: { attribute: "disabled" },
          description: "Disabled state.",
        },
      },
      `<button :disabled="disabled"><slot></slot></button>`,
    ));

    await transform(audio.get("react/Player.tsx")!, { loader: "tsx" });
    await transform(action.get("react/Action.tsx")!, { loader: "tsx" });
    await transform(audio.get("vanilla/Player.js")!, { loader: "js" });
    for (const [source, filename] of [
      [audio.get("svelte/Player.svelte")!, "Player.svelte"],
      [action.get("svelte/Action.svelte")!, "Action.svelte"],
    ] as const) {
      assert.ok(compileSvelte(source, { filename, generate: "client" }).js.code.length > 0);
    }
  });
});
