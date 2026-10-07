import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

class TestElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  readonly childNodes: unknown[] = [];
  readonly isConnected = true;

  constructor(readonly localName: string) {}

  get ownerDocument(): unknown {
    return globalThis.document;
  }

  append(...children: unknown[]): void {
    this.childNodes.push(...children);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

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
        <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="count"></output></button>
    </template>`);
    await writeFile(join(root, "src/label.html"), `<template component="x-label" status="early" summary="Label.">
      <props><prop name="label" type="string" default="Ready">Label.</prop></props>
      <output from:aria-label="label"></output>
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
    assert.match(output, /function manageGeneratedProp(?:s)?/);
  });

  it("resolves every helper a generated module imports through the shared support module", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-support-"));
    temporary.push(root);
    await writeFile(join(root, "once.html"), `<template component="x-once" status="early" summary="Once listener.">
      <defs><state type="number" name="count" value="0"></state><handler name="increment"><set name="count" expr:value="count + 1"></set></handler></defs>
      <button on:keydown.enter.once="increment"><output $value="count"></output></button>
    </template>`);
    await writeFile(join(root, "dispatch.html"), `<template component="x-dispatch" status="early" summary="Declared dispatch.">
      <defs>
        <event name="saved" type="number"></event>
        <state type="number" name="count" value="0"></state>
        <handler name="save"><set name="count" expr:value="count + 1"></set><dispatch event="saved" expr:value="count"></dispatch></handler>
      </defs>
      <button on:click="save">Save</button>
    </template>`);
    await writeFile(join(root, "polymorphic.html"), `<template component="x-polymorphic" status="early" summary="Root match.">
      <defs><prop name="as" type="keyword" values="button, a" default="button">Element.</prop></defs>
      <template $match>
        <a $when="as = 'a'" href="/next"><slot></slot></a>
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
    assert.match(once, /function manageGeneratedLifecycle/);
    // Re-exporting the whole entry still leaves unused helpers and the general runtime out.
    assert.doesNotMatch(once, /function manageGeneratedProps?\b|function manageComponentLifecycle/);
    const dispatch = await bundle("dispatch.html", "createXDispatch");
    assert.match(dispatch, /function dispatchGeneratedEvent/);
    assert.doesNotMatch(dispatch, /function manageComponentLifecycle/);
    const polymorphic = await bundle("polymorphic.html", "createXPolymorphic");
    assert.match(polymorphic, /function componentRootIndex/);
    assert.match(polymorphic, /function manageComponentLifecycle/);
  });

  it("compiles controller components directly with experimentalDirectExtend", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-direct-extend-"));
    temporary.push(root);
    await writeFile(join(root, "list.html"), `<template component="x-list" controller="./list.js" status="early" summary="List.">
      <defs>
        <state name="ready" type="boolean" value="false"></state>
        <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
      </defs>
      <section><ul $if="ready"><li $each="row of rows" $key="row.id" from:data-id="row.id" $value="row.label"></li></ul></section>
    </template>`);
    await writeFile(join(root, "list.js"), `export default (host) => {
      host.on("connect", () => { host.state.ready = true; host.state.rows = [{ id: 1, label: "one" }, { id: 2, label: "two" }]; });
    };`);
    // Arithmetic is not on the direct path yet, so this component still needs the general runtime.
    await writeFile(join(root, "counter.html"), `<template component="x-counter" controller="./list.js" status="early" summary="Counter.">
      <defs><state name="count" type="number" value="1"></state></defs>
      <output $value="count + 1"></output>
    </template>`);
    const aliases = {
      "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname,
      "@nextwebwg/html-next/runtime": new URL("../../html-next/src/runtime.ts", import.meta.url).pathname,
    };
    const bundle = async (entries: string[], experimentalDirectExtend: boolean): Promise<{ text: string; manifest: any }> => {
      const outDir = join(root, `${entries.length}-${experimentalDirectExtend ? "direct" : "runtime"}`);
      await writeFile(join(root, "main.js"), `export { ${entries.map((entry) => `createX${entry[0]!.toUpperCase()}${entry.slice(1, -5)}`).join(", ")} } from ${JSON.stringify(componentsModule)};`);
      await build({
        root,
        logLevel: "silent",
        plugins: [htmlNext.vite({ entries, root, manifestFile: "html-next.manifest.json", experimentalDirectExtend })],
        resolve: { alias: aliases },
        build: { minify: false, outDir, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } },
      });
      return {
        text: await readFile(join(outDir, "app.js"), "utf8"),
        manifest: JSON.parse(await readFile(join(outDir, "html-next.manifest.json"), "utf8")),
      };
    };
    const runtime = await bundle(["list.html"], false);
    const direct = await bundle(["list.html"], true);
    assert.match(runtime.text, /function manageComponentLifecycle/);
    assert.equal(runtime.manifest.directExtend, undefined);
    assert.doesNotMatch(direct.text, /manageComponentLifecycle|function parseTypedValue|function parseExpression/);
    assert.match(direct.text, /function attachGeneratedController/);
    assert.match(direct.text, /class KeyedList\b|KeyedList = class\b/);
    assert.deepEqual(direct.manifest.directExtend, { applied: true, runtimeComponents: [] });
    assertClosedOverEntries(direct.text);

    // One component that still needs the general runtime keeps the whole graph on today's output,
    // so the option never adds the direct helpers next to the runtime.
    const mixedRuntime = await bundle(["list.html", "counter.html"], false);
    const mixedDirect = await bundle(["list.html", "counter.html"], true);
    assert.equal(mixedDirect.text, mixedRuntime.text);
    assert.deepEqual(mixedDirect.manifest.directExtend, { applied: false, runtimeComponents: ["x-counter"] });
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
      plugins: [htmlNext.vite({ entries: ["benchmark-app.html"], root, manifestFile: false, experimentalDirectExtend: true })],
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
    // The js-framework-benchmark entry is 8,051 B gzip-6 (controller included) since the indexed
    // coordinator split, a ceiling later milestones may not raise; ratchet this down whenever it shrinks.
    const gzip = gzipSync(bundle, { level: 6 }).byteLength;
    assert.ok(gzip <= 8_100, `direct benchmark entry is ${gzip} B gzip-6`);
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
    assert.match(output, /function createXChild/);
    assert.match(output, /createXChild\(\)/);
    assert.doesNotMatch(output, /createElement\("x-child"\)/);
    // Only component roots carry a marker, naming their own component.
    assert.match(output, /setAttribute\("data-component", "x-child"\)/);
    assert.doesNotMatch(output, /data-component-root|getAttribute\("data-component"\)/);
    assert.deepEqual(manifest.publicEntries.map(({ tag }) => tag), ["x-app", "x-child"]);
    assert.deepEqual(manifest.components.map(({ tag }) => tag), ["x-app", "x-child"]);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (name: string) => new TestElement(name) },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const child = app.childNodes[0] as TestElement;
      assert.equal(app.localName, "main");
      assert.equal(child.localName, "strong");
      assert.deepEqual(child.childNodes, ["Compiled child"]);
      assert.equal(child.getAttribute("data-component"), "x-child");
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
  });

  it("keeps a read-only reactive parent with a bare child invocation on factory compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-linked-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="count"><output $value="count"></output><x-child></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <strong>Compiled child</strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
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
    assert.match(output, /createXChild\(\)/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (name: string) => new TestElement(name) },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const label = app.childNodes[0] as TestElement & { textContent?: string };
      const child = app.childNodes[1] as TestElement;
      assert.equal(app.getAttribute("data-count"), "1");
      assert.equal(label.textContent, "1");
      assert.equal(child.localName, "strong");
      assert.deepEqual(child.childNodes, ["Compiled child"]);
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
  });

  it("keeps a read-only reactive parent with literal child pass-through attributes on factory compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-literal-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="count"><output $value="count"></output><x-child class="app-child" style="color: red" aria-label="Ready"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <strong class="child" style="font-weight: 700">Compiled child</strong>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
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
    assert.match(output, /createXChild\(\{ attributes:/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);
    assert.doesNotMatch(output, /setAttribute\("aria-label", "Ready"\)/);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (name: string) => new TestElement(name) },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const child = app.childNodes[1] as TestElement;
      assert.equal(child.localName, "strong");
      assert.equal(child.getAttribute("aria-label"), "Ready");
      assert.equal(child.getAttribute("class"), "child app-child");
      assert.equal(child.getAttribute("style"), "font-weight: 700; color: red");
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
  });

  it("keeps a read-only reactive parent with literal child inputs on factory compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-input-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="count"><output $value="count"></output><x-child count="2"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="count" type="number" required>Count.</prop></defs>
      <strong from:data-count="count" $value="count"></strong>
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
    assert.match(output, /createXChild\(\{[^}]*count[^}]*2/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: (name: string) => new TestElement(name),
        defaultView: { MutationObserver: class {
          observe(): void {}
          disconnect(): void {}
        } },
      },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const child = app.childNodes[1] as TestElement;
      assert.equal(child.localName, "strong");
      assert.equal(child.getAttribute("data-count"), "2");
      assert.equal((child as unknown as { textContent: string }).textContent, "2");
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
  });

  it("keeps a read-only reactive parent with static default-slot child content on factory compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-projected-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="count"><output $value="count"></output><x-child><span class="projected">Projected</span></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <p class="child"><slot></slot></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
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
    assert.match(output, /createXChild\(\{ children: \[Array\.from\(element\d+\.childNodes\)\[0\]\] \}\)/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (name: string) => new TestElement(name) },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const child = app.childNodes[1] as TestElement;
      const projected = child.childNodes[0] as TestElement;
      assert.equal(child.localName, "p");
      assert.equal(projected.localName, "span");
      assert.equal(projected.getAttribute("class"), "projected");
      assert.equal(projected.getAttribute("data-slotted"), "");
      assert.deepEqual(projected.childNodes, ["Projected"]);
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
  });

  it("keeps a read-only reactive parent with static named-slot child content on factory compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-named-projected-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="count"><output $value="count"></output><x-child><strong slot="title">Title</strong><span>Body</span></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <article><header><slot name="title"></slot></header><p><slot></slot></p></article>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
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
    assert.match(output, /const element\d+Children = Array\.from\(element\d+\.childNodes\);/);
    assert.match(output, /children: \[element\d+Children\[1\]\]/);
    assert.match(output, /slots: \{ "title": \[element\d+Children\[0\]\] \}/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (name: string) => new TestElement(name) },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const article = app.childNodes[1] as TestElement;
      const header = article.childNodes[0] as TestElement;
      const body = article.childNodes[1] as TestElement;
      assert.equal(article.localName, "article");
      assert.equal((header.childNodes[0] as TestElement).localName, "strong");
      assert.equal((body.childNodes[0] as TestElement).localName, "span");
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
  });

  it("keeps a read-only reactive parent with a literal projected grandchild on factory compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-read-only-projected-grandchild-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <link rel="component" href="./grandchild.html">
      <template component="x-app" status="early" summary="Read-only parent.">
        <defs><state type="number" name="count" value="1"></state></defs>
        <main from:data-count="count"><output $value="count"></output><x-child><x-grandchild title="Grandchild title"></x-grandchild></x-child></main>
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
    assert.match(output, /createXGrandchild\(\{ attributes: \{\s*"title": "Grandchild title"\s*\} \}\)/);
    assert.match(output, /createXChild\(\{ children:/);
    assert.doesNotMatch(output, /@nextwebwg\/html-next\/runtime/);

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (name: string) => new TestElement(name) },
    });
    try {
      const built = await import(`${pathToFileURL(join(root, "dist/app.js")).href}?test=${Date.now()}`) as {
        createXApp(): TestElement;
      };
      const app = built.createXApp();
      const child = app.childNodes[1] as TestElement;
      const grandchild = child.childNodes[0] as TestElement;
      assert.equal(child.localName, "article");
      assert.equal(grandchild.localName, "strong");
      assert.equal(grandchild.getAttribute("title"), "Grandchild title");
      assert.deepEqual(grandchild.childNodes, ["Grandchild"]);
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", priorDocument);
    }
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
      plugins: [htmlNext.vite({ entries: ["app.html"], root, mode: "application" })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /HN008: Stable public component modules are available only in library mode/);
  });

  it("lets the general runtime render the components its template invokes", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-runtime-parent-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App.">
        <defs><state type="number" name="count" value="0"></state></defs>
        <main><output $value="count + 1"></output><x-child from:label="count"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="label" type="string" default="none">Label.</prop></defs>
      <p $value="label"></p><style>p { color: rebeccapurple; }</style></template>`);
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

    // The runtime renders x-app's template, so the invocation stays in it: the build registers the
    // child's definition and includes its module, rather than compiling a factory call.
    const output = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(output, /registerComponentDefinitions/);
    assert.match(output, /registerRenderedComponents\(element\.ownerDocument\)/);
    assert.match(output, /"tag":\s*"x-child"/);
    assert.doesNotMatch(output, /createXChild\(\)/);
    assertClosedOverEntries(output);
    // The registered copy carries no styles, so the child's stylesheet has to reach the build.
    assert.match(output, /"css":\s*""/);
    const css = await readFile(join(root, "dist/components.css"), "utf8");
    assert.match(css, /rebeccapurple/);
    assert.match(css, /@scope\s*\(\[data-component~="x-child"\]\)/);
  });

  it("rejects dynamic linked invocation inputs until they can preserve the full child contract", async () => {
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

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HN009:.*cannot yet carry dynamic or unsupported attributes, projected children/);
  });

  it("rejects literal props that collide with factory option names", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-reserved-prop-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App."><x-child attributes="Ready"></x-child></template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="attributes" type="string" required>Attributes.</prop></defs>
      <p $value="attributes"></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HN009:.*cannot yet carry dynamic or unsupported attributes, projected children/);
  });

  it("rejects empty compiled invocations of entries with required props", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-required-child-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App."><x-child></x-child></template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="label" type="string" required>Label.</prop></defs>
      <p $value="label"></p>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HN014:.*requires an input/);
  });

  it("rejects a values constraint that does not conform to its declared type", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-values-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app"><defs>
      <prop name="size" type="keyword" values="sm, two words">Size.</prop>
      </defs><output from:data-size="size"></output></template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["app.html"], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"], cssFileName: "components" } },
    }), /app\.html: HC013:.*values constraint.*does not conform/);
  });

  it("rejects a range constraint whose bound does not match the prop type", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-range-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<template component="x-app"><defs>
      <prop name="age" type="integer" min="soon">Age.</prop>
      </defs><output from:data-age="age"></output></template>`);
    await writeFile(join(root, "main.js"), `export { createXApp } from ${JSON.stringify(componentsModule)};`);

    await assert.rejects(() => build({
      root,
      logLevel: "silent",
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
    assert.match(output, /createElement\("x-runtime-card"\)/);
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
