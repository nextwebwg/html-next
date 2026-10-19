import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { afterAll, beforeAll, describe, it } from "vitest";
import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const files = {
  "parent.html": `<link rel="component" href="./child.html"><link rel="component" href="./local.html"><link rel="component" href="./selected.html"><template component="x-seed" module="./parent.js"><defs>
    <prop name="product" type="object({ name: string })">Product.</prop><prop name="driven" type="string">Saved.</prop>
    <state name="draft" type="object({ name: string })" from="$product"></state>
    <state name="early" from="$product.name"></state>
    <state name="same" from="$product.name"></state>
    <state name="forward" type="string" from="$later"></state><state name="later" type="string" from="$product.name"></state>
    <handler name="edit"><set name="draft.name" expr:value="concat($product.name, '!')"></set></handler>
    <computed name="label" type="string" from="$draft.name"></computed></defs>
    <section><template $await="binding of $draft"><h2>{$draft.name}</h2><input class="draft" bind:value="$draft.name"></template>
    <p $error="problem">{$problem.message}</p><i $else>Waiting.</i><input class="early" bind:value="$early">
    <b class="forward">{$forward}</b><b class="driven">{$driven}</b><button on:click="edit">Edit</button><x-seed-child from:product="$draft"></x-seed-child><x-local-seed></x-local-seed><x-selected-seed from:value="7"></x-selected-seed></section></template>`,
  "child.html": `<template component="x-seed-child" module="./child.js"><defs><prop name="product" type="object({ name: string })">Product.</prop>
    <context name="draft" from="x-seed" as="parentDraft"></context><state name="contextDraft" type="string" from="$parentDraft.name"></state><computed name="label" type="string" from="$parentDraft.name"></computed></defs>
    <article><span class="context" $await="$parentDraft">{$parentDraft.name}</span><em $error="problem">{$problem.message}</em><u $else>Context waiting.</u>
    <span class="child" $await="$product">{$product.name}</span><s $error>Unavailable.</s><s $else>Child waiting.</s><small $await="$label">{$label}</small><small $error>Label unavailable.</small>
    <b class="context-draft" $await="$contextDraft">{$contextDraft}</b><b $error>Draft unavailable.</b></article></template>`,
  "local.html": `<template component="x-local-seed"><defs><state name="text" type="string" from="'Local'"></state></defs><output class="local">{$text}</output></template>`,
  "selected.html": `<template component="x-selected-seed"><defs><prop name="value">Value.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
    <context name="draft" from="x-seed" as="parentDraft"></context><state name="mode" type="keyword" values="text, number" from="$parentDraft.name != '' ? 'number' : 'text'"></state></defs>
    <aside><output class="selected" $await="$mode">{$value}</output><output $error>Unavailable.</output></aside></template>`,
  "parent.js": `import { bindModule } from "@nextwebwg/html-next/bindings";
    if (typeof window === "undefined") throw new Error("Browser module imported during SSR");
    export const { connect } = bindModule({ props: { driven: { input: (_props, { state }) => state.label, load: value => {
      (window.reads ||= []).push(value); return value;
    } } }, connect(host, context) { window.activations = (window.activations || 0) + 1; window.activation = context.signal; window.host = host; window.port = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1")); window.source = window.port.source("product"); } });`,
  "child.js": `export function connect(host) { window.childPort = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1")); }`,
};

