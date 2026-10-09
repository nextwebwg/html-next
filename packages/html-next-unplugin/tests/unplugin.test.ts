import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it } from "vitest";
import { build } from "vite";

import {
  componentModule,
  componentsModule,
  htmlNext,
  supportModule,
} from "../src/index.js";

import { installSourcePackage } from "./source-package.js";

const temporary: string[] = [];
/** Generated modules resolve the helpers from source, never from a stale local build. */
const generatedRuntimeAlias = { "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname };

// A build is compiled for its entries. Only the live browser runtime watches the document for
// component links and later definitions, so none of that machinery may reach a build.
function assertClosedOverEntries(output: string): void {
  assert.doesNotMatch(output, /link\[rel="component"\]/);
  assert.doesNotMatch(output, /function (?:observeDocument|startBrowserComponents|loadBrowserComponents)\b/);
  assert.doesNotMatch(output, /\.rescan\b|\bonAdded\b/);
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HTML Next unplugin", () => {
  it("resolves shared CSS through Vite, emits one compatible body in graph order, and builds stylesheet-relative assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-shared-css-"));
    temporary.push(root);
    await mkdir(join(root, "styles"));
    const stylePackage = join(root, "node_modules/shared-defaults");
    await mkdir(stylePackage, { recursive: true });
    await writeFile(join(stylePackage, "package.json"), JSON.stringify({ name: "shared-defaults", exports: {
      ".": { style: { production: "./production.css", development: "./development.css" }, default: "./fallback.css" },
    } }));
    await writeFile(join(stylePackage, "production.css"), ':host { font-weight: 700; }');
    await writeFile(join(stylePackage, "development.css"), ':host { font-weight: 400; }');
    await writeFile(join(stylePackage, "fallback.css"), ':host { font-weight: 900; }');
    await writeFile(join(root, "styles/defaults.css"), '@namespace svg "http://www.w3.org/2000/svg"; svg|rect { fill: rebeccapurple; } :host, *, *::before, *::after { box-sizing: border-box; } .icon { background: url("./check.svg"); }');
    await writeFile(join(root, "styles/check.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
    await writeFile(join(root, "a.html"), '<template component="x-a"><div></div><style>@import "@styles/defaults.css?baseline=1"; @import "shared-defaults"; :host { box-sizing: content-box; }</style></template>');
    await writeFile(join(root, "b.html"), '<template component="x-b"><section></section><style>@import "@styles/defaults.css?baseline=1"; @import "shared-defaults";</style></template>');
    await writeFile(join(root, "main.js"), `export { createXA, createXB } from ${JSON.stringify(componentsModule)};`);
    let isProduction = false;
    await build({ root, configFile: false, logLevel: "silent", plugins: [
      { name: "capture-css-environment", configResolved(config) { isProduction = config.isProduction; } },
      htmlNext.vite({ entries: ["b.html", "a.html"] }),
    ],
      resolve: { alias: { ...generatedRuntimeAlias, "@styles": join(root, "styles") } },
      build: { minify: false, cssMinify: false, lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } } });
    const css = await readFile(join(root, "dist/components.css"), "utf8");
    assert.equal(css.match(/@namespace/g)?.length, 1);
    assert.ok(css.indexOf("@namespace") < css.indexOf("@scope"));
    assert.match(css, /htmlnextns[0-9a-f]+\|rect/);
    assert.equal(css.match(/box-sizing: border-box/g)?.length, 1);
    assert.match(css, /@scope\s*\(\[data-component~="x-a"\], \[data-component~="x-b"\]\)/);
    assert.ok(css.indexOf("border-box") < css.indexOf("content-box"));
    assert.match(css, /data:image\/svg\+xml/);
    assert.equal(css.match(new RegExp(`font-weight: ${isProduction ? 700 : 400}`, "g"))?.length, 1, css);
    assert.doesNotMatch(css, /font-weight: 900/);
    assert.doesNotMatch(css, /@import|@styles|file:\/\/|\/@fs\//);
  });

  it("consumes a packed component folder with native factories and no configured entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-native-package-"));
    temporary.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "consumer", type: "module", dependencies: { "@example/controls": "1.0.0" } }));
    await installSourcePackage(root, {
      "components/button.html": '<template component="ui-button" status="early" summary="Button."><button>Save</button><style>:host { color: rebeccapurple; }</style></template>',
      "components/nested/card.html": '<template component="ui-card" status="early" summary="Card."><section>Nested card</section></template>',
      "components/unused.html": '<template component="ui-unused" status="early" summary="Unused."><aside>UNUSED_COMPONENT_MARKER</aside></template>',
    });
    await writeFile(join(root, "main.js"), `export { createUiButton } from "@example/controls";
      export { createUiCard } from "@example/controls/nested";`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext.vite()],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname } },
      build: { minify: false, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } } });
    const output = await readFile(join(root, "dist", "app.js"), "utf8");
    assert.match(output, /createUiButton/);
    assert.match(output, /createUiCard/);
    assert.doesNotMatch(output, /UNUSED_COMPONENT_MARKER|parse5|source-parser|browser-source/);
    assertClosedOverEntries(output);
    const css = await readFile(join(root, "dist", "components.css"), "utf8");
    assert.match(css, /data-component/);
    assert.match(css, /rebeccapurple/);
    assert.doesNotMatch(css, /:host/);
  });

  it("builds a closed component graph with one shared support import and an inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="$count"></output></button>
    </template>`);
    await writeFile(join(root, "src/label.html"), `<template component="x-label" status="early" summary="Label.">
      <props><prop name="label" type="string" default="Ready">Label.</prop></props>
      <output from:aria-label="$label"></output>
    </template>`);
    await writeFile(join(root, "src/main.js"), `
      import { createXCounter, createXLabel } from ${JSON.stringify(componentsModule)};
      export { createXCounter, createXLabel };
    `);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["src/counter.html", "src/label.html"], root })],
      resolve: {
        alias: {
          "@nextwebwg/html-next/generated-runtime": new URL(
            "../../html-next/src/generated-runtime.ts",
            import.meta.url,
          ).pathname,
        },
      },
      build: {
        minify: false,
        lib: {
          entry: join(root, "src/main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    const manifest = JSON.parse(await readFile(join(root, "dist/html-next.manifest.json"), "utf8")) as {
      mode: string;
      delivery: string;
      capabilities: string[];
      supportImports: string[];
      support: { module: string; imports: string[]; capabilities: string[] };
      publicEntries: Array<{ tag: string; module: string }>;
      components: Array<{ tag: string }>;
    };
    assert.doesNotMatch(output, /parse5|source-parser|browser-source/);
    assertClosedOverEntries(output);
    assert.equal((output.match(/function createXCounter/g) ?? []).length, 1);
    assert.equal((output.match(/function createXLabel/g) ?? []).length, 1);
    assert.equal(manifest.mode, "native-application-or-library-build");
    assert.deepEqual(manifest.components.map(({ tag }) => tag), ["x-counter", "x-label"]);
    assert.deepEqual(manifest.publicEntries.map(({ tag }) => tag), ["x-counter", "x-label"]);
    assert.deepEqual(manifest.publicEntries.map(({ module }) => module), [componentsModule, componentsModule]);
    assert.equal(manifest.delivery, "application");
    assert.ok(manifest.capabilities.includes("state"));
    assert.deepEqual(manifest.supportImports, ["@nextwebwg/html-next/generated-runtime"]);
    assert.deepEqual(manifest.support, {
      module: supportModule,
      imports: ["@nextwebwg/html-next/generated-runtime"],
      capabilities: manifest.capabilities,
    });
    assert.match(output, /function acceptProps/);
  });

  it("resolves every helper a generated module imports through the shared support module", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-support-"));
    temporary.push(root);
    await writeFile(join(root, "once.html"), `<template component="x-once" status="early" summary="Once listener.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
      <button on:keydown.enter.once="increment"><output $value="$count"></output></button>
    </template>`);
    await writeFile(join(root, "dispatch.html"), `<template component="x-dispatch" status="early" summary="Declared dispatch.">
      <defs>
        <event name="saved" type="number"></event>
        <state type="number" name="count" value="0"></state>
        <handler name="save"><set name="count" expr:value="$count + 1"></set><dispatch event="saved" expr:value="$count"></dispatch></handler>
      </defs>
      <button on:click="save">Save</button>
    </template>`);
    await writeFile(join(root, "polymorphic.html"), `<template component="x-polymorphic" status="early" summary="Root match.">
      <defs><prop name="as" type="keyword" values="button, a" default="button">Element.</prop></defs>
      <template $match>
        <a $when="$as = 'a'" href="/next"><slot></slot></a>
        <button $else type="button"><slot></slot></button>
      </template>
    </template>`);
    const aliases = {
      "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname,
      "@nextwebwg/html-next/runtime": new URL("../../html-next/src/runtime.ts", import.meta.url).pathname,
    };
    const bundle = async (entry: string, factory: string): Promise<string> => {
      const directory = join(root, entry.replace(".html", ""));
      await mkdir(directory);
      await writeFile(join(directory, "main.js"), `export { ${factory} } from ${JSON.stringify(componentsModule)};`);
      await build({
        root,
        logLevel: "silent",
        plugins: [htmlNext.vite({ entries: [entry], root, manifestFile: false })],
        resolve: { alias: aliases },
        build: {
          minify: false,
          outDir: join(directory, "dist"),
          lib: { entry: join(directory, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" },
        },
      });
      return readFile(join(directory, "dist/app.js"), "utf8");
    };

    const once = await bundle("once.html", "createXOnce");
    assert.match(once, /function manageIndexedLifecycle/);
    // Re-exporting the whole entry still leaves unused helpers and the general runtime out.
    assert.doesNotMatch(once, /function acceptProps\b|function manageComponentLifecycle/);
    const dispatch = await bundle("dispatch.html", "createXDispatch");
    assert.match(dispatch, /function dispatchDeclared/);
    assert.doesNotMatch(dispatch, /function manageComponentLifecycle/);
    // A root `$match` compiles directly too: its root switch, without the general runtime.
    const polymorphic = await bundle("polymorphic.html", "createXPolymorphic");
    assert.match(polymorphic, /function replaceRoot/);
    assert.doesNotMatch(polymorphic, /function manageComponentLifecycle|function componentRootIndex/);
  });

  it("compiles controller components directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-direct-extend-"));
    temporary.push(root);
    await writeFile(join(root, "list.html"), `<template component="x-list" controller="./list.js" status="early" summary="List.">
      <defs>
        <state name="ready" type="boolean" value="false"></state>
        <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      </defs>
      <section><ul $if="$ready"><li $each="row of $rows" $key="$row.id" from:data-id="$row.id" $value="$row.label"></li></ul></section>
    </template>`);
    await writeFile(join(root, "list.js"), `export default (host) => {
      host.on("connect", () => { host.state.ready = true; host.state.rows = [{ id: 1, label: "one" }, { id: 2, label: "two" }]; });
    };`);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" controller="./list.js" status="early" summary="Counter.">
      <defs><state name="count" type="number" value="1"></state></defs>
      <output $value="$count + 1"></output>
    </template>`);
    const aliases = {
      "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname,
      "@nextwebwg/html-next/runtime": new URL("../../html-next/src/runtime.ts", import.meta.url).pathname,
    };
    const bundle = async (entries: string[]): Promise<{ text: string; manifest: any }> => {
      const outDir = join(root, `out-${entries.length}`);
      await writeFile(join(root, "main.js"), `export { ${entries.map((entry) => `createX${entry[0]!.toUpperCase()}${entry.slice(1, -5)}`).join(", ")} } from ${JSON.stringify(componentsModule)};`);
      await build({
        root,
        logLevel: "silent",
        plugins: [htmlNext.vite({ entries, root, manifestFile: "html-next.manifest.json" })],
        resolve: { alias: aliases },
        build: { minify: false, outDir, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } },
      });
      return {
        text: await readFile(join(outDir, "app.js"), "utf8"),
        manifest: JSON.parse(await readFile(join(outDir, "html-next.manifest.json"), "utf8")),
      };
    };
    // Every component compiles directly; nothing in the graph pulls in the general runtime.
    for (const entries of [["list.html"], ["list.html", "counter.html"]]) {
      const { text, manifest } = await bundle(entries);
      assert.doesNotMatch(text, /manageComponentLifecycle|function parseTypedValue|function parseExpression/);
      assert.match(text, /function attachGeneratedController/);
      assert.match(text, /class KeyedList\b|KeyedList = class\b/);
      assert.equal(manifest.directExtend, undefined);
      assertClosedOverEntries(text);
    }
  });

  it("keeps the direct benchmark entry within its gzip ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-ceiling-"));
    temporary.push(root);
    const fixtures = new URL("../../html-next/tests/fixtures/direct-extend/", import.meta.url);
    await writeFile(join(root, "benchmark-app.html"), await readFile(new URL("benchmark-app.html", fixtures)));
    await writeFile(join(root, "controller.js"), await readFile(new URL("benchmark-controller.js", fixtures)));
    await writeFile(join(root, "main.js"), `import { createBenchmarkApp } from ${JSON.stringify(componentsModule)};\ndocument.body.append(createBenchmarkApp());\n`);
    await writeFile(join(root, "index.html"), '<!doctype html>\n<script type="module" src="./main.js"></script>\n');
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["benchmark-app.html"], root, manifestFile: false })],
      resolve: { alias: {
        "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname,
        "@nextwebwg/html-next/runtime": new URL("../../html-next/src/runtime.ts", import.meta.url).pathname,
      } },
      build: { outDir: join(root, "dist"), modulePreload: { polyfill: false } },
    });
    const scripts = (await readdir(join(root, "dist/assets"))).filter((name) => name.endsWith(".js"));
    assert.equal(scripts.length, 1);
    const bundle = await readFile(join(root, "dist/assets", scripts[0]!));
    assert.doesNotMatch(bundle.toString("utf8"), /html-next:item-start|function parseTypedValue/);
    // The js-framework-benchmark entry is 8,620 B gzip-6 (controller included). Default-on direct
    // output added what every direct component may need: the compiled-root handle, declared
    // dispatch, computeds, SVG prototypes, row disposal and positions, unchecked control writes, the live scheduler's
    // priority order (owner-approved, 2026-10-07), more than 29 state roots, the host's prop channel, a
    // host root that follows a root switch, and list node methods that also serve rows of several nodes.
    // +15 B: the reconcile records the rows it kept in place, so lists whose rows read their position
    // visit only the rows that moved. +4 B: the compiled-root handle exposes its pending change
    // bits, so a transitions hold also sees writes below a root. Ratchet this down whenever it shrinks.
    const gzip = gzipSync(bundle, { level: 6 }).byteLength;
    assert.ok(gzip <= 8_644, `direct benchmark entry is ${gzip} B gzip-6`);
  });

  it("turns sibling component invocations from one resource into compiled factory calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-linked-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `
      <template component="x-app" status="early" summary="App.">
        <main><x-child></x-child></main>
      </template>
      <template component="x-child" status="early" summary="Child.">
      <strong>Compiled child</strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: generatedRuntimeAlias },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    const manifest = JSON.parse(await readFile(join(root, "dist/html-next.manifest.json"), "utf8")) as {
      publicEntries: Array<{ tag: string }>;
      components: Array<{ tag: string }>;
    };
    // x-app creates x-child through x-child's factory (tests/vanilla-blocks.test.ts holds the DOM to live's).
    assert.match(output, /function createXChild\b/);
    assert.match(output, /invoke\(I, createXChild\b/);
    assert.doesNotMatch(output, /createElement\("x-child"\)|function manageComponentLifecycle/);
    // Only component roots carry a marker, naming their own component.
    assert.match(output, /setAttribute\("data-component", "x-child"\)/);
    assert.doesNotMatch(output, /data-component-root|getAttribute\("data-component"\)/);
    assert.deepEqual(manifest.publicEntries.map(({ tag }) => tag), ["x-app", "x-child"]);
    assert.deepEqual(manifest.components.map(({ tag }) => tag), ["x-app", "x-child"]);

  });

  it("compiles a read-only reactive parent with a bare child invocation through the child's factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-linked-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="$count"><output $value="$count"></output><x-child></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <strong>Compiled child</strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: generatedRuntimeAlias },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(output, /invoke\(I, createXChild\b/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

  });

  it("compiles a read-only reactive parent with literal child pass-through attributes through the child's factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-literal-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="$count"><output $value="$count"></output><x-child class="app-child" style="color: red" aria-label="Ready"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <strong class="child" style="font-weight: 700">Compiled child</strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: generatedRuntimeAlias },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    // Literal attributes that are not props reach the child's root as an invocation's.
    assert.match(output, /attributes: \{\s*"class": "app-child",\s*"style": "color: red",\s*"aria-label": "Ready"\s*\}/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

  });

  it("compiles a read-only reactive parent with literal child inputs through the child's factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-input-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="$count"><output $value="$count"></output><x-child count="2"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="count" type="number" required>Count.</prop></defs>
      <strong from:data-count="$count" $value="$count"></strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: {
        alias: {
          "@nextwebwg/html-next/generated-runtime": new URL(
            "../../html-next/src/generated-runtime.ts",
            import.meta.url,
          ).pathname,
        },
      },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    // A literal prop is the child's HTML input, as an invocation attribute is to live lowering.
    assert.match(output, /invoke\(I, createXChild,[^;]*"count": "2"/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

  });

  it("compiles a read-only reactive parent with static default-slot child content through the child's factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-projected-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="$count"><output $value="$count"></output><x-child><span class="projected">Projected</span></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <p class="child"><slot></slot></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: generatedRuntimeAlias },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    // The parent's content is projected into the child's slots.
    assert.match(output, /\.\.\.projected\(j\.n\)/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

  });

  it("compiles a read-only reactive parent with static named-slot child content through the child's factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-named-projected-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="$count"><output $value="$count"></output><x-child><strong slot="title">Title</strong><span>Body</span></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <article><header><slot name="title"></slot></header><p><slot></slot></p></article>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: generatedRuntimeAlias },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(output, /\.\.\.projected\(j\.n\)/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

  });

  it("compiles a read-only reactive parent with a literal projected grandchild through the child's factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-projected-grandchild-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <link rel="component" href="./grandchild.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="$count"><output $value="$count"></output><x-child><x-grandchild title="Grandchild title"></x-grandchild></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <article><slot></slot></article>
    </template>`);
    await writeFile(join(root, "grandchild.html"), `<template component="x-grandchild" status="early" summary="Grandchild.">
      <strong>Grandchild</strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: generatedRuntimeAlias },
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(output, /invoke\(I, createXGrandchild, [^,]+, \{ attributes: \{ "title": "Grandchild title" \}/);
    assert.match(output, /invoke\(I, createXChild\b/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

  });

  it("exposes independently consumable components from one HTML resource in library mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-library-"));
    temporary.push(root);
    await writeFile(join(root, "library.html"), `<template component="x-alpha" status="early" summary="Alpha.">
      <p>Alpha public entry</p>
    </template>
    <template component="x-beta" status="early" summary="Beta.">
      <p>Beta public entry</p>
    </template>`);
    await writeFile(
      join(root, "main.js"),
      `export { createXAlpha } from ${JSON.stringify(componentModule("x-alpha"))};`,
    );

    await build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({
        entries: ["library.html"],
        root,
        mode: "library",
      })],
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "alpha.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/alpha.js"), "utf8");
    const manifest = JSON.parse(await readFile(join(root, "dist/html-next.manifest.json"), "utf8")) as {
      delivery: string;
      publicEntries: Array<{ tag: string; module: string }>;
    };
    assert.match(output, /Alpha public entry/);
    assert.doesNotMatch(output, /Beta public entry/);
    assert.equal(manifest.delivery, "library");
    assert.deepEqual(manifest.publicEntries.map(({ tag, module }) => ({ tag, module })), [
      { tag: "x-alpha", module: componentModule("x-alpha") },
      { tag: "x-beta", module: componentModule("x-beta") },
    ]);
  });

  it("keeps stable public component modules exclusive to library mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-application-contract-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app" status="early" summary="App.">
      <main>Application</main>
    </template>`);
    await writeFile(
      join(root, "main.js"),
      `export { createXApp } from ${JSON.stringify(componentModule("x-app"))};`,
    );

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /HN008: Stable public component modules are available only in library mode/);
  });

  it("compiles the components a template invokes into calls of their factories", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-runtime-parent-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App.">
        <defs><state type="number" name="count" value="0"></state></defs>
        <main><output $value="$count + 1"></output><x-child from:label="$count"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="label" type="string" default="none">Label.</prop></defs>
      <p $value="$label"></p><style>p { color: rebeccapurple; }</style></template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      resolve: {
        alias: {
          "@nextwebwg/html-next/generated-runtime": new URL(
            "../../html-next/src/generated-runtime.ts",
            import.meta.url,
          ).pathname,
          "@nextwebwg/html-next/runtime": new URL("../../html-next/src/runtime.ts", import.meta.url).pathname,
        },
      },
      build: {
        minify: false,
        lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" },
      },
    });

    // x-app compiles directly and creates x-child through its factory: nothing is registered and
    // the general runtime stays out. The child's stylesheet still reaches the build.
    const output = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(output, /invoke\(I, createXChild\b/);
    assert.doesNotMatch(output, /registerComponentDefinitions|function manageComponentLifecycle/);
    assertClosedOverEntries(output);
    const css = await readFile(join(root, "dist/components.css"), "utf8");
    assert.match(css, /rebeccapurple/);
    assert.match(css, /@scope\s*\(\[data-component~="x-child"\]\)/);
  });

  it("compiles dynamic linked invocation inputs and projected children", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-invocation-inputs-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App.">
        <main><x-child from:label="'Ready'"><span>Projected</span></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <p><slot></slot></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname } },
      build: { minify: false, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } },
    });
    // `label` is not one of x-child's props, so it is an attribute the parent keeps writing on its root.
    assert.match(await readFile(join(root, "dist/app.js"), "utf8"), /invoke\(I, createXChild\b[\s\S]*writeAttribute\(r\.a\d+, "label"/);
  });

  it("carries a literal prop named like a factory option as HTML input", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-reserved-prop-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App."><main><x-child attributes="Ready"></x-child></main></template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="attributes" type="string" required>Attributes.</prop></defs>
      <p $value="$attributes"></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname } },
      build: { minify: false, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } },
    });
    // HTML input never meets the factory's own `attributes` option.
    assert.match(await readFile(join(root, "dist/app.js"), "utf8"), /invoke\(I, createXChild,[^;]*"attributes": "Ready"/);
  });

  it("renders an invocation without a required prop, whose validity reports it as live does", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-required-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App."><main><x-child></x-child></main></template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="label" type="string" required>Label.</prop></defs>
      <p $value="$label"></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname } },
      build: { minify: false, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } },
    });
    assert.match(await readFile(join(root, "dist/app.js"), "utf8"), /invoke\(I, createXChild\b/);
  });

  it("rejects a values constraint that does not conform to its declared type", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-values-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app"><defs>
      <prop name="size" type="keyword" values="sm, two words">Size.</prop>
      </defs><output from:data-size="$size"></output></template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HC013:.*values constraint.*does not conform/);
  });

  it("rejects a range constraint whose bound does not match the prop type", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-range-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app"><defs>
      <prop name="age" type="integer" min="soon">Age.</prop>
      </defs><output from:data-age="$age"></output></template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HC013:.*min constraint.*does not conform/);
  });

  it("rejects cycles in compiled component invocations", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-invocation-cycle-"));
    temporary.push(root);
    await writeFile(join(root, "alpha.html"), `<link rel="component" href="./beta.html">
      <template component="x-alpha" status="early" summary="Alpha."><x-beta></x-beta></template>`);
    await writeFile(join(root, "beta.html"), `<link rel="component" href="./alpha.html">
      <template component="x-beta" status="early" summary="Beta."><x-alpha></x-alpha></template>`);
    await writeFile(join(root, "main.js"), `export { createXAlpha } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({ entries: ["alpha.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /HN002: Compiled component invocations form a cycle/);
  });

  it("diagnoses undeclared dynamic component boundaries before emission", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-dynamic-error-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app" status="early" summary="App.">
      <main><x-runtime-card></x-runtime-card></main>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HN001:.*x-runtime-card.*dynamic boundary/);
  });

  it("preserves explicitly external custom elements as dynamic boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-dynamic-external-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app" status="early" summary="App.">
      <main><x-runtime-card></x-runtime-card></main>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({
        entries: ["app.html"],
        root,
        dynamicBoundaries: [{ tag: "x-runtime-card", strategy: "external-custom-element" }],
      })],
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    const manifest = JSON.parse(await readFile(join(root, "dist/html-next.manifest.json"), "utf8")) as {
      dynamicBoundaries: Array<{ tag: string; strategy: string; usedBy: string[] }>;
    };
    // The external element stays in the cloned template, for its own definition to upgrade.
    assert.match(output, /\["x-runtime-card",/);
    assert.deepEqual(manifest.dynamicBoundaries, [{
      tag: "x-runtime-card",
      strategy: "external-custom-element",
      usedBy: ["app.html"],
    }]);
  });

  it("rejects an application build without graph entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-empty-"));
    temporary.push(root);
    await writeFile(join(root, "main.js"), `import ${JSON.stringify(componentsModule)};`);
    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [htmlNext.vite({ entries: [], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"] } },
    }), /at least one component entry/);
  });

  it("recompiles changed transitive component sources on a subsequent Vite build", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-rebuild-"));
    temporary.push(root);
    const component = join(root, "child.html");
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App."><x-child></x-child></template>`);
    await writeFile(component, `<template component="x-child" status="early" summary="Child.">
      <output>First</output>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);
    const plugin = htmlNext.vite({ entries: ["app.html"], root });
    const buildApp = () => build({
      root,
      logLevel: "silent",
      resolve: { alias: generatedRuntimeAlias },
      plugins: [plugin],
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    await buildApp();
    assert.match(await readFile(join(root, "dist/app.js"), "utf8"), /First/);
    await writeFile(component, `<template component="x-child" status="early" summary="Child.">
      <output>Second</output>
    </template>`);
    await buildApp();
    const rebuilt = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(rebuilt, /Second/);
    assert.doesNotMatch(rebuilt, /First/);
  });
});
