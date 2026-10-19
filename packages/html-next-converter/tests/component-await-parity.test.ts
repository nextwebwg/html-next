import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { sveltePlugin } from "./helpers/svelte.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
const run = promisify(execFile);
const svelteChecker = createRequire(new URL("../../html-next-unplugin/package.json", import.meta.url)).resolve("svelte-check/bin/svelte-check");
async function check(directory: string, command: string, args: string[], config: object): Promise<void> {
  const path = join(directory, "tsconfig.json");
  await writeFile(path, JSON.stringify(config));
  try { await run(command, [...args, path], { cwd: directory }); }
  catch (error) { throw new Error((error as { stdout?: string }).stdout || String(error), { cause: error }); }
}
const compilerOptions = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
  skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] };
const files = {
  "parent.html": `<link rel="component" href="./child.html"><template component="x-parent" module="./parent.js"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="amount" type="number" default="0">Amount.</prop><prop name="format" type="keyword" values="text, number" default="number">Format.</prop><prop name="answer">Answer.<type from="format"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop><prop name="enabled" type="boolean" default="true">Enabled.</prop><prop name="driven" type="integer">Provider result.</prop><state name="query" type="integer" value="0"></state><computed name="selectedAmount" type="number" from="$amount + $query"></computed><computed name="selected" type="object({ name: string })" from="$enabled ? $product : { name: 'Disabled' }"></computed></defs><section class="parent"><x-child from:product="$enabled ? $selected : { name: 'Disabled' }" from:amount="$amount" from:backup="$enabled ? 'Provided' : null"></x-child><strong class="driven">{$driven}</strong><output class="typed" from:data-format="$format">{$answer}</output><slot></slot></section></template>`,
  "child.html": `<template component="x-child" module="./child.js"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="amount" type="number">Amount.</prop><prop name="backup" type="string" default="Default">Backup.</prop><prop name="local" type="integer">Context result.</prop><context name="query" from="x-parent" as="parentQuery"></context><computed name="label" type="string" from="$product = null ? '' : concat($product.name)"></computed><computed name="fullLabel" type="string" from="$label"></computed><computed name="totalAmount" type="number" from="$amount * 1"></computed></defs><article><strong class="context-number">{$local}</strong><aside>{$backup}</aside><template $await="binding of $fullLabel"><h2>{$fullLabel}</h2><input value="initial"><small $if="$binding.pending">Refreshing.</small><em $if="$binding.error">{$binding.error.message}</em></template><p $error="problem">{$problem.message}</p><i $else>Loading.</i><b $await="$label">Concise</b><s $error>Failed.</s><u $else>Waiting.</u><output $await="total of $totalAmount">{$totalAmount}<span $if="$total.pending">Amount refresh.</span></output></article></template>`,
  "parent.js": `import { bindModule } from "@nextwebwg/html-next/bindings";
    if (typeof window === "undefined") throw new Error("Browser module imported during SSR");
    export const { connect } = bindModule({ create() {
      window.bindingCreates = (window.bindingCreates || 0) + 1;
      return { props: { driven: { input: (_props, { state }) => state.selectedAmount, load: value => {
        window.bindingReads = window.bindingReads || []; window.bindingReads.push(value); return value + 1;
      } } }, connect(host, context) {
      const port = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1"));
      const source = port.source("product"); window.port = port; window.source = source; window.componentHost = host;
      const amount = port.source("amount"); window.amount = amount;
      const enabled = port.source("enabled"); window.enabled = enabled;
      window.formatSource = port.source("format"); window.answerSource = port.source("answer");
      window.bindingContext = context;
      window.ownership = window.ownership || [];
      port.watch(() => { window.ownership.push(port.supplied("product")); });
    } };
    } });`,
  "child.js": `import { bindModule } from "@nextwebwg/html-next/bindings";
    export const { connect } = bindModule({ props: { local: { input: (_props, { state }) => state.parentQuery, load: value => value + 100 } }, connect(host) {
    const port = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1"));
    const source = port.source("product"); window.childPort = port;
    window.childAttempt = source.publish({ value: { name: "Unwanted default" }, status: { ready: true, pending: false, error: null, stale: false } });
    port.watch(() => {
      const value = port.read("product");
      if (window.publishDuringLayout && value?.name === "Commit race") {
        window.publishDuringLayout = false;
        window.source.publish({ value: { name: "During child layout" }, status: { ready: true, pending: false, stale: false, error: null } });
      }
    });
    // The connection releases these capabilities on disconnect.
  } });`,
};