describe.skipIf(!enabled)("Vue one-time state through the converter", () => {
  let directory = "";
  let bundle: string;
  let render: (props: object) => Promise<string>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-state-"));
    const nodeModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    const out = join(directory, "output");
    const manifest = await convertComponents({ mode: "application", target: "vue", root: directory, outDirectory: out, entries: ["parent.html"] });
    const parent = manifest.components.find(component => component.tag === "x-seed")!.artifact;
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files: manifest.components.map(component => component.artifact) }));
    try { await promisify(execFile)(fileURLToPath(new URL("../node_modules/.bin/vue-tsc", import.meta.url)), ["-p", join(out, "tsconfig.json")], { cwd: out }); }
    catch (error) { throw new Error((error as { stdout?: string }).stdout || String(error), { cause: error }); }
    for (const component of manifest.components) {
      const path = join(out, component.artifact);
      const parsed = parse(await readFile(path, "utf8"), { filename: path });
      assert.deepEqual(parsed.errors, []);
      await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
      const script = compileScript(parsed.descriptor, { id: component.tag });
      const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: component.tag, ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings ?? {} } });
      assert.deepEqual(template.errors, []);
      await writeFile(path.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });`);
    }
    const plugin = (server: boolean): Plugin => ({ name: "vue-compiled", setup(build) {
      build.onResolve({ filter: /\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, server ? ".ssr.ts" : ".ts")) }));
    } });
    const alias = { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) };
    const entry = join(out, "entry.ts");
    await writeFile(entry, `import { createApp, h } from "vue"; import Parent from "./${parent}"; createApp({render: () => h(Parent)}).mount(document.querySelector("#mount"));`);
    bundle = join(out, "client.js");
    await build({ alias, entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: "es2022", nodePaths: [nodeModules], loader: { ".css": "empty" }, plugins: [plugin(false)] });
    const server = join(out, "server.ts");
    await writeFile(server, `import { createSSRApp, h } from "vue"; import { renderToString } from "@vue/server-renderer"; import Parent from "./${parent}"; export const render = props => renderToString(createSSRApp({ render: () => h(Parent, props) }));`);
    const serverBundle = join(out, "server.mjs");
    await build({ alias, entryPoints: [server], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" }, plugins: [plugin(true)] });
    render = (await import(pathToFileURL(serverBundle).href)).render;
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("renders a waiting server frame and seeds a supplied first frame without connection effects", async () => {
    const waiting = await render({});
    assert.match(waiting, /Waiting\./);
    assert.match(waiting, /Context waiting\./);
    assert.match(waiting, /Child waiting\./);
    const ready = await render({ product: { name: "Server" } });
    assert.match(ready, /<h2>Server<\/h2>/);
    assert.match(ready, /class="context"[^>]*>Server</);
    assert.match(ready, /class="child"[^>]*>Server</);
    assert.match(ready, /class="forward"[^>]*>Server</);
    assert.match(ready, /class="local"[^>]*>Local</);
    assert.match(ready, /class="selected"[^>]*>7</);
    assert.doesNotMatch(ready, /waiting\./i);
  });

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) it(`${name} waits, claims early edits and copies drafts before immediate nested writes`, async () => {
    const browser = await launchParityBrowser(engine);
    const errors: string[] = [];
    try {
      const page = await browser.newPage(); page.setDefaultTimeout(5_000);
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<div id="mount"></div>'); await page.addScriptTag({ path: bundle });
      await page.waitForFunction(() => (window as any).source && (window as any).childPort);
      assert.deepEqual(await page.evaluate(() => ({ value: (window as any).host.state.draft, status: (window as any).port.status("draft").ready,
        child: (window as any).childPort.status("product").ready, context: (window as any).childPort.status("parentDraft").ready, reads: (window as any).reads || [] })),
      { value: undefined, status: false, child: false, context: false, reads: [] });
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.locator("input.early").fill("Early edit"); await page.locator("input.early").fill("");
      assert.equal(await page.evaluate(() => (window as any).host.state.early), "");
      await page.evaluate(() => { (window as any).host.state.early = null; (window as any).host.state.same = undefined; (window as any).source.publish({ status: { ready: false, pending: true, error: null, stale: false } }); });
      await page.waitForFunction(() => (window as any).port.status("draft").pending && (window as any).childPort.status("parentDraft").pending);
      await page.evaluate(() => (window as any).source.publish({ status: { ready: false, pending: false, stale: false, error: { name: "Error", message: "Offline" } } }));
      await page.waitForFunction(() => (window as any).port.status("draft").error?.message === "Offline" && (window as any).childPort.status("parentDraft").error?.message === "Offline");
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => [document.querySelector("p")?.textContent, document.querySelector("em")?.textContent]), ["Offline", "Offline"]);
      await page.evaluate(() => (window as any).source.publish({ value: { name: "Old" }, status: { ready: true, pending: true, stale: true, error: null } }));
      await page.waitForFunction(() => (window as any).port.read("product").name === "Old");
      assert.equal(await page.evaluate(() => (window as any).host.state.draft), undefined);
      assert.equal(await page.evaluate(() => { (window as any).source.publish({ value: { name: "Remote" }, status: { ready: true, pending: false, stale: false, error: null } });
        (window as any).host.state.draft.name = "Edited"; return (window as any).port.read("product").name; }), "Remote");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Edited" && document.querySelector(".context")?.textContent === "Edited" && document.querySelector(".child")?.textContent === "Edited" && document.querySelector(".driven")?.textContent === "Edited");
      assert.equal(await page.evaluate(() => (window as any).host.state.early), null);
      assert.equal(await page.evaluate(() => (window as any).host.state.same), null);
      await page.locator("input.draft").fill("Control edit");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Control edit" && document.querySelector(".context")?.textContent === "Control edit" && document.querySelector(".child")?.textContent === "Control edit" && document.querySelector(".driven")?.textContent === "Control edit");
      assert.equal(await page.locator(".context-draft").textContent(), "Edited");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Remote!" && document.querySelector(".driven")?.textContent === "Remote!");
      await page.evaluate(() => (window as any).source.publish({ value: { name: "New" }, status: { ready: true, pending: false, stale: false, error: null } }));
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Remote!" && document.querySelector(".forward")?.textContent === "Remote");
      assert.deepEqual(await page.evaluate(() => (window as any).reads), ["Edited", "Control edit", "Remote!"]);
      await page.evaluate(() => (window as any).source.publish({ value: { name: "New" }, status: { ready: true, pending: false, stale: false, error: { name: "Error", message: "Refresh failed" } } }));
      assert.deepEqual(await page.evaluate(() => (window as any).port.status("draft")), { ready: true, pending: false, error: null, stale: false });
      await page.evaluate(() => { (window as any).detached = (window as any).host.root; (window as any).detached.remove(); });
      await page.waitForFunction(() => (window as any).activation.aborted);
      await page.evaluate(() => document.querySelector("#mount")!.append((window as any).detached));
      await page.waitForFunction(() => (window as any).activations === 2);
      await page.evaluate(() => (window as any).source.publish({ value: { name: "Reconnected" }, status: { ready: true, pending: false, stale: false, error: null } }));
      assert.equal(await page.locator("h2").textContent(), "Remote!");
      assert.deepEqual(await page.evaluate(() => (window as any).reads), ["Edited", "Control edit", "Remote!"]);
      await page.evaluate(() => (window as any).host.reset("draft"));
      assert.equal(await page.evaluate(() => (window as any).host.state.draft), null);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
