import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { generateComponent } from "../src/generate.js";
import { parseComponent, parseComponentResource } from "../src/source-parser.js";
import { compiledFixtures } from "./hydration-fixtures.js";

const source = '<template component="x-await"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="caption" type="string">Optional caption.</prop><computed name="captionText" type="string" from="default($caption, \'Fallback\')"></computed></defs><section><mark>{$captionText}</mark><template $await="binding of $product"><h2>{$product.name}</h2><input value="initial"><small $if="$binding.pending">Refreshing.</small></template><p $error="problem">{$problem.message}</p><i $else>Loading.</i></section></template>';
const seededSource = source.replace('</defs>', '<prop name="driven" type="string">Driven.</prop><state name="draft" type="object({ name: string })" from="$product"></state></defs>')
  .replace('binding of $product', 'binding of $draft').replace('{$product.name}', '{$draft.name}');
const sources = [["direct", source], ["derived", source.replace("</defs>", '<prop name="driven" type="string">Driven.</prop><state name="query" type="integer" value="1"></state><computed name="label" type="string" from="concat($product.name)"></computed><computed name="key" type="string" from="concat($label, \'/\', $query)"></computed></defs>')
  .replace("binding of $product", "binding of $label").replace("{$product.name}", "{$label}")],
  ["expression", '<template component="x-await"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="enabled" type="boolean" default="true">Enabled.</prop></defs><section><x-render from:product="$enabled ? $product : { name: \'Fixture\' }"></x-render></section></template>' + source.replace('component="x-await"', 'component="x-render"').replace('<section>', '<article>').replace('</section>', '</article>')]] as const;

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("await and rendered-input adoption", () => {
  let directory: string;
  const bundles = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-await-"));
    const live = new URL("../src/live.ts", import.meta.url).pathname;
    const runtime = new URL("../src/runtime.ts", import.meta.url).pathname;
    const entries: Record<string, string> = {
      live: `export * from ${JSON.stringify(live)}; import { lowerDocument } from ${JSON.stringify(live)}; export const boot = () => lowerDocument(document, { connect: false });`,
    };
    for (const [variant, source] of [...sources, ["seed", seededSource]]) {
        const compiled = variant === "expression" ? await compiledFixtures("esm", "", parseComponentResource(source, "await.html").definitions)
          : generateComponent(parseComponent(source), { hydrate: true }).find(artifact => artifact.path === "vanilla/XAwait.js")!.content;
        entries[`compiled-${variant}`] = `${compiled}\nexport { getComponentHost, componentInputs, serializeRenderedForm, componentRegistry } from ${JSON.stringify(runtime)};
        export function boot() {
          const existing = document.querySelector('main section');
          const root = ${variant === "expression" ? 'factories["x-await"]' : "createXAwait"}({}, undefined, existing ?? undefined);
          document.querySelector('main x-await')?.replaceWith(root);
        }`;
    }
    const bindings = new URL("../src/bindings.ts", import.meta.url).pathname;
    for (const [mode, entry] of Object.entries(entries)) {
      const contents = `${entry}\nexport { BindingScope } from ${JSON.stringify(bindings)};`;
      const bundle = join(directory, `${mode}.js`);
      await build({ stdin: { contents, loader: "js", resolveDir: new URL("../src/", import.meta.url).pathname }, outfile: bundle,
        bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
        define: { "import.meta.url": "document.baseURI" },
        alias: { "@nextwebwg/html-next/generated-runtime": new URL("../src/generated-runtime.ts", import.meta.url).pathname },
        plugins: [{ name: "fixture-css", setup(build) {
          build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "fixture-css" }));
          build.onLoad({ filter: /.*/, namespace: "fixture-css" }, () => ({ contents: "", loader: "js" }));
        } }] });
      bundles.set(mode, bundle);
    }
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const mode of ["live", "compiled"]) {
    it(`${name} ${mode} initializes an independent draft and exposes its availability to a driver`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`${seededSource}<main><x-await></x-await></main>`);
        await page.addScriptTag({ path: bundles.get(mode === "live" ? mode : "compiled-seed")! });
        const result = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: typeof import("../src/live.js") & typeof import("../src/bindings.js") & { boot(): void } }).HtmlRuntime;
          runtime.boot();
          const root = document.querySelector("section")!;
          if (root.querySelector("mark")?.textContent !== "Fallback") throw new Error("A default fallback must remain available.");
          const host = runtime.getComponentHost(root)!;
          const port = runtime.componentInputs(host);
          const product = port.source("product");
          const keys: string[] = [];
          const scope = new runtime.BindingScope(port, { driven: { input: (_props, { state }) => (state.draft as { name: string }).name,
            load: key => { keys.push(key); return key; } } }, { phase: "browser" });
          const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); await scope.settled(); };
          try {
            scope.activate(); await settle();
            const waiting = { ready: port.status("draft").ready, reads: keys.length, text: root.querySelector("i")?.textContent };
            product.publish({ status: { ready: false, pending: false, error: { name: "Error", message: "Offline" }, stale: false } }); await settle();
            const error = root.querySelector("p")?.textContent;
            product.publish({ value: { name: "Remote" }, status: { ready: true, pending: false, error: null, stale: false } });
            (host.state.draft as { name: string }).name = "Edited";
            const input = (port.read("product") as { name: string }).name;
            await settle();
            product.publish({ value: { name: "New remote" }, status: { ready: true, pending: false, error: null, stale: false } }); await settle();
            return { waiting, error, input, keys, text: root.querySelector("h2")?.textContent, output: port.read("driven"), ready: port.status("draft").ready };
          } finally { scope.dispose(); product.dispose(); }
        });
        assert.deepEqual(result, { waiting: { ready: false, reads: 0, text: "Loading." }, error: "Offline", input: "Remote", keys: ["Edited"], text: "Edited", output: "Edited", ready: true });
      } finally { await browser.close(); }
    });
    it(`${name} ${mode} propagates declaration availability into a selected-input driver`, async () => {
      const bundle = bundles.get(mode === "live" ? mode : "compiled-derived")!;
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`${sources[1][1]}<main><x-await></x-await></main>`);
        await page.addScriptTag({ path: bundle });
        const result = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: typeof import("../src/live.js") & typeof import("../src/bindings.js") & { boot(): void } }).HtmlRuntime;
          runtime.boot();
          const host = runtime.getComponentHost(document.querySelector("section")!)!;
          const port = runtime.componentInputs(host);
          const product = port.source("product");
          const keys: string[] = [];
          const scope = new runtime.BindingScope(port, { driven: { input: (_props, { state }) => state.key, load: key => { keys.push(key); return key; } } }, { phase: "browser" });
          const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); await scope.settled(); };
          try {
            product.publish({ status: { ready: false, pending: true, stale: false, error: null } });
            scope.activate(); await settle();
            const waiting = { ...port.status("driven"), reads: keys.length };
            product.publish({ value: { name: "Coffee" }, status: { ready: true, pending: false, stale: false, error: null } });
            await settle();
            host.state.query = 2; await settle();
            const value = port.read("driven");
            product.publish({ value: { name: "Coffee" }, status: { ready: true, pending: true, stale: false, error: null } });
            await settle();
            const refreshing = port.status("driven");
            product.publish({ value: { name: "Coffee" }, status: { ready: true, pending: false, stale: false, error: { name: "Error", message: "Offline" } } });
            await settle();
            return { waiting, value, keys, refreshing, error: port.status("driven").error?.message };
          } finally { scope.dispose(); product.dispose(); }
        });
        assert.deepEqual(result, { waiting: { ready: false, pending: true, stale: false, error: null, reads: 0 },
          value: "Coffee/2", keys: ["Coffee/1", "Coffee/2"], refreshing: { ready: true, pending: true, stale: false, error: null }, error: "Offline" });
      } finally { await browser.close(); }
    });
    it(`${name} ${mode} adopts completed provider reads and ignores stale preparation after a fixture edit`, async () => {
      const bundle = bundles.get(mode === "live" ? mode : "compiled-direct")!;
      const browser = await engine.launch({ headless: true });
      try {
        for (const scenario of ["success", "failure", "fixture"]) {
          const page = await browser.newPage();
          await page.setContent(`${source}<main><x-await></x-await></main>`);
          await page.addScriptTag({ path: bundle });
          const prepared = await page.evaluate(async scenario => {
            const runtime = (window as unknown as { HtmlRuntime: typeof import("../src/live.js") & typeof import("../src/bindings.js") & { boot(): void } }).HtmlRuntime;
            runtime.boot();
            const root = document.querySelector("section")!;
            const scope = new runtime.BindingScope(runtime.componentInputs(runtime.getComponentHost(root)!), {
              product: { input: () => 1, load: () => { if (scenario === "failure") throw new Error("Offline"); return { name: "Prepared" }; } },
            }, { phase: "request", source: "build-a" });
            try {
              scope.activate(); await scope.settled();
              return { snapshot: scope.snapshot(), html: runtime.serializeRenderedForm(document.querySelector("main")!) };
            } finally { scope.dispose(); }
          }, scenario);
          await page.close();
          const adopted = await browser.newPage();
          await adopted.setContent(`${source}<main>${prepared.html}</main>`);
          await adopted.addScriptTag({ path: bundle });
          const result = await adopted.evaluate(async ({ scenario, snapshot }) => {
            const runtime = (window as unknown as { HtmlRuntime: typeof import("../src/live.js") & typeof import("../src/bindings.js") & { boot(): void } }).HtmlRuntime;
            const original = document.querySelector("input");
            if (original) original.value = "Edited before hydration";
            runtime.boot();
            const root = document.querySelector("section")!;
            const port = runtime.componentInputs(runtime.getComponentHost(root)!);
            if (scenario === "fixture") {
              runtime.componentRegistry.update(root, { product: { name: "Fixture" } });
              runtime.componentRegistry.update(root, { product: undefined });
            }
            let reads = 0;
            const scope = new runtime.BindingScope(port, { product: { input: () => 1, load: () => { reads += 1; return { name: "Current" }; } } },
              { phase: "browser", source: "build-a", snapshot });
            try {
              scope.activate(); await scope.settled();
              for (let index = 0; index < 4; index += 1) await Promise.resolve();
              return { reads, text: root.querySelector("h2")?.textContent, error: port.status("product").error?.message,
                retained: scenario !== "success" || original === root.querySelector("input") && original?.value === "Edited before hydration" };
            } finally { scope.dispose(); }
          }, { scenario, snapshot: prepared.snapshot });
          assert.deepEqual(result, { reads: scenario === "fixture" ? 1 : 0,
            text: scenario === "failure" ? undefined : scenario === "fixture" ? "Current" : "Prepared",
            error: scenario === "failure" ? "Offline" : undefined, retained: true });
          await adopted.close();
        }
      } finally { await browser.close(); }
    });
    for (const [variant, source] of sources)
    it(`${name} ${mode} ${variant} preserves content during refresh and restores availability without caller ownership`, async () => {
      const bundle = bundles.get(mode === "live" ? mode : `${mode}-${variant}`)!;
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`${source}<main><x-await></x-await></main>`);
        await page.addScriptTag({ path: bundle });
        const result = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: typeof import("../src/live.js") & { boot(): void } }).HtmlRuntime;
          runtime.boot();
          const root = document.querySelector("section")!;
          const inputs = runtime.componentInputs(runtime.getComponentHost(root)!);
          const product = inputs.source("product");
          const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
          product.publish({ status: { ready: false, pending: true, error: null, stale: false } });
          await settle();
          const pending = root.querySelector("i")?.textContent;
          product.publish({ status: { ready: false, pending: false, error: { name: "NetworkError", message: "Offline" }, stale: false } });
          await settle();
          const error = root.querySelector("p")?.textContent;
          product.publish({ value: { name: "Coffee" }, status: { ready: true, pending: false, error: null, stale: false } });
          await settle();
          const control = root.querySelector("input")!;
          control.value = "an edit";
          product.publish({ value: { name: "Coffee" }, status: { ready: true, pending: true, error: null, stale: false } });
          await settle();
          const refreshing = root.querySelector("small")?.textContent;
          const retained = root.querySelector("input") === control && control.value === "an edit";
          product.publish({ value: { name: "Coffee" }, status: { ready: true, pending: false, error: { name: "NetworkError", message: "Offline" }, stale: false } });
          await settle();
          return { pending, error, refreshing, retained, failedRefresh: root.querySelector("p") === null,
            html: runtime.serializeRenderedForm(document.querySelector("main")!) };
        });
        assert.equal(result.pending, "Loading.");
        assert.equal(result.error, "Offline");
        assert.equal(result.refreshing, "Refreshing.");
        assert.equal(result.retained, true);
        assert.equal(result.failedRefresh, true);

        const adopted = await browser.newPage();
        await adopted.setContent(`${source}<main>${result.html}</main>`);
        await adopted.addScriptTag({ path: bundle });
        const restored = await adopted.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: typeof import("../src/live.js") & { boot(): void } }).HtmlRuntime;
          const original = document.querySelector("input");
          runtime.boot();
          const root = document.querySelector("section")!;
          const inputs = runtime.componentInputs(runtime.getComponentHost(root)!);
          const before = { sameControl: root.querySelector("input") === original, value: original?.value,
            status: inputs.status("product"), supplied: inputs.supplied("product") };
          inputs.source("product").publish({ value: { name: "Resumed" }, status: { ready: true, pending: false, error: null, stale: false } });
          for (let i = 0; i < 4; i += 1) await Promise.resolve();
          return { ...before, text: root.querySelector("h2")?.textContent };
        });
        assert.deepEqual(restored, { sameControl: true, value: "an edit", supplied: false, text: "Resumed",
          status: { ready: true, pending: false, error: { name: "NetworkError", message: "Offline" }, stale: false } });
      } finally { await browser.close(); }
    });
    }
  }
});