describe.skipIf(!enabled)("asynchronous typed inputs through the real converters", () => {
  let directory = "";
  const bundles = new Map<string, string>();
  const serverHtml = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-await-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const out = join(directory, "react");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory: out, entries: ["parent.html"] });
    const parent = manifest.components.find(component => component.tag === "x-parent")!.artifact;
    await check(out, join(nodeModules, ".bin/tsc"), ["-p"], { compilerOptions: { ...compilerOptions, jsx: "react-jsx" }, include: ["react/**/*.ts", "react/**/*.tsx"] });
    const entry = join(out, "entry.tsx");
    const driver = `import React, { StrictMode, Suspense } from "react"; import { createRoot } from "react-dom/client"; import Parent from "./${parent}";
      const never = new Promise(() => {});
      function Block({ blocked }) { if (blocked) { window.tentativeRendered = true; throw never; } return null; }
      function App() { const [fixture, setFixture] = React.useState(undefined); const [blocked, setBlocked] = React.useState(false);
        window.setFixture = value => setFixture(() => value);
        window.startTentative = () => React.startTransition(() => { setFixture({ name: "Tentative" }); setBlocked(true); });
        window.endTentative = () => { setFixture(undefined); setBlocked(false); };
        return <Suspense fallback={<aside>Suspended</aside>}><Parent product={fixture}><Block blocked={blocked} /></Parent></Suspense>; }
      createRoot(document.querySelector("#mount")).render(RENDER);`;
    for (const [name, render] of [["react", "<App />"], ["strict", "<StrictMode><App /></StrictMode>"]]) {
      await writeFile(entry, driver.replace("RENDER", render!));
      const bundle = join(out, `${name}.js`);
      await build({ alias: { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) }, entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      bundles.set(name!, bundle);
    }
    const server = join(out, "server.tsx");
    await writeFile(server, `import { renderToString } from "react-dom/server"; import Parent from "./${parent}"; export const html = renderToString(<Parent />);`);
    const bundle = join(out, "server.mjs");
    await build({ alias: { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) }, entryPoints: [server], outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
    serverHtml.set("react", (await import(pathToFileURL(bundle).href)).html);
    // Keep the generated source available in assertion messages without retaining scratch copies.
    assert.match(await readFile(join(out, parent), "utf8"), /propInputs/);
    const vueOut = join(directory, "vue");
    const vueManifest = await convertComponents({ mode: "application", target: "vue", root: directory, outDirectory: vueOut, entries: ["parent.html"] });
    const vueParent = vueManifest.components.find(component => component.tag === "x-parent")!.artifact;
    await check(vueOut, fileURLToPath(new URL("../node_modules/.bin/vue-tsc", import.meta.url)), ["-p"], { compilerOptions, files: vueManifest.components.map(component => component.artifact) });
    for (const component of vueManifest.components) {
      const path = join(vueOut, component.artifact);
      const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
      assert.deepEqual(parsed.errors, []);
      await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
      const script = compileScript(parsed.descriptor, { id: component.tag });
      const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: component.tag, ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings ?? {} } });
      assert.deepEqual(template.errors, []);
      await writeFile(path.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });`);
    }
    const vuePlugin = (server: boolean) => ({ name: "vue-compiled", setup(pluginBuild: import("esbuild").PluginBuild) {
      pluginBuild.onResolve({ filter: /\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, server ? ".ssr.ts" : ".ts")) }));
    } });
    const vueEntry = join(vueOut, "entry.ts");
    await writeFile(vueEntry, `import { createApp, h, shallowRef } from "vue"; import Parent from "./${vueParent}";
      const fixture = shallowRef(undefined); window.setFixture = value => { fixture.value = value; };
      createApp({ render: () => h(Parent, { product: fixture.value }) }).mount(document.querySelector("#mount"));`);
    const vueBundle = join(vueOut, "bundle.js");
    await build({ alias: { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) }, entryPoints: [vueEntry], outfile: vueBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModules], loader: { ".css": "empty" }, plugins: [vuePlugin(false)] });
    bundles.set("vue", vueBundle);
    const vueServer = join(vueOut, "server.ts");
    await writeFile(vueServer, `import { createSSRApp, h } from "vue"; import { renderToString } from "@vue/server-renderer"; import Parent from "./${vueParent}"; export const html = await renderToString(createSSRApp({ render: () => h(Parent) }));`);
    const vueServerBundle = join(vueOut, "server.mjs");
    await build({ alias: { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) }, entryPoints: [vueServer], outfile: vueServerBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" }, plugins: [vuePlugin(true)] });
    serverHtml.set("vue", (await import(pathToFileURL(vueServerBundle).href)).html);
    const svelteOut = join(directory, "svelte");
    const svelteManifest = await convertComponents({ mode: "application", target: "svelte", root: directory, outDirectory: svelteOut, entries: ["parent.html"] });
    const svelteParent = svelteManifest.components.find(component => component.tag === "x-parent")!.artifact;
    await check(svelteOut, process.execPath, [svelteChecker, "--output", "machine", "--tsconfig"], { compilerOptions: { ...compilerOptions, allowJs: true }, include: ["svelte/**/*"] });
    const svelteDriver = join(svelteOut, "driver.svelte");
    await writeFile(svelteDriver, `<script>import Parent from "./${svelteParent}"; let fixture = $state.raw(undefined); window.setFixture = value => { fixture = value; };</script><Parent product={fixture} />`);
    const svelteEntry = join(svelteOut, "entry.ts");
    await writeFile(svelteEntry, `import { mount } from "svelte"; import Driver from "./driver.svelte"; mount(Driver, { target: document.querySelector("#mount") });`);
    const svelteBundle = join(svelteOut, "bundle.js");
    await build({ alias: { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) }, entryPoints: [svelteEntry], outfile: svelteBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModules], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
    bundles.set("svelte", svelteBundle);
    const svelteServer = join(svelteOut, "server.ts");
    await writeFile(svelteServer, `import { render } from "svelte/server"; import Parent from "./${svelteParent}"; export const html = render(Parent).body;`);
    const svelteServerBundle = join(svelteOut, "server.mjs");
    await build({ alias: { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) }, entryPoints: [svelteServer], outfile: svelteServerBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
    serverHtml.set("svelte", (await import(pathToFileURL(svelteServerBundle).href)).html);
  });
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const target of ["react", "vue", "svelte"]) it(`${target} renders an unavailable first frame on the server without running browser behavior`, () => {
    assert.match(serverHtml.get(target)!, /Loading\./);
    assert.match(serverHtml.get(target)!, /Waiting\./);
    assert.doesNotMatch(serverHtml.get(target)!, /Unwanted default|Concise/);
  });

  for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit }))
  for (const target of ["react", "strict", "vue", "svelte"]) it(`${engine} ${target} preserves ownership and refresh identity across nested inputs`, async () => {
    const browser = await launchParityBrowser(browserType);
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<div id="mount"></div>');
      await page.addScriptTag({ path: bundles.get(target)! });
      await page.waitForFunction(() => (window as any).source && (window as any).childPort && (window as any).ownership?.length > 0);
      await page.waitForFunction(() => document.querySelector("strong.driven")?.textContent === "1");
      assert.equal(await page.evaluate(() => (window as any).bindingCreates), 1, "passive factory survives StrictMode activation replay");
      await page.waitForFunction(() => document.querySelector("strong.context-number")?.textContent === "100");
      assert.equal(await page.evaluate(() => (window as any).port.readNames.includes("query") && (window as any).port.readNames.includes("selectedAmount")), true);
      await page.evaluate(() => { (window as any).componentHost.state.query = 3; });
      await page.waitForFunction(() => document.querySelector("strong.driven")?.textContent === "4" && document.querySelector("strong.context-number")?.textContent === "103");
      await page.evaluate(() => { (window as any).componentHost.state.query = 0; });
      await page.waitForFunction(() => document.querySelector("strong.driven")?.textContent === "1" && document.querySelector("strong.context-number")?.textContent === "100");
      const initialOwnership = await page.evaluate(() => [...(window as any).ownership] as boolean[]);
      assert.deepEqual(await page.evaluate(() => {
        (window as any).formatSource.publish({ value: "text", status: { ready: true, pending: false, stale: false, error: null } });
        const accepted = (window as any).answerSource.publish({ value: "hello", status: { ready: true, pending: false, stale: false, error: null } });
        return { accepted, value: (window as any).port.read("answer") };
      }), { accepted: true, value: "hello" });
      await page.waitForFunction(() => document.querySelector("output.typed")?.textContent === "hello");
      assert.deepEqual(await page.evaluate(() => {
        (window as any).formatSource.publish({ value: "number", status: { ready: true, pending: false, stale: false, error: null } });
        const accepted = (window as any).answerSource.publish({ value: 4, status: { ready: true, pending: false, stale: false, error: null } });
        return { accepted, value: (window as any).port.read("answer") };
      }), { accepted: true, value: 4 });
      await page.waitForFunction(() => document.querySelector("output.typed")?.textContent === "4");
      assert.equal(initialOwnership.every(value => value === false), true);
      const initial = await page.evaluate(() => ({ supplied: (window as any).childPort.supplied("product"), attempt: (window as any).childAttempt, text: document.querySelector("article")!.textContent }));
      assert.equal(initial.supplied, true);
      assert.equal(initial.attempt, false);
      assert.equal(await page.locator("article aside").textContent(), "Provided");
      assert.match(initial.text!, /Loading\./);
      assert.equal(await page.locator("article output").textContent(), "0");
      assert.equal(await page.evaluate(() => (window as any).port.supplied("amount")), false);
      await page.evaluate(() => (window as any).amount.publish({ status: { ready: false, pending: true, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("output span")?.textContent === "Amount refresh.");
      await page.waitForFunction(() => (window as any).port.status("driven").pending === true);
      await page.evaluate(() => (window as any).amount.publish({ value: 2, status: { ready: true, pending: false, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "2");
      assert.equal(await page.evaluate(() => (window as any).amount.publish({ value: null, status: { ready: true, pending: false, stale: false, error: null } })), true);
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "0");
      assert.equal(await page.evaluate(() => (window as any).port.read("amount")), 0, "a null result uses the declared default");
      await page.waitForFunction(() => document.querySelector("strong.driven")?.textContent === "1");
      const providerReads = await page.evaluate(() => (window as any).bindingReads.length);
      assert.deepEqual(await page.evaluate(() => (window as any).ownership), initialOwnership, "another input's source output does not rerun eligibility");
      await page.evaluate(() => (window as any).source.publish({ status: { ready: false, pending: false, stale: false, error: { name: "Offline", message: "Offline." } } }));
      await page.waitForFunction(() => document.querySelector("p")?.textContent === "Offline.");
      assert.equal(await page.evaluate(() => {
        (window as any).source.publish({ value: { name: "Coffee" }, status: { ready: true, pending: false, stale: false, error: null } });
        return (window as any).componentHost.state.selected?.name;
      }), "Coffee", "imperative computed reads see accepted source values before a render commits");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Coffee");
      await page.evaluate(() => { (window as any).edited = document.querySelector("input"); (window as any).edited.value = "an edit";
        (window as any).source.publish({ value: { name: "Coffee" }, status: { ready: true, pending: true, stale: false, error: null } }); });
      await page.waitForFunction(() => document.querySelector("small")?.textContent === "Refreshing.");
      assert.deepEqual(await page.evaluate(() => ({ same: document.querySelector("input") === (window as any).edited, value: (document.querySelector("input") as HTMLInputElement).value })), { same: true, value: "an edit" });
      await page.evaluate(() => (window as any).source.publish({ value: { name: "Coffee" }, status: { ready: true, pending: false, stale: false, error: { name: "Offline", message: "Refresh failed." } } }));
      await page.waitForFunction(() => document.querySelector("em")?.textContent === "Refresh failed.");
      assert.equal(await page.locator("p").count(), 0);
      assert.deepEqual(await page.evaluate(() => (window as any).ownership), initialOwnership, "source results and refresh status do not rerun eligibility");
      await page.evaluate(() => (window as any).setFixture({ name: "Fixture" }));
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Fixture");
      assert.equal(await page.evaluate(() => (window as any).source.publish({ status: { ready: false, pending: true, stale: false, error: null } })), false);
      await page.evaluate(() => (window as any).setFixture(null));
      await page.waitForFunction(() => document.querySelector("b")?.textContent === "Concise" && document.querySelector("h2")?.textContent === "");
      assert.equal(await page.evaluate(() => (window as any).port.supplied("product")), true);
      await page.evaluate(() => (window as any).setFixture(undefined));
      await page.waitForFunction(() => document.querySelector("i")?.textContent === "Loading.");
      await page.evaluate(() => (window as any).source.publish({ value: { name: "Resumed" }, status: { ready: true, pending: false, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Resumed");
      assert.equal(await page.evaluate(() => (window as any).source.publish({ value: { name: 7 }, status: { ready: true, pending: false, stale: false, error: null } })), false);
      assert.equal(await page.evaluate(() => (window as any).source.publish({ status: { ready: true, pending: false, stale: false, error: null } })), false, "undefined is not a produced object value");
      await page.evaluate(() => (window as any).setFixture({ name: 7 }));
      await page.waitForFunction(() => (window as any).componentHost.props.product.validity.valid === false);
      assert.equal(await page.locator("h2").textContent(), "Resumed");
      assert.equal(await page.evaluate(() => (window as any).port.supplied("product")), false);
      await page.evaluate(() => (window as any).source.publish({ value: { name: "Fresh" }, status: { ready: true, pending: false, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Fresh");
      assert.deepEqual(await page.evaluate(() => ({ input: (window as any).componentHost.props.product.inputValue, valid: (window as any).componentHost.props.product.validity.valid })), { input: { name: 7 }, valid: false });
      const ownership = await page.evaluate(() => (window as any).ownership as boolean[]);
      assert.deepEqual(ownership, [...initialOwnership, true, false]);
      await page.evaluate(() => (window as any).enabled.publish({ value: false, status: { ready: true, pending: false, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Disabled");
      await page.waitForFunction(() => document.querySelector("article aside")?.textContent === "Default");
      await page.evaluate(() => (window as any).source.publish({ status: { ready: false, pending: false, stale: false, error: { name: "Offline", message: "Ignored branch." } } }));
      assert.equal(await page.locator("h2").textContent(), "Disabled");
      await page.evaluate(() => (window as any).enabled.publish({ value: true, status: { ready: true, pending: false, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("p")?.textContent === "Ignored branch.");
      if (target === "react" || target === "strict") {
        await page.evaluate(() => (window as any).setFixture(undefined));
        await page.waitForFunction(() => document.querySelector("i")?.textContent === "Loading.");
        await page.evaluate(() => (window as any).source.publish({ value: { name: "Committed" }, status: { ready: true, pending: false, stale: false, error: null } }));
        await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Committed");
        await page.evaluate(() => (window as any).startTentative());
        await page.waitForFunction(() => (window as any).tentativeRendered === true);
        assert.deepEqual(await page.evaluate(() => ({ supplied: (window as any).port.supplied("product"), value: (window as any).port.read("product"), hostValue: (window as any).componentHost.props.product.value, computedName: (window as any).componentHost.state.selected?.name })), { supplied: false, value: { name: "Committed" }, hostValue: { name: "Committed" }, computedName: "Committed" });
        assert.deepEqual(await page.evaluate(() => ({ accepted: (window as any).source.publish({ value: { name: "During suspense" }, status: { ready: true, pending: false, stale: false, error: null } }), computedName: (window as any).componentHost.state.selected?.name })), { accepted: true, computedName: "During suspense" });
        await page.evaluate(() => (window as any).endTentative());
        await page.waitForFunction(() => document.querySelector("h2")?.textContent === "During suspense");
        assert.equal(await page.evaluate(() => (window as any).port.supplied("product")), false);
      }
      await page.evaluate(() => {
        (window as any).publishDuringLayout = true;
        (window as any).source.publish({ value: { name: "Commit race" }, status: { ready: true, pending: false, stale: false, error: null } });
      });
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "During child layout");
      assert.equal(await page.evaluate(() => (window as any).port.read("product").name), "During child layout");
      assert.equal(await page.evaluate(() => (window as any).bindingReads.length), providerReads, "unrelated input changes do not repeat provider reads");
      assert.deepEqual(errors, []);
    } catch (error) {
      if (errors.length > 0) throw new AggregateError([error, ...errors.map(message => new Error(message))], "Converted component failed", { cause: error });
      throw error;
    } finally { await browser.close(); }
  });
});
