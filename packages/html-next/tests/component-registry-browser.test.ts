import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type Browser } from "playwright";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

/**
 * componentRegistry (https://nextwebwg.org/declarative-components/javascript#component-registry) in
 * Chromium, Firefox and WebKit: the live runtime with no bundler and a compiled Vanilla module, each
 * its own bundle, create and update each other's components through one registry for the document.
 */
const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const source = fileURLToPath(new URL("../src/", import.meta.url));

const callout = `<template component="ui-callout" controller="./callout.js">
  <props><prop name="tone" type="keyword" values="info, tip, warning" default="info">Tone.</prop></props>
  <aside from:data-tone="$tone"><h2><slot name="heading"></slot></h2><p><slot></slot></p></aside>
</template>`;
const badge = `<template component="ui-badge">
  <defs><prop name="label" type="string" default="New">Label.</prop></defs>
  <strong>{$label}</strong>
</template>`;

// A scoped slot that owns iteration, and a plain slot with a fallback.
const list = `<template component="x-list">
  <defs><prop name="rows" type="list(string)" default="['a', 'b']">Rows.</prop>
    <slot name="row"><prop name="item" type="string" required>The row.</prop></slot></defs>
  <ul><li $each="row of $rows"><slot name="row" from:item="$row"></slot></li><li><slot name="plain">fallback</slot></li></ul>
</template>`;

