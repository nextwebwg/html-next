import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

import { generateComponent, parseComponent } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";

const run = promisify(execFile);
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
const tsc = join(modules, ".bin/tsc");
const vueTsc = createRequire(new URL("../package.json", import.meta.url)).resolve("vue-tsc/bin/vue-tsc.js");
const svelteCheck = createRequire(new URL("../../html-next-unplugin/package.json", import.meta.url)).resolve("svelte-check/bin/svelte-check");
// The generated runtime re-exports RequestEvent from the request steps, which typecheck on their own.
const requestSteps = fileURLToPath(new URL("../../html-next/src/requests.ts", import.meta.url));

const editor = `<template component="ui-editor" status="early" summary="Asks its consumer." controller="./editor.js"><defs>
  <request name="mention-query" type="object({ query: string })" returns="list(object({ id: string, label: string }))">People matching the text after @.</request>
  <request name="extensions" returns="list(unknown)">Extensions added to the built-in set.</request>
</defs><div></div></template>`;
const compilerOptions = { strict: true, skipLibCheck: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022",
  lib: ["ES2022", "DOM", "DOM.Iterable"], allowImportingTsExtensions: true, noEmit: true };

/** Each consumer typechecks, or fails with an error matching its pattern. */
async function expectTypes(check: () => Promise<unknown>, write: (contents: string) => Promise<void>, cases: readonly (readonly [string, string, RegExp?])[]): Promise<void> {
  for (const [name, contents, expected] of cases) {
    await write(contents);
    if (expected === undefined) {
      try { await check(); } catch (error) { assert.fail(`${name}: ${(error as { stdout: string }).stdout}`); }
    } else {
      await assert.rejects(check(), (error: unknown) => {
        assert.match((error as { stdout: string }).stdout, expected, name);
        return true;
      }, `${name} must be rejected`);
    }
  }
}

it("types each request's function prop, event form, and request event from its declaration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-next-request-types-"));
  try {
    await symlink(modules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "editor.html"), editor);
    await writeFile(join(directory, "editor.js"), "export default function controller() {}\n");
    for (const target of ["react", "vue", "svelte"] as const) {
      await convertComponents({ target, mode: "library", root: directory, outDirectory: join(directory, target), entries: ["editor.html"] });
    }

    // React: the function prop answers with the declared answer, null, or a promise of either.
    await writeFile(join(directory, "tsconfig.react.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, jsx: "react-jsx" }, files: ["consumer.tsx"] }));
    await expectTypes(() => run(tsc, ["-p", join(directory, "tsconfig.react.json")], { cwd: directory }),
      (contents) => writeFile(join(directory, "consumer.tsx"), `import UiEditor from "./react/react/UiEditor";\n${contents}\n`), [
        ["answers", `void [<UiEditor mentionQuery={async ({ query }, { signal, progress }) => { void signal; progress(1, 1); return [{ id: query, label: query }]; }} />,
  <UiEditor mentionQuery={() => null} extensions={() => [{ any: "extension" }]} />,
  <UiEditor onMentionQuery={(event) => { const query: string = event.detail.query; event.respondWith(Promise.resolve([{ id: query, label: query }])); }} />];`],
        ["wrong answer", "void <UiEditor mentionQuery={() => [42]} />;", /number/],
        ["wrong detail", "void <UiEditor mentionQuery={({ term }) => [{ id: term, label: term }]} />;", /term/],
        ["wrong event answer", "void <UiEditor onMentionQuery={(event) => event.respondWith(\"nobody\")} />;", /string/],
      ]);

    // Vue: the function prop and `@mention-query`, checked in templates.
    await writeFile(join(directory, "tsconfig.vue.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, allowJs: true }, files: ["Consumer.vue"] }));
    await expectTypes(() => run(process.execPath, [vueTsc, "-p", join(directory, "tsconfig.vue.json")], { cwd: directory }),
      (contents) => writeFile(join(directory, "Consumer.vue"), `<script setup lang="ts">import UiEditor from "./vue/vue/UiEditor.vue";</script>\n<template>${contents}</template>\n`), [
        ["answers", `<UiEditor :mention-query="({ query }, { signal }) => { void signal; return [{ id: query, label: query }]; }" @mention-query="(event) => event.respondWith([{ id: event.detail.query, label: '' }])" />`],
        ["wrong answer", `<UiEditor :mention-query="() => 'nobody'" />`, /string/],
        ["wrong event answer", `<UiEditor @mention-query="(event) => event.respondWith(42)" />`, /'42'/],
      ]);

    // Svelte: the function prop and the event prop Svelte uses for declared events.
    await writeFile(join(directory, "tsconfig.svelte.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, allowJs: true }, files: ["Consumer.svelte"] }));
    await expectTypes(() => run(process.execPath, [svelteCheck, "--tsconfig", join(directory, "tsconfig.svelte.json"), "--output", "machine"], { cwd: directory }),
      (contents) => writeFile(join(directory, "Consumer.svelte"), `<script lang="ts">import UiEditor from "./svelte/svelte/UiEditor.svelte";</script>\n${contents}\n`), [
        ["answers", `<UiEditor mentionQuery={({ query }) => [{ id: query, label: query }]} onmention-query={(event) => event.respondWith([{ id: event.detail.query, label: "" }])} />`],
        ["wrong answer", `<UiEditor mentionQuery={() => 42} />`, /number/],
        ["wrong event answer", `<UiEditor onmention-query={(event) => event.respondWith("nobody")} />`, /string/],
      ]);

    // Compiled Vanilla: a listener on the root receives the request event.
    const definition = parseComponent(editor, "editor.html");
    await mkdir(join(directory, "vanilla"));
    await writeFile(join(directory, "vanilla/UiEditor.d.ts"), generateComponent(definition).find((artifact) => artifact.path === "vanilla/UiEditor.d.ts")!.content);
    await writeFile(join(directory, "tsconfig.vanilla.json"), JSON.stringify({ compilerOptions: { ...compilerOptions,
      paths: { "@nextwebwg/html-next/generated-runtime": [requestSteps] } }, files: ["consumer.ts"] }));
    await expectTypes(() => run(tsc, ["-p", join(directory, "tsconfig.vanilla.json")], { cwd: directory }),
      (contents) => writeFile(join(directory, "consumer.ts"), `import type { UiEditorElement } from "./vanilla/UiEditor";\ndeclare const element: UiEditorElement;\n${contents}\n`), [
        ["answers", `element.addEventListener("mention-query", (event) => event.respondWith([{ id: event.detail.query, label: "" }]));`],
        ["wrong answer", `element.addEventListener("mention-query", (event) => event.respondWith([{ id: 1 }]));`, /number|label/],
      ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
