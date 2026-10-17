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