describe.skipIf(!enabled)("componentRegistry across bundles", () => {
  const files: Record<string, string> = {};

  beforeAll(async () => {
    const bundle = async (contents: string): Promise<string> => (await build({
      stdin: { contents, loader: "js", resolveDir: source },
      bundle: true, format: "esm", write: false, platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts` },
      plugins: [{ name: "styles", setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
        builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
      } }],
    })).outputFiles[0]!.text;
    // The live delivery as a page loads it: one module, no bundler.
    files["/browser.js"] = await bundle(`export * from "./browser.ts";`);
    const compiled = generateComponent(parseComponent(badge, "https://registry.example/badge.html")).find((artifact) => artifact.path.endsWith(".js"))!.content;
    files["/compiled.js"] = await bundle(`${compiled}\nexport { componentRegistry } from "@nextwebwg/html-next/generated-runtime";`);
    files["/callout.js"] = 'export default (host) => { host.root.dataset.controller = "ran"; };';
    files["/callout.html"] = callout;
    // The same list, live as x-list and compiled as x-clist, each its own bundle.
    files["/list.html"] = list;
    const compiledList = generateComponent(parseComponent(list.replace("x-list", "x-clist"), "https://registry.example/clist.html")).find((artifact) => artifact.path.endsWith(".js"))!.content;
    files["/clist.js"] = await bundle(`${compiledList}\nexport { componentRegistry } from "@nextwebwg/html-next/generated-runtime";`);
    const listScript = `<script type="module">
      import { componentRegistry } from "/clist.js";
      const live = location.pathname === "/lists.html" ? await import("/browser.js") : undefined;
      await live?.ready;
      window.registry = componentRegistry;
    </script>`;
    files["/lists.html"] = `<!doctype html><head><link rel="component" href="/list.html"></head><body><main></main>
      <x-list id="authored"><template slot="row"><b>{$item}</b></template><template slot="plain"><i>static</i></template>dropped</x-list>${listScript}</body>`;
    // A definition code registers whose styles import a stylesheet, and an authored instance waiting for it.
    files["/styles/defaults.css"] = "p { color: rgb(1, 2, 3); } :host(:state(open)) p { background-color: rgb(4, 5, 6); }";
    files["/styles/define.html"] = `<!doctype html><body><main><x-styled id="authored"></x-styled></main>
      <script type="module">
        import { ready, componentRegistry } from "/browser.js";
        await ready;
        window.registry = componentRegistry;
      </script></body>`;
    files["/compiled-lists.html"] = `<!doctype html><body><main></main>${listScript}</body>`;
    files["/"] = `<!doctype html><head><link rel="component" href="/callout.html"></head><body><main></main><script type="module">
      import * as live from "/browser.js";
      import * as compiled from "/compiled.js";
      await live.ready;
      window.bundles = { live: live.componentRegistry, compiled: compiled.componentRegistry };
    </script></body>`;
    // Inline definitions with controllers: one the observer discovers, one code defines.
    files["/nested/inline.js"] = 'export default (host) => { host.root.dataset.controller = "inline"; };';
    files["/nested/defined.js"] = 'export default (host) => { host.root.dataset.controller = "defined"; };';
    files["/nested/inline.html"] = `<!doctype html><body>
      <template component="x-inline" controller="./inline.js"><p>Inline</p></template>
      <main><x-inline id="discovered"></x-inline><x-defined id="authored"></x-defined></main>
      <script type="module">
        import { ready, componentRegistry } from "/browser.js";
        await ready;
        window.registry = componentRegistry;
      </script></body>`;
  });

  for (const engine of [chromium, firefox, webkit]) {
    describe(engine.name(), () => {
      let browser: Browser;
      beforeAll(async () => { browser = await engine.launch(); });
      afterAll(async () => { await browser?.close(); });

      it("creates and updates live and compiled components from either bundle", async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("https://registry.example/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ contentType: path.endsWith(".js") ? "text/javascript" : "text/html", body: files[path]! });
        });
        await page.goto("https://registry.example/");
        await page.waitForFunction(() => "bundles" in window);
        const result = await page.evaluate(async () => {
          type Registry = typeof import("../src/component-registry.js").componentRegistry;
          const { live, compiled } = (window as unknown as { bundles: { live: Registry; compiled: Registry } }).bundles;
          const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
          const main = document.querySelector("main")!;
          // The live runtime's definition, created by the compiled module's bundle.
          const { create, update } = compiled;
          const heading = document.createElement("span");
          heading.slot = "heading";
          heading.textContent = "Before you start";
          const root = create("ui-callout", { props: { tone: "tip" }, content: [heading, "Install first."] }) as HTMLElement;
          const created = { tag: root.localName, connected: root.isConnected, tone: root.getAttribute("data-tone"),
            heading: root.querySelector("h2 > span") === heading, body: root.querySelector("p")!.textContent, controller: root.dataset.controller ?? null };
          main.append(root);
          // Inserting it connects it, and its controller module loads and runs.
          for (let tries = 0; tries < 100 && root.dataset.controller === undefined; tries += 1) await settle();
          const controller = root.dataset.controller ?? null;
          update(root, { tone: "warning" });
          await settle();
          // The compiled module's definition, created by the live runtime's bundle.
          const badgeRoot = live.create("ui-badge", { props: { label: "Beta" } });
          main.append(badgeRoot);
          await settle();
          const label = badgeRoot.textContent;
          live.update(badgeRoot, { label: "Stable" });
          await settle();
          return {
            created, controller, updated: root.getAttribute("data-tone"), label, relabeled: badgeRoot.textContent,
            shared: live.get("ui-badge") === compiled.get("ui-badge") && live.get("ui-callout") === compiled.get("ui-callout"),
          };
        });
        assert.deepEqual(result, {
          created: { tag: "aside", connected: false, tone: "tip", heading: true, body: "Install first.", controller: null },
          controller: "ran",
          updated: "warning",
          label: "Beta",
          relabeled: "Stable",
          shared: true,
        });
        assert.deepEqual(errors, []);
        await page.close();
      });

      it("renders a <template slot> given to create, scoped and plain, live and compiled", async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("https://registry.example/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ contentType: path.endsWith(".js") ? "text/javascript" : "text/html", body: files[path]! });
        });
        const run = async (path: string, tags: readonly string[], scoped: string) => {
          await page.goto(`https://registry.example${path}`);
          await page.waitForFunction(() => "registry" in window);
          return page.evaluate(async ({ tags, scoped }) => {
            type Registry = typeof import("../src/component-registry.js").componentRegistry;
            const registry = (window as unknown as { registry: Registry }).registry;
            const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
            const template = (slot: string, html: string): HTMLTemplateElement => {
              const element = document.createElement("template");
              element.setAttribute("slot", slot);
              element.innerHTML = html;
              return element;
            };
            const results: Record<string, unknown> = {};
            for (const tag of tags) {
              try {
                const root = registry.create(tag, { content: [template("row", scoped), template("plain", "<i>static</i>"), "dropped"] });
                const rows = () => Array.from(root.querySelectorAll("li"), (item) => item.textContent);
                const before = rows();
                document.querySelector("main")!.append(root);
                await settle();
                const connected = rows();
                registry.update(root, { rows: ["a", "z", "c"] });
                await settle();
                results[tag] = { before, connected, updated: rows() };
              } catch (error) { results[tag] = (error as Error).message.replace(/^.*?(HR\d+)/, "$1"); }
            }
            return results;
          }, { tags, scoped });
        };
        // Bindings in the template read the slot's props, in the live runtime and in compiled output beside it.
        const rendered = { before: ["a", "b", "static"], connected: ["a", "b", "static"], updated: ["a", "z", "c", "static"] };
        assert.deepEqual(await run("/lists.html", ["x-list", "x-clist"], "<b>{$item}</b>"), { "x-list": rendered, "x-clist": rendered });
        // The same content authored in the document renders the same rows.
        assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll("#authored li"), (item) => item.textContent)), ["a", "b", "static"]);
        // Compiled output alone renders a template without bindings, and needs the parser for one with them.
        assert.deepEqual(await run("/compiled-lists.html", ["x-clist"], "<b>row</b>"),
          { "x-clist": { before: ["row", "row", "static"], connected: ["row", "row", "static"], updated: ["row", "row", "row", "static"] } });
        assert.match(String((await run("/compiled-lists.html", ["x-clist"], "<b>{$item}</b>"))["x-clist"]), /^HR007/);
        assert.deepEqual(errors, []);
        await page.close();
      });

      it("defines a carrier whose styles import a stylesheet, registering at once and styling once the import loads", async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
        await page.route("https://registry.example/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          // The import arrives after define returns.
          if (path.endsWith(".css")) await new Promise((resolve) => setTimeout(resolve, 100));
          return route.fulfill({ contentType: path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", body: files[path]! });
        });
        await page.goto("https://registry.example/styles/define.html");
        await page.waitForFunction(() => "registry" in window);
        const result = await page.evaluate(async () => {
          type Registry = typeof import("../src/component-registry.js").componentRegistry;
          const registry = (window as unknown as { registry: Registry }).registry;
          const host = document.createElement("div");
          host.innerHTML = `<template component="x-styled"><defs><state name="open" type="boolean" value="true"></state></defs>
            <section><p>Styled</p></section><style>@import "./defaults.css"; p { margin: 7px; }</style></template>`;
          registry.define(host.firstElementChild as HTMLTemplateElement);
          const waited = await Promise.race([registry.whenDefined("x-styled").then(() => "defined"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 0))]);
          const authored = document.querySelector("#authored") ?? document.querySelector("main > section")!;
          const created = registry.create("x-styled");
          document.querySelector("main")!.append(created);
          const style = (root: Element) => {
            const computed = getComputedStyle(root.querySelector("p")!);
            return [computed.color, computed.backgroundColor, computed.marginTop];
          };
          const lowered = authored.localName;
          for (let tries = 0; tries < 200 && style(created)[0] !== "rgb(1, 2, 3)"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { waited, lowered, authored: style(authored), created: style(created) };
        });
        const styled = ["rgb(1, 2, 3)", "rgb(4, 5, 6)", "7px"];
        assert.deepEqual(result, { waited: "defined", lowered: "section", authored: styled, created: styled });
        assert.deepEqual(errors, []);
        await page.close();
      });

      it("runs an inline definition's controller, discovered or defined, for lowered and created instances", async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
        await page.route("https://registry.example/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ contentType: path.endsWith(".js") ? "text/javascript" : "text/html", body: files[path]! });
        });
        await page.goto("https://registry.example/nested/inline.html");
        await page.waitForFunction(() => "registry" in window);
        const result = await page.evaluate(async () => {
          type Registry = typeof import("../src/component-registry.js").componentRegistry;
          const registry = (window as unknown as { registry: Registry }).registry;
          const main = document.querySelector("main")!;
          const ran = async (element: Element): Promise<string | null> => {
            for (let tries = 0; tries < 100 && (element as HTMLElement).dataset.controller === undefined; tries += 1) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return (element as HTMLElement).dataset.controller ?? null;
          };
          const carrier = document.createElement("template");
          carrier.setAttribute("component", "x-defined");
          carrier.setAttribute("controller", "./defined.js");
          carrier.innerHTML = "<p>Defined</p>";
          registry.define(carrier);
          const created = [registry.create("x-inline"), registry.create("x-defined")];
          main.append(...created);
          return {
            discovered: await ran(document.querySelector("#discovered")!),
            authored: await ran(document.querySelector("#authored")!),
            createdInline: await ran(created[0]!),
            createdDefined: await ran(created[1]!),
          };
        });
        assert.deepEqual(result, { discovered: "inline", authored: "defined", createdInline: "inline", createdDefined: "defined" });
        assert.deepEqual(errors, []);
        await page.close();
      });
    });
  }
});
