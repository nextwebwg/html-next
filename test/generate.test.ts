import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/looma-button.html", import.meta.url);
const snapshotUrl = new URL("./snapshots/looma-button.json", import.meta.url);

const expectedPaths = [
  "vanilla/Button.js",
  "vanilla/Button.d.ts",
  "react/Button.tsx",
  "vue/Button.vue",
  "svelte/Button.svelte",
  "styles/looma-button.css",
  "contracts/looma-button.json",
  "docs/looma-button.md",
] as const;

function componentSource(template: string): string {
  return `<html7-component>
    <script type="application/html7-contract+json">${JSON.stringify({
      version: 1,
      name: "Action",
      tag: "demo-action",
      status: "experimental",
      summary: "An action fixture.",
      nativeElement: "button",
      props: {
        destination: {
          type: "string",
          target: { property: "formAction" },
          description: "Submission destination.",
        },
        disabled: {
          type: "boolean",
          default: false,
          target: { attribute: "disabled" },
          description: "Whether the action is disabled.",
        },
        selected: {
          type: "boolean",
          default: false,
          target: { attribute: "data-selected" },
          description: "Selected state.",
        },
      },
    })}</script>
    <template>${template}</template>
  </html7-component>`;
}

function audioSource(): string {
  return `<html7-component>
    <script type="application/html7-contract+json">${JSON.stringify({
      version: 1,
      name: "Player",
      tag: "demo-player",
      status: "experimental",
      summary: "An audio fixture.",
      nativeElement: "audio",
      props: {},
    })}</script>
    <template><audio controls><slot></slot></audio></template>
  </html7-component>`;
}

describe("generateComponent", () => {
  it("snapshots every deterministic Looma projection", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const definition = parseComponent(source, "looma-button.html");
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
    const artifacts = generateComponent(parseComponent(source, "looma-button.html"));
    const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));

    const vanilla = byPath.get("vanilla/Button.js")!;
    assert.match(vanilla, /document\.createElement\("button"\)/);
    assert.ok(vanilla.indexOf("attributes") < vanilla.indexOf('setAttribute("data-looma"'));

    const react = byPath.get("react/Button.tsx")!;
    assert.match(react, /ref\?: Ref<ComponentRef<"button">>/);
    assert.doesNotMatch(react, /forwardRef/);
    assert.ok(react.indexOf("{...nativeProps}") < react.indexOf("data-looma"));

    const vue = byPath.get("vue/Button.vue")!;
    assert.match(vue, /<script setup lang="ts">/);
    assert.match(vue, /defineOptions\(\{ inheritAttrs: false \}\)/);
    assert.ok(vue.indexOf('v-bind="$attrs"') < vue.indexOf("data-looma"));

    const svelte = byPath.get("svelte/Button.svelte")!;
    assert.match(svelte, /from "svelte\/elements"/);
    assert.match(svelte, /Snippet/);
    assert.match(svelte, /\$props\(\)/);
    assert.ok(svelte.indexOf("{...nativeProps}") < svelte.indexOf("data-looma"));

    for (const content of [vanilla, react, vue, svelte]) {
      assert.doesNotMatch(content, /<looma-button\b|createElement\("looma-button"\)/);
    }
  });

  it("publishes normalized contract data and prominently early-release documentation", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const artifacts = generateComponent(parseComponent(source, "looma-button.html"));
    const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));

    const contract = JSON.parse(byPath.get("contracts/looma-button.json")!) as {
      status: string;
      props: Record<string, unknown>;
    };
    assert.equal(contract.status, "early");
    assert.deepEqual(Object.keys(contract.props), ["size", "variant"]);

    const docs = byPath.get("docs/looma-button.md")!;
    assert.match(docs.slice(0, 200), /Status: EARLY/);
    assert.match(docs, /## Coming soon/);
    assert.match(docs, /State, computed values, data sources, control flow, filters, and actions/);
  });

  it("projects typed property bindings, boolean defaults, and escaped literal markup", () => {
    const definition = parseComponent(componentSource(
      `<button title="A &amp; &quot;quote&quot;" .formAction="destination" :disabled="disabled" :data-selected="selected">Text &amp; {literal}<slot></slot></button>`,
    ));
    const byPath = new Map(generateComponent(definition).map((artifact) => [artifact.path, artifact.content]));

    assert.match(byPath.get("vanilla/Action.js")!, /=== undefined \? false/);
    assert.match(byPath.get("vanilla/Action.js")!, /\["formAction"\] =/);
    assert.match(byPath.get("react/Action.tsx")!, /formAction=\{prop0\}/);
    assert.match(byPath.get("react/Action.tsx")!, /disabled=\{prop1\}/);
    assert.match(byPath.get("react/Action.tsx")!, /data-selected=\{prop2 \? "" : undefined\}/);
    assert.match(byPath.get("vue/Action.vue")!, /:formAction="props.destination"/);
    assert.match(byPath.get("vue/Action.vue")!, /:disabled="props.disabled"/);
    assert.match(byPath.get("vue/Action.vue")!, /:data-selected="props.selected \? '' : undefined"/);
    assert.match(byPath.get("svelte/Action.svelte")!, /formAction=\{prop0\}/);
    assert.match(byPath.get("svelte/Action.svelte")!, /disabled=\{prop1\}/);
    assert.match(byPath.get("svelte/Action.svelte")!, /data-selected=\{prop2 \? "" : undefined\}/);
    assert.match(byPath.get("vue/Action.vue")!, /A &amp; &quot;quote&quot;/);
    assert.match(byPath.get("svelte/Action.svelte")!, /&#123;literal&#125;/);
  });

  it("derives non-button native types from platform and framework contracts", () => {
    const byPath = new Map(
      generateComponent(parseComponent(audioSource())).map((artifact) => [artifact.path, artifact.content]),
    );

    assert.match(byPath.get("vanilla/Player.d.ts")!, /\): HTMLAudioElement;/);
    assert.match(byPath.get("react/Player.tsx")!, /ComponentPropsWithoutRef<"audio">/);
    assert.match(byPath.get("react/Player.tsx")!, /Ref<ComponentRef<"audio">>/);
    assert.match(byPath.get("svelte/Player.svelte")!, /SvelteHTMLElements\["audio"\]/);
  });
});
