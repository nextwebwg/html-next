import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";

import { compileScript, compileStyle, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build, transform } from "esbuild";
import { parseFragment } from "parse5";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HtmlDiagnosticError, reactControlArtifact } from "@nextwebwg/html-next";

import { cases as conformanceCases, type ConformanceCase, type DiagnosticExpect } from "../../html-next/tests/conformance/cases.js";

import {
  convertComponents,
  FrameworkConversionError,
  FrameworkDuplicateEntryError,
  FrameworkOutputCollisionError,
  FrameworkTargetVersionError,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "html-next-converter-"));
  temporary.push(root);
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
    <props><prop name="label" type="string" default="Ready">Label.</prop></props>
    <article from:aria-label="$label"><slot></slot></article>
    <style>:host { display: block; }</style>
  </template>`);
  return root;
}

/** Compiles a converted SFC with Vue's own compiler, failing on any error. */
function compileVue(source: string, filename: string): void {
  const parsed = parseVue(source, { filename });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: filename, inlineTemplate: true });
  const template = compileTemplate({
    id: filename,
    filename,
    source: parsed.descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings ?? {} },
  });
  assert.deepEqual(template.errors, []);
}

async function typecheckReact(root: string, files: readonly string[]): Promise<void> {
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  try {
    await promisify(execFile)(process.execPath, [tsc,
      "--noEmit", "--jsx", "react-jsx", "--module", "preserve", "--moduleResolution", "bundler",
      "--target", "ES2022", "--allowImportingTsExtensions", "--skipLibCheck", "--strict", ...files,
    ], { cwd: root });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    assert.fail(failure.stdout || failure.stderr || String(failure));
  }
}

describe("framework converter", () => {
  for (const target of ["react", "svelte", "vue"] as const) {
    it(`resolves shared defaults and preserves ${target}'s component and slot boundaries`, async () => {
      const root = await mkdtemp(join(tmpdir(), "html-next-converter-shared-"));
      temporary.push(root);
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, "defaults.css"), '@namespace svg "http://www.w3.org/2000/svg"; svg|rect { fill: rebeccapurple; } :host, *, *::before, *::after { box-sizing: border-box; } :host-state([open]) { color: rebeccapurple; }');
      await writeFile(join(root, "components.html"), ["x-a", "x-b"].map(tag => `<template component="${tag}"><defs><state name="open" type="boolean" value="true"></state></defs><section><span>own</span><slot></slot></section><style>@import "defaults.css";</style></template>`).join(""));
      const output = join(root, "out");
      const manifest = await convertComponents({ entries: ["components.html"], target, root, outDirectory: output, mode: "library" });
      assert.ok(manifest.sourceFiles.includes("defaults.css"));
      const files = await Promise.all(manifest.output.artifacts.filter(file => file.kind === "component" || file.kind === "style")
        .map(async file => ({ path: file.path, content: await readFile(join(output, file.path), "utf8") })));
      for (const file of files) assert.doesNotMatch(file.content, /@import "defaults\.css"/);
      const css = files.filter(file => file.path.endsWith(".css")).map(file => file.content).join("\n");
      if (target !== "vue") {
        assert.equal(css.match(/@namespace/g)?.length, 1);
        assert.ok(css.indexOf("@namespace") < css.indexOf("@scope"));
        assert.match(css, /htmlnextns[0-9a-f]+\|rect/);
      }
      if (target === "react") assert.equal(css.match(/box-sizing: border-box/g)?.length, 1);
      if (target === "svelte") {
        assert.match(css, /:not\(\[data-html-next-owner~="x-a"\]\)/);
        assert.match(css, /:not\(\[data-html-next-owner~="x-b"\]\)/);
        for (const file of files.filter(file => file.path.endsWith(".svelte"))) assert.match(file.content, /data-html-next-owner/);
      }
      if (target === "vue") for (const file of files) {
        assert.match(file.content, /box-sizing: border-box/);
        compileVue(file.content, file.path);
        const parsed = parseVue(file.content, { filename: file.path });
        for (const style of parsed.descriptor.styles) {
          assert.match(style.content, /@namespace/);
          assert.deepEqual(compileStyle({ source: style.content, filename: file.path, id: 'namespace-test', scoped: style.scoped ?? false }).errors, []);
        }
      }
      for (const tag of ["x-a", "x-b"]) assert.match(files.map(file => file.content).join("\n"), new RegExp(`data-${tag}-state`));
    });
  }

  it("preserves the state reference for an unchanged nested control write", async () => {
    const source = reactControlArtifact().content;
    const compiled = await transform(source, { loader: "ts", format: "esm" });
    const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`) as {
      writeBoundPath<T>(root: T, path: readonly (string | number)[], value: unknown): T;
    };
    const root = { rows: [{ name: "Ada" }] };
    assert.strictEqual(module.writeBoundPath(root, ["rows", 0, "name"], "Ada"), root);
  });

  it("expands one glob into a nested React library with external CSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-nested-"));
    temporary.push(root);
    await mkdir(join(root, "components", "nested"), { recursive: true });
    await writeFile(join(root, "components", "app.html"), `<link rel="component" href="./nested/card.html">
      <template component="x-app" status="early" summary="App."><main><x-card label="Hello"></x-card></main></template>`);
    await writeFile(join(root, "components", "nested", "card.html"), `<template component="x-card" status="early" summary="Card.">
      <props><prop name="label" type="string">Label.</prop></props>
      <article class="card" style="border-radius: 2px" class:ready="true" style:color="'red'" from:aria-label="$label"><slot></slot></article>
      <style>:host { color: red; } :host([label="Hello"]) { font-weight: bold; }</style>
    </template>`);
    await writeFile(join(root, "components", "nested", "orphan.html"),
      '<template component="x-orphan" status="early" summary="Orphan."><aside>Orphan</aside></template>');
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    assert.deepEqual(manifest.package, {
      dependencies: {},
      peerDependencies: { react: "^19.3.0" },
    });
    assert.deepEqual(manifest.components.map(({ artifact }) => artifact), [
      "react/components/XApp.tsx", "react/components/nested/XCard.tsx", "react/components/nested/XOrphan.tsx",
    ]);
    const app = await readFile(join(outDirectory, "react/components/XApp.tsx"), "utf8");
    const card = await readFile(join(outDirectory, "react/components/nested/XCard.tsx"), "utf8");
    assert.match(app, /from "\.\/nested\/XCard\.tsx"/);
    assert.match(card, /import "\.\/XCard\.css"/);
    assert.match(await readFile(join(outDirectory, "react/components/nested/XCard.css"), "utf8"), /data-component/);
    for (const component of manifest.components) {
      await transform(await readFile(join(outDirectory, component.artifact), "utf8"), { loader: "tsx" });
    }
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    assert.match(await readFile(join(outDirectory, manifest.output.entry), "utf8"), /components\/nested\/XOrphan\.tsx/);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      jsx: "automatic",
      packages: "external",
      loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XApp!, { id: "case", className: "outer" })),
      '<main id="case" class="outer" data-component="x-app"><article aria-label="Hello" class="card ready" style="border-radius:2px;color:red" data-label="Hello" data-x-card-state="label label=Hello" data-component="x-card"></article></main>');
  });

  it("does not infer React helpers from authored text", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-helper-text-"));
    temporary.push(root);
    await writeFile(join(root, "card.html"), '<template component="x-card" status="early" summary="Text."><article>attachNativeEvents( attachBoundControl( &lt;SanitizedHtml </article></template>');
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["card.html"] });
    assert.deepEqual(manifest.output.artifacts.filter((artifact) => artifact.kind === "helper"), []);
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.doesNotMatch(component, /import \{ SanitizedHtml \}/);
  });

  it("typechecks native numeric attributes, custom styles, absent object keys, and formatted text", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-strict-tsx-"));
    temporary.push(root);
    await writeFile(join(root, "card.html"), `<template component="x-card" status="early" summary="Strict TSX."><defs>
      <prop name="count" type="integer" default="1">Count.</prop>
      <prop name="choice" type="string">Choice.</prop>
    </defs><div tabindex="-1" style:--_count="$count" from:role="{ true: 'note', false: null }[$choice]">
      <template $value="concat('+', $count)"></template>
    </div></template>`);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./card.html">
      <template component="x-app" status="early" summary="App."><main><x-card style="--ui-color: red"></x-card></main></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["*.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const component = await readFile(join(outDirectory, manifest.components.find((entry) => entry.tag === "x-card")!.artifact), "utf8");
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
  });

  it("converts every successful shared conformance definition to React in both graph modes", async () => {
    const successful = conformanceCases.filter((testCase) => "probe" in testCase.expect);
    assert.equal(successful.length, 36, "review new successful conformance cases for React coverage");
    const root = await mkdtemp(join(tmpdir(), "html-next-react-conformance-"));
    temporary.push(root);
    for (const [index, testCase] of successful.entries()) {
      const nodes = parseFragment(testCase.source, { sourceCodeLocationInfo: true }).childNodes;
      const definition = nodes.find((node) => node.nodeName === "template" &&
        "attrs" in node && node.attrs.some((attribute) => attribute.name === "component"));
      assert.ok(definition?.sourceCodeLocation, testCase.name);
      const entry = `case-${index}.html`;
      await writeFile(join(root, entry), testCase.source.slice(definition.sourceCodeLocation.startOffset, definition.sourceCodeLocation.endOffset));
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `out-${index}-${mode}`);
        const manifest = await convertComponents({ mode, target: "react", root, outDirectory, entries: [entry] });
        assert.equal(manifest.components.length, 1, `${mode}: ${testCase.name}`);
        const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
        assert.doesNotMatch(component, /@nextwebwg\/html-next/, `${mode}: ${testCase.name}`);
      }
    }
  });

  it("keeps a missing React context provider as a runtime diagnostic, not a missing module", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-unlinked-context-"));
    temporary.push(root);
    await writeFile(join(root, "reader.html"), `<template component="x-reader" status="early" summary="Context reader."><defs>
      <context name="current" from="x-provider"></context>
    </defs><span $value="$current"></span></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["reader.html"] });
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "react/context.ts"));
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.match(component, /componentContext<unknown>\("x-provider", "current"\)/);
    assert.doesNotMatch(component, /XProvider\.tsx/);
    await typecheckReact(root, manifest.output.artifacts.filter((artifact) => /\.tsx?$/.test(artifact.path))
      .map((artifact) => join(outDirectory, artifact.path)));
    await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
  });

  it("shares React context across independently converted libraries", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-independent-context-"));
    temporary.push(root);
    await mkdir(join(root, "provider"));
    await mkdir(join(root, "reader"));
    await writeFile(join(root, "provider", "provider.html"), `<template component="x-provider" status="early" summary="Provider."><defs>
      <state type="number" name="current" value="7"></state>
    </defs><section><slot></slot></section></template>`);
    await writeFile(join(root, "reader", "reader.html"), `<template component="x-reader" status="early" summary="Reader."><defs>
      <context name="current" from="x-provider"></context>
    </defs><span $value="$current"></span></template>`);
    await convertComponents({ mode: "library", target: "react", root: join(root, "provider"),
      outDirectory: join(root, "provider-out"), entries: ["provider.html"] });
    await convertComponents({ mode: "library", target: "react", root: join(root, "reader"),
      outDirectory: join(root, "reader-out"), entries: ["reader.html"] });
    const entry = join(root, "entry.tsx");
    await writeFile(entry, `import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { XProvider } from "./provider-out/react/index.ts";
import { XReader } from "./reader-out/react/index.ts";
export const render = () => renderToStaticMarkup(<XProvider><XReader /></XProvider>);
`);
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node",
      format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as { render(): string } };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(module.exports.render(), '<section data-component="x-provider"><span data-slotted="" data-component="x-reader">7</span></section>');
  });

  it("renders native React property bindings through their DOM property", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-properties-"));
    temporary.push(root);
    await writeFile(join(root, "button.html"), `<template component="x-action" status="early" summary="Native properties."><defs>
      <state type="boolean" name="locked" value="true"></state><state name="destination" value="/next"></state>
      </defs><button .disabled="$locked" .formAction="$destination">Go</button></template>`);
    await writeFile(join(root, "text.html"), `<template component="x-text" status="early" summary="Text property."><defs>
      <state name="message" value="Hello"></state>
      </defs><span .textContent="$message"></span></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["*.html"] });
    const files = manifest.output.artifacts.filter((artifact) => /\.tsx?$/.test(artifact.path))
      .map((artifact) => join(outDirectory, artifact.path));
    await typecheckReact(root, files);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.match(renderToStaticMarkup(createElement(module.exports.XAction!)), /<button[^>]*disabled=""[^>]*formAction="\/next"[^>]*>Go<\/button>/);
    assert.match(renderToStaticMarkup(createElement(module.exports.XText!)), /<span[^>]*>Hello<\/span>/);
  });

  it("converts native ref targets for focus and validation handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-ref-actions-"));
    temporary.push(root);
    await writeFile(join(root, "field.html"), '<template component="x-field" status="early" summary="Focusable field."><input required aria-label="Name"></template>');
    await writeFile(join(root, "form.html"), `<link rel="component" href="./field.html"><template component="x-ref-actions" status="early" summary="Ref actions."><defs>
      <state type="number" name="count" value="0"></state>
      <handler name="submit"><validate target="form"></validate><focus ref="field"></focus><set name="count" expr:value="$count + 1"></set></handler>
    </defs><section><form $ref="form"><x-field $ref="field"></x-field></form><button type="button" on:click="submit">Submit</button><output $value="$count"></output></section></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["*.html"] });
    const component = await readFile(join(outDirectory, manifest.components.find((entry) => entry.tag === "x-ref-actions")!.artifact), "utf8");
    const field = await readFile(join(outDirectory, manifest.components.find((entry) => entry.tag === "x-field")!.artifact), "utf8");
    assert.match(component, /reportValidity/);
    assert.match(component, /\.focus\(\)/);
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
    assert.match(field, /useImperativeHandle\(props\.ref/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XRefActions!)),
      '<section data-component="x-ref-actions"><form><input required="" aria-label="Name" data-component="x-field"/></form><button type="button">Submit</button><output>0</output></section>');
  });

  it("converts sequential nested state writes with dynamic index paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-nested-set-"));
    temporary.push(root);
    await writeFile(join(root, "rows.html"), `<template component="x-nested-set" status="early" summary="Nested handler paths."><defs>
      <state type="object({ rows: list(object({ name: string })), selected: number })" name="form" value="{ rows: [{ name: 'Ada' }, { name: 'Bea' }], selected: 1 }"></state>
      <state type="number" name="missingIndex" value="9"></state>
      <handler name="rename"><set name="form.rows[$form.selected].name" value="Ann"></set>
        <set name="form.selected" expr:value="$form.selected - 1"></set>
        <set name="form.rows[$form.selected].name" value="Zoe"></set></handler>
      <handler name="missing"><set name="form.rows[$missingIndex].name" value="Ignored"></set></handler>
    </defs><section><button type="button" on:click="rename">Rename</button><button type="button" on:click="missing">Missing</button>
      <output $value="$form.rows.0.name"></output><output $value="$form.rows.1.name"></output>
      <output $value="$form.selected"></output></section></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["rows.html"] });
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.match(component, /writeStatePath/);
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XNestedSet!)),
      '<section data-component="x-nested-set"><button type="button">Rename</button><button type="button">Missing</button><output>Ada</output><output>Bea</output><output>1</output></section>');
  });

  it("emits declared React data reads without a request during SSR", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-data-"));
    temporary.push(root);
    await mkdir(join(root, "components"));
    await writeFile(join(root, "components", "feed.html"), `<template component="x-feed" status="early" summary="Declared data."><defs>
      <state type="number" name="page" value="1"></state>
      <computed name="requestPage" from="$page + 1"></computed>
      <data name="result" src="./api/feed" type="object({ label: string })" debounce="500ms" poll="1500ms">
        <param name="page" from:value="$requestPage"></param>
      </data>
    </defs><section><output class="value" $value="$result.value.label"></output>
      <output class="pending" $value="$result.pending"></output><output class="ok" $value="$result.ok"></output></section></template>`);
    const outDirectory = join(root, "out");
    await assert.rejects(
      () => convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["components/**"] }),
      (error) => error instanceof FrameworkConversionError && error.message.includes("publicRootURL"),
    );
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory,
      entries: ["components/**"], publicRootURL: "/app/" });
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "react/data.ts" && artifact.kind === "helper"));
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.match(component, /source: "\.\/api\/feed", definition: "\/app\/components\/feed\.html"/);
    assert.match(component, /debounce: 500, poll: 1500/);
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XFeed!)),
      '<section data-component="x-feed"><output class="value"></output><output class="pending">true</output><output class="ok">false</output></section>');
  });

  it("typechecks native React control bindings and emits only their helper", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Controls."><defs>
      <state type="object" name="form" value="{ name: 'Ada', ready: false, choice: 'a', tags: ['a'], note: 'Ready' }"></state>
      </defs><form><input value="Seed" bind:value="form.name"><input type="checkbox" checked bind:checked="form.ready">
      <select bind:value="form.choice"><option value="a">A</option><option value="b" selected>B</option></select>
      <select multiple bind:value="form.tags"><option value="a">A</option><option value="b" selected>B</option></select>
      <textarea bind:value="form.note">Draft</textarea></form></template>`);
    const outDirectory = join(root, "react-controls");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "react/control.ts" && artifact.kind === "helper"));
    assert.ok(!manifest.output.artifacts.some((artifact) => artifact.path === "react/events.ts"));
    assert.doesNotMatch(await readFile(join(outDirectory, "react/XCard.tsx"), "utf8"), /latestHandlers/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
  });

  it("converts a native control bound through a dynamic state index", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Dynamic control path."><defs>
      <state type="list(unknown)" name="rows" value="[{ name: 'Ada' }, { name: 'Bea' }]"></state>
      <state type="number" name="selected" value="1"></state>
    </defs><section><input bind:value="rows[$selected].name"><output $value="$rows[$selected].name"></output></section></template>`);
    const outDirectory = join(root, "react-dynamic-control");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.match(component, /writeBoundPath/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XCard!)),
      '<section data-component="x-card"><input value="Bea"/><output>Bea</output></section>');
  });

  it("renders read-only native control properties without turning them into React-controlled fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-control-properties-"));
    temporary.push(root);
    await writeFile(join(root, "controls.html"), `<template component="x-controls" status="early" summary="Read-only control properties."><defs>
      <state type="object" name="form" value="{ text: 'Ada', ready: false, choice: 'b', note: 'Memo' }"></state>
      </defs><form><input class="text" value="Seed" .value="$form.text">
      <input class="check" type="checkbox" checked .checked="$form.ready">
      <select class="choice" .value="$form.choice"><option value="a" selected>A</option><option value="b">B</option></select>
      <select class="multiple" multiple .value="$form.choice"><option value="a" selected>A</option><option value="b">B</option></select>
      <textarea class="note" .value="$form.note">Draft</textarea></form></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["controls.html"] });
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "react/control.ts" && artifact.kind === "helper"));
    const files = manifest.output.artifacts.filter((artifact) => /\.tsx?$/.test(artifact.path))
      .map((artifact) => join(outDirectory, artifact.path));
    await typecheckReact(root, files);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    const markup = renderToStaticMarkup(createElement(module.exports.XControls!));
    assert.match(markup, /class="text"[^>]*value="Ada"/);
    assert.match(markup, /<input(?=[^>]*class="check")(?=[^>]*type="checkbox")[^>]*\/>/);
    assert.doesNotMatch(markup, /<input(?=[^>]*class="check")[^>]*checked/);
    assert.match(markup, /class="choice"[\s\S]*<option value="b" selected=""/);
    assert.match(markup, /class="multiple"[\s\S]*<option value="b" selected=""/);
    assert.match(markup, /<textarea class="note">Memo<\/textarea>/);
  });

  it("discovers a nested component directory and mirrors its graph in Vue output", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-nested-"));
    temporary.push(root);
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "components", "widgets", "nested"), { recursive: true });
    await writeFile(join(root, "components", "app.html"), `<link rel="component" href="./widgets/card.html">
      <template component="x-app" status="early" summary="App."><main><x-card></x-card></main></template>`);
    await writeFile(join(root, "components", "widgets", "card.html"), `<link rel="component" href="./nested/badge.html">
      <template component="x-card" status="early" summary="Card."><article><x-badge></x-badge></article></template>`);
    await writeFile(join(root, "components", "widgets", "nested", "badge.html"),
      '<template component="x-badge" status="early" summary="Badge."><strong>Badge</strong></template>');
    await writeFile(join(root, "components", "widgets", "orphan.html"),
      '<template component="x-orphan" status="early" summary="Orphan."><aside>Orphan</aside></template>');

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `generated-${mode}`);
      const manifest = await convertComponents({ mode, entries: ["components/**"], target: "vue", root, outDirectory });
      assert.deepEqual(manifest.components.map(({ source, artifact }) => [source, artifact]), [
        ["components/app.html", "vue/components/XApp.vue"],
        ["components/widgets/card.html", "vue/components/widgets/XCard.vue"],
        ["components/widgets/nested/badge.html", "vue/components/widgets/nested/XBadge.vue"],
        ["components/widgets/orphan.html", "vue/components/widgets/XOrphan.vue"],
      ]);
      const app = await readFile(join(outDirectory, "vue", "components", "XApp.vue"), "utf8");
      const card = await readFile(join(outDirectory, "vue", "components", "widgets", "XCard.vue"), "utf8");
      assert.match(app, /from ['"]\.\/widgets\/XCard\.vue['"]/);
      assert.match(card, /from ['"]\.\/nested\/XBadge\.vue['"]/);
      for (const component of manifest.components) {
        compileVue(await readFile(join(outDirectory, component.artifact), "utf8"), component.artifact);
      }
      const entry = await readFile(join(outDirectory, manifest.output.entry), "utf8");
      assert.match(entry, /from "\.\/components\/XApp\.vue"/);
      assert.match(entry, /from "\.\/components\/widgets\/XOrphan\.vue"/);
    }
    const shorthand = await convertComponents({
      mode: "library", entries: ["components/"], target: "vue", root,
      outDirectory: join(root, "generated-directory"),
    });
    assert.deepEqual(shorthand.components.map(({ tag }) => tag), ["x-app", "x-card", "x-badge", "x-orphan"]);
  });

  it("rejects an empty component glob without producing output", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated-empty");
    await assert.rejects(
      () => convertComponents({ mode: "library", entries: ["missing/**"], target: "vue", root, outDirectory }),
      /matched no HTML component files/,
    );
    await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
  });

  it("server-renders React structural templates and sorted loops without wrapper elements", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
      <ul><template $if="true"><li $each="n, i of [3, 1, 2]" $sort="n" from:data-i="$i" from:data-last="$loop.last" $value="$n"></li></template></ul>
    </template>`);
    const outDirectory = join(root, "out-react-structure");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external",
      loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XCard!, {})),
      '<ul data-component="x-card"><li data-i="0">1</li><li data-i="1">2</li><li data-i="2" data-last="">3</li></ul>');
  });

  it("server-renders a React $match branch inside a table", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
      <props><prop name="status" type="keyword" values="ok, bad" default="ok">Status.</prop></props>
      <table from:data-status="$status"><tbody><template $match="$status as s"><tr $when="$s = 'ok'"><td>OK</td></tr><tr $else><td>No</td></tr></template></tbody></table>
    </template>`);
    const outDirectory = join(root, "out-react-match");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external",
      loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XCard!, { status: "bad" })),
      '<table data-status="bad" data-component="x-card"><tbody><tr><td>No</td></tr></tbody></table>');
  });

  it("checks and reflects typed React props at the public boundary", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
      <props><prop name="count" type="number" required>Count.</prop><prop name="active" type="boolean" default="false">Active.</prop></props>
      <output from:data-count="$count" from:data-active="$active" $value="$count"></output>
    </template>`);
    const outDirectory = join(root, "out-react-props");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "react/props.ts"));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external",
      loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    const render = (props: Record<string, unknown>): string => renderToStaticMarkup(createElement(module.exports.XCard!, props));
    assert.equal(render({ count: 42, active: "" }),
      '<output data-count="42" data-active="false" data-component="x-card">42</output>');
    assert.equal(render({ count: "42", active: "" }),
      '<output data-active="false" data-component="x-card"></output>');
    assert.equal(render({}), '<output data-active="false" data-component="x-card"></output>');
    assert.equal(render({ count: "wrong" }), '<output data-active="false" data-component="x-card"></output>');
  });

  it("typechecks generated reactive React TSX", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card."><defs>
      <state type="number" name="count" value="0"></state>
      <computed name="double" from="$count * 2"></computed>
      <event name="changed" type="number"></event>
      <handler name="increment"><set name="count" expr:value="$count + 1"></set><dispatch event="changed" expr:value="$count"></dispatch></handler>
    </defs><button type="button" on:click="increment" $value="$double"></button></template>`);
    const outDirectory = join(root, "out-react-reactive");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-card.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
  });

  it("converts declared state and event shapes through both React dispatch paths", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.js"), "export default function controller() {}\n");
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Declared shapes." controller="./x-card.js"><defs>
      <state type="keyword" name="headingRole"></state>
      <event name="changed" type="object"><prop name="reason" type="keyword" values="action, programmatic" required></prop></event>
      <handler name="emit"><dispatch event="changed" expr:value="{ reason: 'action' }"></dispatch></handler>
    </defs><button type="button" on:click="emit" from:role="$headingRole">Change</button></template>`);
    const outDirectory = join(root, "out-react-declared-shapes");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const component = await readFile(join(outDirectory, "react/XCard.tsx"), "utf8");
    assert.match(component, /reason.*action.*programmatic/);
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
  });

  it("typechecks React handlers whose HTML names are not JavaScript identifiers", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card."><defs>
      <state type="number" name="count" value="0"></state>
      <handler name="switch"><set name="count" expr:value="$count + 1"></set></handler>
      <handler name="step-up"><set name="count" expr:value="$count + 1"></set></handler>
    </defs><button type="button" on:click="switch" on:keydown="step-up" $value="$count"></button></template>`);
    const outDirectory = join(root, "out-react-handler-names");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-card.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
  });

  it("typechecks React state, data, and computed names that are JavaScript keywords", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card."><defs>
      <state type="number" name="switch" value="1"></state>
      <data name="default" type="number"></data>
      <computed name="class" from="$switch + 1"></computed>
      <handler name="raise"><set name="switch" expr:value="$switch + 1"></set></handler>
    </defs><div><button type="button" on:click="raise" $value="$class"></button><output $value="$default.pending"></output></div></template>`);
    const outDirectory = join(root, "out-react-value-names");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-card.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
  });

  it("typechecks a React context exported under a Unicode state name", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<link rel="component" href="./x-reader.html">
      <template component="x-card" status="early" summary="Card."><defs>
        <state name="selection😀" value="ready"></state>
      </defs><section><x-reader></x-reader></section></template>`);
    await writeFile(join(root, "x-reader.html"), `<template component="x-reader" status="early" summary="Reader."><defs>
      <context name="selection😀" from="x-card" as="mode"></context>
    </defs><output $value="$mode"></output></template>`);
    const outDirectory = join(root, "out-react-context-name");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-card.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
  });

  it("converts a controller-backed React component without a runtime dependency", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card." controller="./controller.js"><defs>
      <state type="number" name="count" value="0"></state>
      <event name="changed" type="number"></event>
    </defs><article><button type="button" $ref="button">Increase</button><output $value="$count"></output><slot></slot></article></template>`);
    await writeFile(join(root, "controller.js"), `function connect(host) {
  const stop = host.effect(() => {
    const button = host.refs.button;
    const onClick = () => { host.state.count += 1; host.dispatch("changed", host.state.count); };
    button.addEventListener("click", onClick);
    return () => button.removeEventListener("click", onClick);
  });
  return stop;
}

export default function initialize(host) { host.on("connect", () => connect(host)); }
`);
    const outDirectory = join(root, "out-react-controller");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-card.html"] });
    assert.ok(manifest.output.artifacts.some(({ kind, path }) => kind === "controller" && path.endsWith("/controller.js")));
    assert.ok(manifest.output.artifacts.some(({ kind, path }) => kind === "helper" && path === "react/host.ts"));
    const component = await readFile(join(outDirectory, "react/XCard.tsx"), "utf8");
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XCard!, { children: "Projected" })),
      '<article data-component="x-card"><button type="button">Increase</button><output>0</output>Projected</article>');
  });

  it("server-renders an important inline style in React without an HTML Next runtime import", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-accent.html"), `<template component="x-accent" status="early" summary="Accent.">
      <button style="color: red !important; border-radius: 0">Accent</button>
      <style>:host { color: blue; }</style>
    </template>`);
    const outDirectory = join(root, "out-react-important");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-accent.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const component = await readFile(join(outDirectory, "react/XAccent.tsx"), "utf8");
    assert.doesNotMatch(component, /@nextwebwg\/html-next/);
    const bundle = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.match(renderToStaticMarkup(createElement(module.exports.XAccent!)), /style="color:red !important;border-radius:0"/);
  });

  it("converts a delegated React root into the child's native root", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-base-button.html"), `<template component="x-base-button" status="early" summary="Base button.">
      <button type="button" class="base"><slot></slot></button>
      <style>:host { border: 1px solid blue; }</style>
    </template>`);
    await writeFile(join(root, "x-primary.html"), `<link rel="component" href="./x-base-button.html">
      <template component="x-primary" status="early" summary="Primary button.">
        <x-base-button class="primary"><slot></slot></x-base-button>
        <style>:host { color: red; }</style>
      </template>`);
    const outDirectory = join(root, "out-react-delegated");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["*.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    const markup = renderToStaticMarkup(createElement(module.exports.XPrimary!, { id: "case", children: "Projected" }));
    assert.match(markup, /^<button\b/);
    assert.match(markup, /class="base primary"/);
    assert.match(markup, /data-component="x-primary x-base-button"/);
    assert.match(markup, />Projected<\/button>$/);
  });

  it("server-renders a polymorphic native React root without a wrapper", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-switch.html"), `<template component="x-switch" status="early" summary="Polymorphic root."><defs>
      <state type="boolean" name="linked" value="false"></state>
      <handler name="switch"><set name="linked" expr:value="$linked = false"></set></handler>
    </defs><template $match><a $when="$linked" href="#next" on:click="switch">Link</a>
      <button $else type="button" on:click="switch">Button</button></template>
    <style>:host { color: blue; }</style></template>`);
    const outDirectory = join(root, "out-react-polymorphic");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-switch.html"] });
    assert.match(await readFile(join(outDirectory, "react/XSwitch.tsx"), "utf8"),
      /ref\?: React\.Ref<HTMLAnchorElement \| HTMLButtonElement>/);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.match(renderToStaticMarkup(createElement(module.exports.XSwitch!, { id: "case" })),
      /^<button\b[^>]*id="case"[^>]*data-component="x-switch"[^>]*>Button<\/button>$/);
  });

  it("converts a generic React two-way attribute binding", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-editor.html"), `<template component="x-editor" status="early" summary="Generic binding."><defs>
      <state name="name" value="Ada"></state>
    </defs><section><output bind:value="name"></output><span $value="$name"></span></section></template>`);
    const outDirectory = join(root, "out-react-generic-binding");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-editor.html"] });
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "react/control.ts"));
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.match(renderToStaticMarkup(createElement(module.exports.XEditor!)),
      /<output value="Ada"><\/output><span>Ada<\/span>/);
  });

  it("passes a generic React binding through a nested component root", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-field.html"), `<template component="x-field" status="early" summary="Text field."><defs>
      <prop name="value" type="string" default="">Value.</prop>
    </defs><input type="text" from:value="$value"></template>`);
    await writeFile(join(root, "x-form.html"), `<link rel="component" href="./x-field.html">
      <template component="x-form" status="early" summary="Bound field."><defs>
        <state name="name" value="Ada"></state>
      </defs><section><x-field bind:value="name"></x-field><output $value="$name"></output></section></template>`);
    const outDirectory = join(root, "out-react-nested-binding");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["*.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.match(renderToStaticMarkup(createElement(module.exports.XForm!)), /<input\b[^>]*value="Ada"[^>]*><output>Ada<\/output>/);
  });

  it("typechecks multiple dynamic generic bindings on one React element", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-editor.html"), `<template component="x-editor" status="early" summary="Dynamic bindings."><defs>
      <state type="list(unknown)" name="rows" value="[{ name: 'Ada' }, { name: 'Bea' }]"></state>
      <state type="number" name="selected" value="0"></state>
    </defs><section><output bind:value="rows[$selected].name" bind:title="rows[$selected].name"></output></section></template>`);
    const outDirectory = join(root, "out-react-dynamic-generic");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-editor.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const component = await readFile(join(outDirectory, "react/XEditor.tsx"), "utf8");
    assert.match(component, /genericCleanup0/);
    assert.match(component, /genericCleanup1/);
    assert.match(component, /paths\?\.\[1\]/);
    assert.match(component, /paths\?\.\[2\]/);
  });

  it.each([
    ["self", '<computed name="loop" from="$loop + 1"></computed>', "loop"],
    ["mutual", '<computed name="left" from="$right + 1"></computed><computed name="right" from="$left + 1"></computed>', "left"],
  ])("reports HR006 for a %s React computed cycle", async (_kind, declarations, value) => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card."><defs>${declarations}</defs>
      <output from:data-value="$${value}"></output></template>`);
    const outDirectory = join(root, "out-react-cycle");
    const manifest = await convertComponents({ mode: "application", target: "react", root, outDirectory, entries: ["x-card.html"] });
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.throws(() => renderToStaticMarkup(createElement(module.exports.XCard!, {})), (error: unknown) => {
      const candidate = error as Error & { diagnostic?: { code: string } };
      return candidate.name === "HtmlDiagnosticError" && candidate.diagnostic?.code === "HR006" &&
        candidate.message === "HR006: A reactive computed value depends on itself.";
    });
  });

  it("server-renders a root $with and inline <template $value> without DOM wrappers", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
      <div $with="{ name: 'Ada' } as user"><template $value="$user.name"></template></div>
    </template>`);
    const outDirectory = join(root, "out-react-with");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external",
      loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XCard!, {})), '<div data-component="x-card">Ada</div>');
  });

  it("exports every named component from one HTML resource and tracks its source", async () => {
    const root = await fixture();
    await writeFile(join(root, "library.html"), `
      <template component="ui-button" status="early" summary="Button."><button>Save</button></template>
      <template component="ui-dialog" status="early" summary="Dialog."><section><ui-button></ui-button></section></template>
    `);
    for (const target of ["vue", "react"] as const) for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `multi-${target}-${mode}`);
      const manifest = await convertComponents({ mode, entries: ["library.html"], target, root, outDirectory });
      assert.deepEqual(manifest.entries.map(({ tag }) => tag).sort(), ["ui-button", "ui-dialog"]);
      assert.deepEqual(manifest.sourceFiles, ["library.html"]);
      const entry = await readFile(join(outDirectory, manifest.output.entry), "utf8");
      assert.match(entry, /default as UiButton/);
      assert.match(entry, /default as UiDialog/);
      assert.doesNotMatch(entry, /default as Button|export default/);
      if (target === "react") {
        const dialog = await readFile(join(outDirectory, "react/UiDialog.tsx"), "utf8");
        assert.match(dialog, /["']\.\/UiButton\.tsx["']/);
      } else {
        compileVue(await readFile(join(outDirectory, "vue/UiButton.vue"), "utf8"), "UiButton.vue");
        const dialog = await readFile(join(outDirectory, "vue/UiDialog.vue"), "utf8");
        compileVue(dialog, "UiDialog.vue");
        assert.match(dialog, /["']\.\/UiButton\.vue["']/);
      }
    }
  });

  it("resolves exported package component subpaths from the consuming project", async () => {
    const root = await fixture();
    const packageRoot = join(root, "node_modules", "@acme", "ui");
    await mkdir(join(packageRoot, "components"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@acme/ui",
      exports: { "./*.html": "./components/*.html" },
    }));
    await writeFile(join(packageRoot, "components", "badge.html"),
      '<template component="x-badge" status="early" summary="Badge."><span>Badge</span></template>');
    await writeFile(join(root, "x-card.html"),
      '<link rel="component" href="@acme/ui/badge.html"><template component="x-card" status="early" summary="Card."><article><x-badge></x-badge></article></template>');

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `generated-${mode}`);
      const manifest = await convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory });
      assert.deepEqual(manifest.components.map(({ tag }) => tag).sort(), ["x-badge", "x-card"]);
      for (const component of manifest.components) {
        compileVue(await readFile(join(outDirectory, component.artifact), "utf8"), component.artifact);
      }
    }
  });

  it("uses HTML parser recovery for duplicate attributes, as the browser does", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"),
      '<template component="x-card" status="early" summary="Card."><article class="first" class="second">Ready</article></template>');
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `recovered-${mode}`);
      await convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory });
      const source = await readFile(join(outDirectory, "vue", "XCard.vue"), "utf8");
      compileVue(source, "XCard.vue");
      assert.match(source, /class="first"/);
      assert.doesNotMatch(source, /class="second"/);
    }
  });

  it("reports unresolved package component subpaths at their importing definition", async () => {
    const root = await fixture();
    const packageRoot = join(root, "node_modules", "@acme", "ui");
    await mkdir(join(packageRoot, "components"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@acme/ui",
      exports: { "./badge.html": "./components/badge.html" },
    }));
    await writeFile(join(packageRoot, "components", "badge.html"),
      '<template component="x-badge" status="early" summary="Badge."><span>Badge</span></template>');
    for (const [name, specifier] of [["unexported", "@acme/ui/hidden.html"], ["missing", "@acme/missing/hidden.html"]] as const) {
      await writeFile(join(root, "x-card.html"),
        `<link rel="component" href="${specifier}"><template component="x-card" status="early" summary="Card."><article></article></template>`);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `generated-${name}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === "HL002" &&
            error.diagnostic.source?.endsWith("/x-card.html") === true,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
      }
    }
  });

  it("retains component-graph diagnostics without writing partial Vue output", async () => {
    const root = await fixture();
    const cases = [
      {
        name: "missing dependency",
        source: '<link rel="component" href="./missing.html"><template component="x-card" status="early" summary="Card."><article></article></template>',
        code: "HL009",
        sourceSuffix: "/missing.html",
      },
      {
        name: "dependency escapes package",
        source: '<link rel="component" href="../outside.html"><template component="x-card" status="early" summary="Card."><article></article></template>',
        code: "HL003",
        sourceSuffix: "/x-card.html",
      },
      {
        name: "controller escapes package",
        source: '<template component="x-card" status="early" summary="Card." controller="../outside.js"><article></article></template>',
        code: "HL005",
        sourceSuffix: "/x-card.html",
      },
      {
        name: "empty dependency URL",
        source: '<link rel="component" href=""><template component="x-card" status="early" summary="Card."><article></article></template>',
        code: "HL006",
        sourceSuffix: "/x-card.html",
      },
    ] as const;

    for (const testCase of cases) {
      await writeFile(join(root, "x-card.html"), testCase.source);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `generated-${testCase.code}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === testCase.code &&
            error.diagnostic.source?.endsWith(testCase.sourceSuffix) === true,
          `${mode}: ${testCase.name}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" }, `${mode}: ${testCase.name} wrote output`);
      }
    }
  });

  it("retains every static conformance diagnostic with its source and writes no output", async () => {
    const runtimeOnly = new Set([
      "HR001: two definitions declare the same tag",
    ]);
    const diagnostics = conformanceCases.filter((testCase): testCase is ConformanceCase & { readonly expect: DiagnosticExpect } =>
      "code" in testCase.expect);
    assert.equal(diagnostics.length, 27, "review new diagnostic cases for converter coverage");
    const staticDiagnostics = diagnostics.filter((testCase) => !runtimeOnly.has(testCase.name));
    assert.equal(staticDiagnostics.length, 26);
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-diagnostics-"));
    temporary.push(root);
    await mkdir(join(root, "components"));

    for (const [index, testCase] of staticDiagnostics.entries()) {
      const closing = testCase.source.lastIndexOf("</template>");
      assert.ok(closing >= 0, `${testCase.name} needs a component definition`);
      const entry = `components/invalid-${index}.html`;
      await writeFile(join(root, entry), testCase.source.slice(0, closing + "</template>".length));
      for (const target of ["vue", "react"] as const) {
        for (const mode of ["application", "library"] as const) {
          const outDirectory = join(root, `out-${target}-${mode}-${index}`);
          await assert.rejects(
            () => convertComponents({ mode, entries: [entry], target, root, outDirectory }),
            (error) => error instanceof HtmlDiagnosticError &&
              error.diagnostic.code === testCase.expect.code &&
              error.diagnostic.source?.endsWith(entry) === true,
            `${target}/${mode}: ${testCase.name}`,
          );
          await assert.rejects(() => access(outDirectory), { code: "ENOENT" }, `${target}/${mode}: ${testCase.name} wrote output`);
        }
      }
    }
  });

  it("preserves additional parser diagnostics through both public Vue graph modes", async () => {
    const root = await fixture();
    const invalid = [
      { code: "HC022", body: '<template component="x-card" status="early" summary="Card." controller=""><article></article></template>' },
      { code: "HC023", body: '<template component="x-card" status="early" summary="Card."><defs><handler name="go"><set name="count"></set></handler></defs><article></article></template>' },
      { code: "HT017", body: '<template component="x-card" status="early" summary="Card."><article $match="$oops"></article></template>' },
      { code: "HT019", body: '<template component="x-card" status="early" summary="Card."><article $ref="invalid name"></article></template>' },
      { code: "HT020", body: '<template component="x-card" status="early" summary="Card."><article style:1bad="true"></article></template>' },
      { code: "HY001", body: '<template component="x-card" status="early" summary="Card."><article></article><style>:host-state([missing]) { color: red; }</style></template>' },
      { code: "HY002", body: '<template component="x-card" status="early" summary="Card."><defs><state name="items" type="list(string)" value="[]"></state></defs><article></article><style>:host-state([items]) { color: red; }</style></template>' },
      { code: "HY003", body: '<template component="x-card" status="early" summary="Card."><article></article><style>:scope { color: red; }</style></template>' },
    ] as const;

    for (const { code, body } of invalid) {
      await writeFile(join(root, "x-card.html"), body);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `invalid-${code}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: ["x-card.html"], target: "vue", root, outDirectory }),
          (error) => error instanceof HtmlDiagnosticError &&
            error.diagnostic.code === code &&
            error.diagnostic.source?.endsWith("/x-card.html") === true,
          `${mode}: ${code}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" }, `${mode}: ${code} wrote output`);
      }
    }
  });

  it("emits a Vue component with only its authored-feature helper", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["x-card.html"], target: "vue", root, outDirectory });
    const path = join(outDirectory, "vue", "XCard.vue");
    const source = await readFile(path, "utf8");

    compileVue(source, path);
    assert.doesNotMatch(source, /@nextwebwg/);
    assert.doesNotMatch(source, /html-next:nested-depth/, "ordinary graphs must not pay for the recursion guard");
    assert.deepEqual([...source.matchAll(/^import[^\n]*from ['"]([^'"]+)['"]/gm)].map((match) => match[1]).filter((from) => from !== "vue"), ["./props"]);
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "vue/props.ts" && artifact.kind === "helper"));
    assert.match(await readFile(join(outDirectory, "vue", "props.ts"), "utf8"), /function checkedProp/);
    assert.match(source, /<style scoped>\n@scope \(\[data-component~="x-card"\]\) to \(\[data-component\]\) \{\s+:scope \{\s+display: block;\s+\}/);
    assert.equal(manifest.graph, "application");
    assert.deepEqual(manifest.entries, [{ source: "x-card.html", tag: "x-card", artifact: "vue/XCard.vue" }]);
    assert.equal(manifest.output.entry, "vue/application.ts");
    assert.equal(manifest.output.inventory, "html-next.conversion.json");
    assert.equal(await readFile(join(outDirectory, "vue", "application.ts"), "utf8"), 'export { default as XCard } from "./XCard.vue";\n');
  });

  it("omits the typed-prop helper from a prop-free graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-no-props-"));
    temporary.push(root);
    await writeFile(join(root, "static.html"), '<template component="x-static" status="early" summary="Static."><p>Ready</p></template>');
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["static.html"], target: "vue", root, outDirectory });
    assert.equal(manifest.output.artifacts.some((artifact) => artifact.path === "vue/props.ts"), false);
    await assert.rejects(() => access(join(outDirectory, "vue", "props.ts")), { code: "ENOENT" });
  });

  it("maps state, computed values, handlers, and typed events to Vue", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-reactive-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <computed name="double" from="$count * 2"></computed>
        <event name="count-change" type="number"></event>
        <handler name="increment">
          <set name="count" expr:value="$count + 1"></set>
          <dispatch event="count-change" expr:value="$count"></dispatch>
        </handler>
      </defs>
      <button from:data-count="$count" on:click="increment"><output $value="$double"></output></button>
    </template>`);
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["counter.html"], target: "vue", root, outDirectory });
    const path = join(outDirectory, "vue", "XCounter.vue");
    const source = await readFile(path, "utf8");

    compileVue(source, path);
    assert.match(source, /from '\.\/host'/);
    assert.ok(manifest.output.artifacts.some((artifact) => artifact.path === "vue/host.ts"));
    assert.match(await readFile(join(outDirectory, "vue", "host.ts"), "utf8"), /function useComponentHost/);
    assert.doesNotMatch(source, /@nextwebwg/);
    assert.match(source, /const count = ref\(0\)\n/);
    assert.match(source, /const double = cycleCheckedComputed\(\(\) => \{[\s\S]*return doublePrevious = count\.value \* 2/);
    assert.match(source, /function increment\(\): void \{/);
    assert.match(source, /const next0 = count\.value \+ 1/);
    assert.match(source, /count\.value = next0 as never/);
    assert.match(source, /dispatch\('count-change', count\.value\)/);
    assert.match(source, /const isCountChangeDetail = \(\s*detail: unknown,?\s*\): boolean => \(?typeof detail === 'number' && Number\.isFinite\(detail\)/);
    assert.match(source, /:data-count="guarded"/);
  });

  it("keeps root-relative data requests on the browser origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-data-root-"));
    temporary.push(root);
    await writeFile(join(root, "feed.html"), `<template component="x-feed" status="early" summary="Feed."><defs>
      <data name="result" src="/api/feed" type="object({ label: string })"></data>
    </defs><output $value="$result.value.label"></output></template>`);
    const outDirectory = join(root, "generated");
    await convertComponents({ mode: "application", entries: ["feed.html"], target: "vue", root, outDirectory });
    const source = await readFile(join(outDirectory, "vue", "XFeed.vue"), "utf8");

    compileVue(source, "XFeed.vue");
    assert.doesNotMatch(source, /file:\/\//);
    assert.match(source, /useDataRead\(result, \{\s+source: '\/api\/feed',\s+definition: '',/);
  });

  it("requires a public URL mapping for component-relative data requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-data-relative-"));
    temporary.push(root);
    await mkdir(join(root, "components"));
    await writeFile(join(root, "components", "feed.html"), `<template component="x-feed" status="early" summary="Feed."><defs>
      <data name="result" src="./api/feed" type="object({ label: string })"></data>
    </defs><output $value="$result.value.label"></output></template>`);
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "application", entries: ["components/feed.html"], target: "vue", root, outDirectory }),
      (error) => error instanceof FrameworkConversionError && error.message.includes("publicRootURL"),
    );
    await assert.rejects(() => access(outDirectory));

    const manifest = await convertComponents({ mode: "application", entries: ["components/feed.html"], target: "vue", root, outDirectory, publicRootURL: "/app/" });
    const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    compileVue(source, "XFeed.vue");
    assert.doesNotMatch(source, /file:\/\//);
    assert.match(source, /useDataRead\(result, \{\s+source: '\.\/api\/feed',\s+definition: '\/app\/components\/feed\.html',/);
  });

  it("copies the controller beside the component and imports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-"));
    temporary.push(root);
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "components", "x-toggle"), { recursive: true });
    await mkdir(join(root, "components", "shared"), { recursive: true });
    await writeFile(join(root, "components", "x-toggle", "x-toggle.html"), `<template component="x-toggle" status="early" summary="Toggle." controller="./x-toggle.js">
      <defs><state type="boolean" name="on" value="false"></state></defs>
      <button type="button"><slot></slot></button>
    </template>`);
    await writeFile(join(root, "components", "x-toggle", "x-toggle.js"), "import { flip } from \"../shared/flip.js\";\nfunction controller(host) { const root = host.root; const onClick = () => { host.state.on = flip(host.state.on); }; root.addEventListener(\"click\", onClick); return () => root.removeEventListener(\"click\", onClick); }\n\nexport default function initialize(host) { host.on(\"connect\", () => controller(host)); }\n");
    await writeFile(join(root, "components", "shared", "flip.js"), "export const flip = (value) => !value;\n");
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["components/x-toggle/x-toggle.html"], target: "vue", root, outDirectory });
    const source = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");

    assert.match(source, /\(\) => import\('\.\.\/\.\.\/controllers\/x-toggle\/x-toggle\/x-toggle\.js'\)/);
    assert.equal(manifest.components[0]?.controller, "vue/controllers/x-toggle/x-toggle/x-toggle.js");
    await access(join(outDirectory, "vue", "controllers", "x-toggle", "x-toggle", "x-toggle.js"));
    await access(join(outDirectory, "vue", "controllers", "x-toggle", "shared", "flip.js"));
    assert.ok(manifest.output.artifacts.some(({ path, kind }) => kind === "controller" && path.endsWith("shared/flip.js")));
  });

  it("reports missing and escaping controller resources at the component source without partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-diagnostics-"));
    temporary.push(root);
    await mkdir(join(root, "components"));
    const outside = await mkdtemp(join(tmpdir(), "html-next-converter-controller-outside-"));
    temporary.push(outside);
    await writeFile(join(outside, "secret.js"), "export const secret = true;\n");
    await symlink(join(outside, "secret.js"), join(root, "components", "linked.js"));
    const scenarios = [
      { name: "missing-controller", controller: "./missing.js", expected: "missing.js" },
      { name: "missing-import", controller: "./missing-import.js", module: 'import "./absent.js";\nexport default function controller() {}\n', expected: "absent.js" },
      { name: "escaping-import", controller: "./escaping-import.js", module: 'import "../../outside.js";\nexport default function controller() {}\n', expected: "outside the component's approved root" },
      { name: "symlink-import", controller: "./symlink-import.js", module: 'import "./linked.js";\nexport default function controller() {}\n', expected: "outside the component's approved root" },
    ] as const;
    for (const scenario of scenarios) {
      const entry = `components/${scenario.name}.html`;
      await writeFile(join(root, entry), `<template component="x-${scenario.name}" status="early" summary="Controller resource." controller="${scenario.controller}"><div></div></template>`);
      if ("module" in scenario) await writeFile(join(root, "components", `${scenario.name}.js`), scenario.module);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, `${scenario.name}-${mode}`);
        await assert.rejects(
          () => convertComponents({ mode, entries: [entry], target: "vue", root, outDirectory }),
          (error) => error instanceof FrameworkConversionError && error.code === "HTC001" &&
            error.source === entry && error.tag === `x-${scenario.name}` && error.message.includes(scenario.expected),
          `${mode}: ${scenario.name}`,
        );
        await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
      }
    }
  });

  it("rejects unresolved dynamic controller imports before emitting relocated code", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-dynamic-"));
    temporary.push(root);
    await writeFile(join(root, "dynamic.html"), '<template component="x-dynamic" status="early" summary="Dynamic controller." controller="./dynamic.js"><div></div></template>');
    await writeFile(join(root, "dynamic.js"), 'const specifier = "./helper.js";\nexport default async function controller() { return import(specifier); }\n');
    await writeFile(join(root, "helper.js"), "export const value = 1;\n");
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, mode);
      await assert.rejects(
        () => convertComponents({ mode, entries: ["dynamic.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof FrameworkConversionError && error.code === "HTC001" &&
          error.source === "dynamic.html" && error.tag === "x-dynamic" &&
          error.message.includes("dynamic import") && error.message.includes("dynamic.js"),
      );
      await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
    }
  });

  for (const mode of ["application", "library"] as const) {
    it(`rejects duplicate ${mode} roots before writing output`, async () => {
      const root = await fixture();
      const outDirectory = join(root, "generated");
      await assert.rejects(
        () => convertComponents({ mode, entries: ["x-card.html", "x-card.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof FrameworkDuplicateEntryError && error.code === "HTC002" && error.source === "x-card.html",
      );
      await assert.rejects(() => access(outDirectory));
    });
  }

  it("converts a real-element root $match through the public Vue converter", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-gap-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs><prop name="as" type="keyword" values="a, b" default="a">Kind.</prop></defs>
      <section $match from:data-as="$as"><p $when="$as = 'a'">A</p><p $else>B</p></section>
    </template>`);
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["counter.html"], target: "vue", root, outDirectory });
    const component = await readFile(join(outDirectory, manifest.components[0]!.artifact), "utf8");
    assert.match(component, /<section[\s\S]*:data-as="reflectedProp\('as'/);
    assert.match(component, /<p v-if="checkedProps\.as === 'a'">A<\/p>/);
  });

  it("reports a source-located diagnostic for a guarded component root", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-gap-"));
    temporary.push(root);
    await writeFile(join(root, "guarded.html"), `<template component="x-guarded" status="early" summary="Guarded.">
      <defs><prop name="show" type="boolean" default="true">Visibility.</prop></defs>
      <section $if="$show" from:data-show="$show">Visible</section>
    </template>`);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, `generated-${mode}`);
      await assert.rejects(
        () => convertComponents({ mode, entries: ["guarded.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT021" &&
          error.diagnostic.source?.endsWith("/guarded.html") === true,
      );
      await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
    }
  });

  it("emits the sanitizer helper only for converted components using $html", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-html-"));
    temporary.push(root);
    await writeFile(join(root, "markup.html"), `<template component="x-markup" status="early" summary="Safe markup.">
      <defs><prop name="body" type="string">Markup.</prop></defs>
      <article $html="$body"></article>
    </template>`);
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["markup.html"], target: "vue", root, outDirectory });
    const component = await readFile(join(outDirectory, "vue", "XMarkup.vue"), "utf8");
    const helper = await readFile(join(outDirectory, "vue", "html.ts"), "utf8");
    compileVue(component, "XMarkup.vue");
    assert.match(component, /from '\.\/html'/);
    assert.match(helper, /from "parse5"/);
    assert.doesNotMatch(helper, /\.setHTML\(/);
    assert.ok(manifest.output.artifacts.some(({ path, kind }) => path === "vue/html.ts" && kind === "helper"));
    assert.deepEqual(manifest.package, {
      dependencies: { parse5: "^8.0.1" },
      peerDependencies: { vue: "^3.5.43" },
    });
  });

  it("emits a typed, wrapperless React sanitizer for element and inline $html", async () => {
    const root = await fixture();
    await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Safe markup."><defs>
      <prop name="body" type="string">Markup.</prop></defs>
      <article><div $html="$body"></div><p>Before <template $html="$body"></template> after</p></article>
    </template>`);
    const outDirectory = join(root, "out-react-html");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["x-card.html"] });
    const component = await readFile(join(outDirectory, "react/XCard.tsx"), "utf8");
    const helper = await readFile(join(outDirectory, "react/html.ts"), "utf8");
    assert.match(component, /from "\.\/html"/);
    assert.match(helper, /from "parse5"/);
    assert.doesNotMatch(helper, /\.setHTML\(/);
    assert.ok(manifest.output.artifacts.some(({ path, kind }) => path === "react/html.ts" && kind === "helper"));
    assert.deepEqual(manifest.package, {
      dependencies: { parse5: "^8.0.1" },
      peerDependencies: { react: "^19.3.0" },
    });
    assert.deepEqual(JSON.parse(await readFile(join(outDirectory, manifest.output.inventory), "utf8")).package,
      manifest.package);
    await typecheckReact(root, manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path)));
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XCard!, { body: "<b title='safe'>One</b><img src=x onerror=alert(1)>" })),
      '<article data-body="&lt;b title=&#x27;safe&#x27;&gt;One&lt;/b&gt;&lt;img src=x onerror=alert(1)&gt;" data-component="x-card"><div><b title="safe">One</b></div><p>Before <b title="safe">One</b> after</p></article>');
  });

  it("projects named React slots through nested generated components and preserves fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-named-slots-"));
    temporary.push(root);
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components/panel.html"), `<template component="x-panel" status="early" summary="Panel.">
      <section><header><slot name="title"><b>Untitled</b></slot></header><main><slot><i>Empty</i></slot></main></section>
      <style>:slotted(h2) { color: rgb(200 20 30); }</style>
    </template>`);
    await writeFile(join(root, "components/app.html"), `<link rel="component" href="./panel.html">
      <template component="x-app" status="early" summary="App."><article>
        <x-panel><h2 slot="title">Title</h2><p>Body</p></x-panel>
        <x-panel></x-panel>
        <x-panel><h2 slot="title" $if="false">Hidden</h2></x-panel>
        <x-panel><template slot="title"><h2>Inert</h2></template></x-panel>
      </article></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    assert.match(css, /data-slotted/);
    const files = manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path));
    const consumer = join(outDirectory, "slot-consumer.tsx");
    await writeFile(consumer, `import React from "react";
import XPanel from "./react/components/XPanel.tsx";
const named = <XPanel slots={{ title: <b>Title</b> }}>Body</XPanel>;
// @ts-expect-error A declared plain slot cannot receive a render function.
const functionSlot = <XPanel slots={{ title: (_props: Record<string, unknown>) => <b>Title</b> }} />;
// @ts-expect-error A static slot contract does not accept an undeclared name.
const undeclared = <XPanel slots={{ other: <b>Other</b> }} />;
void [named, functionSlot, undeclared];`);
    await typecheckReact(root, [...files, consumer]);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XApp!)),
      '<article data-component="x-app"><section data-component="x-panel"><header><h2 slot="title" data-slotted="">Title</h2></header><main><p data-slotted="">Body</p></main></section><section data-component="x-panel"><header><b>Untitled</b></header><main><i>Empty</i></main></section><section data-component="x-panel"><header><b>Untitled</b></header><main><i>Empty</i></main></section><section data-component="x-panel"><header><template slot="title" data-slotted=""><h2>Inert</h2></template></header><main><i>Empty</i></main></section></article>');
  });

  it("renders repeated React scoped slots with outlet props and consumer lexical state", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-scoped-slots-"));
    temporary.push(root);
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components/rows.html"), `<template component="x-rows" status="early" summary="Rows."><defs>
      <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></state>
    </defs><ul><slot name="row" $each="row of $rows" $key="$row.id" from:item="$row" from:index="$loop.index"><li>Missing</li></slot></ul></template>`);
    await writeFile(join(root, "components/app.html"), `<link rel="component" href="./rows.html">
      <template component="x-app" status="early" summary="App."><defs><state type="object" name="item" value="{ name: 'Parent' }"></state>
      <state name="heading" value="Team"></state></defs><main><output $value="$item.name"></output>
      <x-rows><template slot="row"><li><b $value="$item.name"></b><em $value="$heading"></em><small $value="$index"></small></li></template></x-rows>
      <x-rows></x-rows></main></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    const files = manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path));
    const consumer = join(outDirectory, "scoped-slot-consumer.tsx");
    await writeFile(consumer, `import React from "react";
import XRows from "./react/components/XRows.tsx";
const scoped = <XRows slots={{ row: ({ item, index }) => <li>{item.name}{index}</li> }} />;
// @ts-expect-error A declared scoped slot requires a render function.
const staticNode = <XRows slots={{ row: <li>Invalid</li> }} />;
void [scoped, staticNode];`);
    await typecheckReact(root, [...files, consumer]);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XApp!)),
      '<main data-component="x-app"><output>Parent</output><ul data-component="x-rows"><li data-slotted=""><b>Ada</b><em>Team</em><small>0</small></li><li data-slotted=""><b>Bea</b><em>Team</em><small>1</small></li></ul><ul data-component="x-rows"><li>Missing</li><li>Missing</li></ul></main>');
  });

  it("reports the live diagnostic when a React scoped slot has no template carrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-invalid-scoped-slot-"));
    temporary.push(root);
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components/rows.html"), '<template component="x-rows" status="early" summary="Rows."><div><slot name="row" from:item="\'Ada\'"><span>Fallback</span></slot></div></template>');
    await writeFile(join(root, "components/app.html"), '<link rel="component" href="./rows.html"><template component="x-app" status="early" summary="App."><main><x-rows><span slot="row">Invalid</span></x-rows></main></template>');
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.throws(() => renderToStaticMarkup(createElement(module.exports.XApp!)), (error: unknown) => {
      const diagnostic = error as Error & { diagnostic?: { code?: string; message?: string } };
      return diagnostic.name === "HtmlDiagnosticError" && diagnostic.diagnostic?.code === "HR007" &&
        diagnostic.diagnostic.message === 'Scoped slot `row` requires a consumer <template slot="row">.';
    });
  });

  it("selects React scoped slots by a dynamic outlet name", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-dynamic-scoped-slot-"));
    temporary.push(root);
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components/receiver.html"), `<template component="x-receiver" status="early" summary="Receiver.">
      <props><prop name="which" type="string">Outlet name.</prop></props>
      <div from:data-which="$which"><slot from:name="$which" from:item="'Ada'"><span>Fallback</span></slot></div></template>`);
    await writeFile(join(root, "components/app.html"), `<link rel="component" href="./receiver.html">
      <template component="x-app" status="early" summary="App."><main>
      <x-receiver which="row"><template slot="row"><b $value="$item"></b></template></x-receiver>
      <x-receiver which="other"><template slot="row"><b $value="$item"></b></template></x-receiver>
      </main></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    const files = manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path));
    await typecheckReact(root, files);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XApp!)),
      '<main data-component="x-app"><div data-which="row" data-component="x-receiver"><b data-slotted="">Ada</b></div><div data-which="other" data-component="x-receiver"><span>Fallback</span></div></main>');
  });

  it("marks sanitized fragment roots projected through a React slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-html-slot-"));
    temporary.push(root);
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components/panel.html"), `<template component="x-panel" status="early" summary="Panel.">
      <div><slot><i>Fallback</i></slot></div><style>:slotted(b) { color: red; }</style></template>`);
    await writeFile(join(root, "components/app.html"), `<link rel="component" href="./panel.html">
      <template component="x-app" status="early" summary="App."><defs>
      <state name="body" value="&lt;b&gt;&lt;em&gt;Hi&lt;/em&gt;&lt;/b&gt;&lt;span&gt;There&lt;/span&gt;"></state>
      </defs><main><x-panel><template $html="$body"></template></x-panel></main></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    const files = manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path));
    await typecheckReact(root, files);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XApp!)),
      '<main data-component="x-app"><div data-component="x-panel"><b data-slotted=""><em>Hi</em></b><span data-slotted="">There</span></div></main>');
  });

  it("reads React context from the nearest logical provider through projected children", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-react-context-"));
    temporary.push(root);
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components/steps.html"), `<template component="x-steps" status="early" summary="Steps."><defs>
      <prop name="start" type="number" required>Initial step.</prop>
      <state type="number" name="current" value="1"></state>
    </defs><section from:data-start="$start"><slot></slot></section></template>`);
    await writeFile(join(root, "components/step.html"), `<template component="x-step" status="early" summary="Step."><defs>
      <prop name="number" type="number" required>Step number.</prop>
      <context name="current" from="x-steps" as="activeStep"></context>
      <computed name="isActive" from="$activeStep = $number"></computed>
    </defs><p from:data-active="$isActive ? 'yes' : 'no'"><slot></slot></p></template>`);
    await writeFile(join(root, "components/app.html"), `<link rel="component" href="./steps.html"><link rel="component" href="./step.html">
      <template component="x-app" status="early" summary="App."><main><x-steps start="1">
      <x-step from:number="1">Outer one</x-step><x-step from:number="2">Outer two</x-step>
      <x-steps from:start="2"><x-step from:number="1">Inner one</x-step><x-step from:number="2">Inner two</x-step></x-steps>
      </x-steps></main></template>`);
    const outDirectory = join(root, "out");
    const manifest = await convertComponents({ mode: "library", target: "react", root, outDirectory, entries: ["components/**"] });
    const files = manifest.output.artifacts
      .filter((artifact) => artifact.path.endsWith(".tsx") || artifact.path.endsWith(".ts") || artifact.path.endsWith(".d.ts"))
      .map((artifact) => join(outDirectory, artifact.path));
    await typecheckReact(root, files);
    const bundle = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(renderToStaticMarkup(createElement(module.exports.XApp!)),
      '<main data-component="x-app"><section data-start="1" data-component="x-steps"><p data-slotted="" data-active="yes" data-number="1" data-component="x-step">Outer one</p><p data-slotted="" data-active="no" data-number="2" data-component="x-step">Outer two</p><section data-slotted="" data-start="2" data-component="x-steps"><p data-slotted="" data-active="yes" data-number="1" data-component="x-step">Inner one</p><p data-slotted="" data-active="no" data-number="2" data-component="x-step">Inner two</p></section></section></main>');
    assert.throws(() => renderToStaticMarkup(createElement(module.exports.XStep!, { number: 1 })), (error: unknown) => {
      const diagnostic = error as Error & { diagnostic?: { code?: string; message?: string } };
      return diagnostic.name === "HtmlDiagnosticError" && diagnostic.diagnostic?.code === "HR009" &&
        diagnostic.diagnostic.message === '<x-step> requires context `current` from <x-steps>.';
    });
  });

  it("emits a stable public entry for a converted component library", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["x-card.html"], target: "vue", root, outDirectory });
    assert.equal(manifest.graph, "library");
    assert.equal(manifest.output.entry, "vue/index.ts");
    assert.equal(await readFile(join(outDirectory, "vue", "index.ts"), "utf8"), 'export { default as XCard } from "./XCard.vue";\n');
  });

  it("rejects colliding component names before writing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-collision-"));
    temporary.push(root);
    await writeFile(join(root, "x-a1.html"), '<template component="x-a1" status="early" summary="First."><div></div></template>');
    await writeFile(join(root, "x-a-1.html"), '<template component="x-a-1" status="early" summary="Second."><div></div></template>');
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "library", entries: ["x-a1.html", "x-a-1.html"], target: "vue", root, outDirectory }),
      (error) => error instanceof FrameworkOutputCollisionError && error.code === "HTC002" &&
        error.artifact === "vue/XA1.vue" && error.sources.includes("x-a1.html") && error.sources.includes("x-a-1.html"),
    );
    await assert.rejects(() => access(outDirectory));
  });

  it("rejects colliding public names even when source folders keep artifact paths distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-nested-collision-"));
    temporary.push(root);
    await mkdir(join(root, "components", "a"), { recursive: true });
    await mkdir(join(root, "components", "b"), { recursive: true });
    await writeFile(join(root, "components", "a", "first.html"),
      '<template component="x-a1" status="early" summary="First."><div></div></template>');
    await writeFile(join(root, "components", "b", "second.html"),
      '<template component="x-a-1" status="early" summary="Second."><span></span></template>');
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "library", entries: ["components/**"], target: "react", root, outDirectory }),
      (error) => error instanceof FrameworkOutputCollisionError && error.artifact === "react/index.ts",
    );
    await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
  });

  it("retains the source-located graph diagnostic for duplicate component tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-duplicate-tag-"));
    temporary.push(root);
    await writeFile(join(root, "first.html"), '<template component="x-duplicate" status="early" summary="First."><div></div></template>');
    await writeFile(join(root, "second.html"), '<template component="x-duplicate" status="early" summary="Second."><span></span></template>');
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(root, mode);
      await assert.rejects(
        () => convertComponents({ mode, entries: ["first.html", "second.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HL007" &&
          error.diagnostic.source?.endsWith("/second.html") === true,
      );
      await assert.rejects(() => access(outDirectory), { code: "ENOENT" });
    }
  });

  it("guards a 34-component invocation chain but not the permitted 33-component chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-depth-"));
    temporary.push(root);
    for (const count of [33, 34]) {
      const entries: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const entry = `${count}/depth-${index}.html`;
        entries.push(entry);
        if (index === 0) await mkdir(join(root, String(count)));
        await writeFile(join(root, entry), `<template component="x-depth-${index}" status="early" summary="Depth ${index}."><section>${index + 1 < count ? `<x-depth-${index + 1}></x-depth-${index + 1}>` : "Done"}</section></template>`);
      }
      const outDirectory = join(root, `out-${count}`);
      for (const target of ["vue", "react", "svelte"] as const) {
        const targetOutput = join(outDirectory, target);
        const manifest = await convertComponents({ mode: "application", entries, target, root, outDirectory: targetOutput });
        assert.equal(manifest.components.length, count);
        const guarded = await readFile(join(targetOutput, manifest.components.find(({ tag }) => tag === "x-depth-0")!.artifact), "utf8");
        assert.equal(guarded.includes(target === "react" ? "NestedDepthContext" : "html-next:nested-depth"), count === 34);
        assert.equal(manifest.output.artifacts.some((artifact) => artifact.path === "react/depth.ts"), target === "react" && count === 34);
      }
    }
  });

  it("rejects unsupported target versions before loading or writing the graph", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "application", entries: ["missing.html"], target: "vue", targetVersion: "2.7", root, outDirectory }),
      (error) => error instanceof FrameworkTargetVersionError && error.code === "HTC003" && error.supported === "3.5",
    );
    await assert.rejects(() => access(outDirectory));
  });
});
