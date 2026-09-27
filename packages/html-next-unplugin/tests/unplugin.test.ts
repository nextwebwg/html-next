import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";
import { build } from "vite";

import {
  componentModule,
  componentsModule,
  htmlNext,
  supportModule,
} from "../src/index.js";

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
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HTML Next unplugin", () => {
  it("builds a closed component graph with one shared support import and an inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="count"></output></button>
    </template>`);
    await writeFile(join(root, "src/label.html"), `<template component="x-label" status="early" summary="Label.">
      <props><prop name="label" type="string" default="Ready">Label.</prop></props>
      <output :aria-label="label"></output>
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

  it("turns linked component invocations into compiled factory calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-linked-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App.">
        <main><x-child></x-child></main>
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
    assert.deepEqual(manifest.publicEntries.map(({ tag }) => tag), ["x-app"]);
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
        <defs><state name="count" :value="1"></state></defs>
        <main :data-count="count"><output $value="count"></output><x-child></x-child></main>
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
        <defs><state name="count" :value="1"></state></defs>
        <main :data-count="count"><output $value="count"></output><x-child class="app-child" style="color: red" aria-label="Ready"></x-child></main>
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
        <defs><state name="count" :value="1"></state></defs>
        <main :data-count="count"><output $value="count"></output><x-child count="2"></x-child></main>
      </template>`);
    await writeFile(join(root, "child.html"), `<template component="x-child" status="early" summary="Child.">
      <defs><prop name="count" type="number" required>Count.</prop></defs>
      <strong :data-count="count" $value="count"></strong>
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
        <defs><state name="count" :value="1"></state></defs>
        <main :data-count="count"><output $value="count"></output><x-child><span class="projected">Projected</span></x-child></main>
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
        <defs><state name="count" :value="1"></state></defs>
        <main :data-count="count"><output $value="count"></output><x-child><strong slot="title">Title</strong><span>Body</span></x-child></main>
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
        <defs><state name="count" :value="1"></state></defs>
        <main :data-count="count"><output $value="count"></output><x-child><x-grandchild title="Grandchild title"></x-grandchild></x-child></main>
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

  it("exposes independently consumable public component modules in library mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-library-"));
    temporary.push(root);
    await writeFile(join(root, "alpha.html"), `<template component="x-alpha" status="early" summary="Alpha.">
      <p>Alpha public entry</p>
    </template>`);
    await writeFile(join(root, "beta.html"), `<template component="x-beta" status="early" summary="Beta.">
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
        entries: ["alpha.html", "beta.html"],
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
        <defs><state name="count" :value="0"></state></defs>
        <main><output $value="count + 1"></output><x-child :label="count"></x-child></main>
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
    // The registered copy carries no styles, so the child's stylesheet has to reach the build.
    assert.match(output, /"css":\s*""/);
    const css = await readFile(join(root, "dist/components.css"), "utf8");
    assert.match(css, /rebeccapurple/);
  });

  it("rejects dynamic linked invocation inputs until they can preserve the full child contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-invocation-inputs-"));
    temporary.push(root);
    await writeFile(join(root, "app.html"), `<link rel="component" href="./child.html">
      <template component="x-app" status="early" summary="App.">
        <main><x-child :label="'Ready'"><span>Projected</span></x-child></main>
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
