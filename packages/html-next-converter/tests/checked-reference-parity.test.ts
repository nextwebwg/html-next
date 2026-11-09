import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { chromium, firefox, webkit } from "playwright";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { checkedReferenceInitial, checkedReferenceSource } from "../../html-next/tests/checked-reference-fixture.js";
import { namespaceInitial, namespaceSnapshot, namespaceSource } from "../../html-next/tests/namespace-fixture.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const vueServerRenderer = pathToFileURL(createRequire(new URL("../../html-next/package.json", import.meta.url)).resolve("@vue/server-renderer")).href;
const targets = ["react", "preact", "vue", "svelte", "angular"] as const;

describe.skipIf(!enabled)("converted actual-reference expressions", () => {
  let directory = "";
  const bundles = new Map<string, string>();
  const servers = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-checked-references-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app"); await mkdir(app);
    await writeFile(join(app, "checked.html"), checkedReferenceSource.replace('component="x-checked-reads"', 'component="x-checked-reads" controller="./controller.js"')
      .replace("<section>", '<section id="checked" from:data-choice="$draft[$key]" from:data-active="$nullFields.flag" from:spellcheck="$nullFields.flag">'));
    await writeFile(join(app, "once.html"), `<template component="x-read-once" controller="./controller.js"><defs>
      <state name="record" type="object({ name: string, count: number })" value="{ name: 'Initial', count: 0 }"></state>
      <state name="selector" type="object({ key: string })" value="{ key: 'name' }"></state>
      <state name="raw" type="unknown" value="{ value: 0 }"></state>
      <state name="attributeSource" type="unknown" value="{ value: false }"></state>
      <state name="namespaceRecord" type="object({ href: string })" from="{ href: 7 }"></state>
      </defs><section id="once-root" from:draggable="$attributeSource.value"><output id="once">{$record[$selector.key]}</output><output id="numeric-once">{$raw.value + 1}</output><svg><use id="namespace-once" xlink:href="#fallback" from:xlink:href="$namespaceRecord.href"></use></svg></section></template>`);
    await writeFile(join(app, "controller.js"), "export default function(host) { globalThis['record' in host.state ? 'onceHost' : 'checkedHost'] = host; }");
    await writeFile(join(app, "namespaces.html"), namespaceSource);
    for (const target of targets) {
      const out = join(app, target);
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries: ["checked.html", "once.html", "namespaces.html"] });
      if (target === "angular") {
        const appPath = join(out, "app.ts");
        await writeFile(appPath, `import { Component } from "@angular/core";
import { XCheckedReads, XReadOnce, XNamespaces } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
@Component({ selector: "app-root", standalone: true, imports: [XCheckedReads, XReadOnce, XNamespaces], template: '<section x-checked-reads></section><section x-read-once></section><article x-namespaces></article>' })
export class App {}`);
        const serverAppPath = join(out, "server-app.ts");
        await writeFile(serverAppPath, `import { Component } from "@angular/core";
import { XNamespaces } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
@Component({ selector: "server-root", standalone: true, imports: [XNamespaces], template: '<article x-namespaces></article>' })
export class ServerApp {}`);
        const config = join(out, "tsconfig.json");
        await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
          skipLibCheck: true, experimentalDecorators: true, rewriteRelativeImportExtensions: true, rootDir: out, outDir: join(out, "compiled"), types: [] },
          angularCompilerOptions: { strictTemplates: true }, files: [appPath, serverAppPath] }));
        const require = createRequire(import.meta.url);
        const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
        try { await promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: out }); }
        catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
        await cp(join(out, "angular/modules"), join(out, "compiled/angular/modules"), { recursive: true });
        const entry = join(out, "entry.ts");
        await writeFile(entry, `import "@angular/compiler";
import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./compiled/app.js";
document.getElementById("mount")!.append(document.createElement("app-root"));
bootstrapApplication(App);`);
        const bundle = join(directory, `${target}.js`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModules], loader: { ".css": "empty" } });
        bundles.set(target, bundle);
        const serverEntry = join(out, "server.ts");
        await writeFile(serverEntry, `import "@angular/compiler";
import { renderApplication, provideServerRendering } from "@angular/platform-server";
import { bootstrapApplication } from "@angular/platform-browser";
import { ServerApp } from "./compiled/server-app.js";
export const render = () => renderApplication(context => bootstrapApplication(ServerApp, { providers: [provideServerRendering()] }, context),
{ document: '<html><head><base href="http://localhost/"></head><body><server-root></server-root></body></html>', url: 'http://localhost/', allowedHosts: ['localhost'] });`);
        const serverBundle = join(out, "server.mjs");
        await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" } });
        servers.set(target, await (await import(pathToFileURL(serverBundle).href)).render());
        continue;
      }
      const checked = manifest.components.find(component => component.tag === "x-checked-reads")!.artifact;
      const once = manifest.components.find(component => component.tag === "x-read-once")!.artifact;
      const namespaces = manifest.components.find(component => component.tag === "x-namespaces")!.artifact;
      if (target === "vue") for (const artifact of [checked, once, namespaces]) {
        const path = join(out, artifact);
        const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
        assert.deepEqual(parsed.errors, []);
        await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: artifact, inlineTemplate: true }).content);
        const script = compileScript(parsed.descriptor, { id: artifact });
        const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: artifact, ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings ?? {} } });
        assert.deepEqual(template.errors, []);
        await writeFile(path.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });`);
      }
      const entry = join(out, "entry.tsx");
      await writeFile(entry, target === "react" ? `import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Checked from "./${checked}"; import Once from "./${once}"; import Namespaces from "./${namespaces}";
flushSync(() => createRoot(document.getElementById("mount")!).render(<><Checked/><Once/><Namespaces/></>));`
        : target === "svelte" ? `import { mount } from "svelte";
import Checked from "./${checked}"; import Once from "./${once}"; import Namespaces from "./${namespaces}";
mount(Checked, { target: document.getElementById("mount")! });
mount(Once, { target: document.getElementById("mount")! });
mount(Namespaces, { target: document.getElementById("mount")! });`
        : target === "vue" ? `import { createApp, h } from "vue";
import Checked from "./${checked}"; import Once from "./${once}"; import Namespaces from "./${namespaces}";
createApp({ render: () => [h(Checked), h(Once), h(Namespaces)] }).mount("#mount");`
        : `import { h, Fragment, render } from "preact";
import Checked from "./${checked}"; import Once from "./${once}"; import Namespaces from "./${namespaces}";
render(<><Checked/><Once/><Namespaces/></>, document.getElementById("mount")!);`);
      const bundle = join(directory, `${target}.js`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", jsxImportSource: target === "preact" ? "preact" : "react", nodePaths: [nodeModules], loader: { ".css": "empty" },
        plugins: target === "vue" ? [{ name: "compiled-vue", setup(builder) {
          builder.onResolve({ filter: /\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }] : target === "svelte" ? [sveltePlugin("client")] : [] });
      bundles.set(target, bundle);
      const serverEntry = join(out, "server.tsx");
      await writeFile(serverEntry, target === "vue" ? `import { createSSRApp, h } from "vue"; import { renderToString } from ${JSON.stringify(vueServerRenderer)}; import Namespaces from "./${namespaces}";
export const html = await renderToString(createSSRApp({ render: () => h(Namespaces) }));`
        : target === "svelte" ? `import { render } from "svelte/server"; import Namespaces from "./${namespaces}"; export const html = render(Namespaces).body;`
        : `import { renderToString } from "${target === "preact" ? "preact-render-to-string" : "react-dom/server"}"; import Namespaces from "./${namespaces}"; export const html = renderToString(<Namespaces/>);`);
      const serverBundle = join(out, "server.mjs");
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", jsxImportSource: target === "preact" ? "preact" : "react", loader: { ".css": "empty" },
        plugins: target === "svelte" ? [sveltePlugin("server")] : target === "vue" ? [{ name: "compiled-vue-server", setup(builder) {
          builder.onResolve({ filter: /\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }] : [] });
      servers.set(target, (await import(pathToFileURL(serverBundle).href)).html);
    }
  }, 120_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) for (const target of targets) {
    it(`${engine} ${target} preserves namespaced attributes in parsed server output`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const page = await browser.newPage();
        await page.setContent(servers.get(target)!);
        assert.deepEqual(await page.evaluate(namespaceSnapshot), namespaceInitial);
      } finally { await browser.close(); }
    });

    it(`${engine} ${target} preserves namespaced attributes during creation and updates`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const page = await browser.newPage();
        await page.setContent('<div id="mount"></div>');
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.waitForSelector("#bound", { state: "attached" });
        const read = () => page.evaluate(namespaceSnapshot);
        assert.deepEqual(await read(), namespaceInitial);
        for (const [button, bound] of [["change", { href: "#second", value: "#second", language: "fr" }],
          ["unsafe", { href: "", value: null, language: "fr" }], ["change", { href: "#second", value: "#second", language: "fr" }]] as const) {
          await page.locator(`#${button}`).click();
          await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          assert.deepEqual(await read(), { ...namespaceInitial, bound });
        }
      } finally { await browser.close(); }
    });

    it(`${engine} ${target} checks only executed fields, retains results and reads getters once`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const page = await browser.newPage(); const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent('<!doctype html><div id="mount"></div>');
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.waitForFunction(() => (window as any).checkedHost && (window as any).onceHost).catch(error => {
          assert.fail(`${String(error)}; page errors: ${JSON.stringify(errors)}`);
        });
        const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await settle();
        assert.deepEqual(errors, []);
        const read = () => page.evaluate(ids => Object.fromEntries(ids.map(id => [id, document.getElementById(id)?.textContent])), Object.keys(checkedReferenceInitial));
        assert.deepEqual(await read(), checkedReferenceInitial);
        await page.evaluate(() => { const { state } = (window as any).checkedHost; state.choose = true; state.draft.name = "A"; state.draft["odd.key"] = "Quoted"; state.rows[0].name = "Row"; });
        await settle();
        const accepted = { ...checkedReferenceInitial, "computed-key": "A", "computed-index": "Row", "bad-fallback": "A", "quoted-key": "Quoted", label: "A", "alias-key": "Row", "ordered-name": "true", "ordered-row": "true" };
        assert.deepEqual(await read(), accepted);
        assert.deepEqual(errors, []);
        assert.equal(await page.locator("#checked").getAttribute("data-choice"), "A");
        await page.evaluate(() => { const { state } = (window as any).checkedHost; state.draft.name = 17; state.rows[0].name = 17; });
        await settle(); assert.deepEqual(await read(), accepted);
        assert.deepEqual(errors, []);
        assert.equal(await page.locator("#checked").getAttribute("data-choice"), "A");
        await page.evaluate(() => { (window as any).checkedHost.state.key = "missing"; }); await settle();
        assert.equal(await page.locator("#checked").getAttribute("data-choice"), null);
        assert.equal(await page.locator("#checked").getAttribute("data-active"), null);
        await page.evaluate(() => { (window as any).checkedHost.state.nullFields.flag = true; }); await settle();
        assert.equal(await page.locator("#checked").getAttribute("data-active"), "");
        assert.equal(await page.locator("#checked").getAttribute("spellcheck"), "true");
        await page.evaluate(() => { (window as any).checkedHost.state.nullFields.flag = false; }); await settle();
        assert.equal(await page.locator("#checked").getAttribute("data-active"), null);
        assert.equal(await page.locator("#checked").getAttribute("spellcheck"), "false");
        await page.evaluate(() => { (window as any).checkedHost.state.nullFields.flag = 7; }); await settle();
        assert.equal(await page.locator("#checked").getAttribute("data-active"), null);
        assert.equal(await page.locator("#checked").getAttribute("spellcheck"), "false");
        await page.evaluate(() => {
          (window as any).keyReads = 0;
          (window as any).onceHost.state.selector = { get key() { (window as any).keyReads += 1; return "name"; } };
        });
        await settle();
        const getters = await page.evaluate(async () => {
          const { state } = (window as any).onceHost; let names = 0;
          (window as any).keyReads = 0;
          state.record = { get name() { names += 1; return "Once"; }, count: 2 };
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return { names, keys: (window as any).keyReads, text: document.getElementById("once")?.textContent };
        });
        assert.deepEqual(getters, { names: 1, keys: 1, text: "Once" });
        await page.evaluate(() => { (window as any).onceHost.state.selector = { key: "count" }; }); await settle();
        assert.equal(await page.locator("#once").textContent(), "2");
        await page.evaluate(() => { (window as any).onceHost.state.record = { name: "Another", count: "wrong" }; }); await settle();
        assert.equal(await page.locator("#once").textContent(), "2");
        await page.evaluate(() => { (window as any).onceHost.state.record = { name: "Another", count: 3 }; }); await settle();
        assert.equal(await page.locator("#once").textContent(), "3");
        const numeric = await page.evaluate(async () => {
          let reads = 0;
          (window as any).onceHost.state.raw = { get value() { return ++reads; } };
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return { reads, text: document.getElementById("numeric-once")?.textContent };
        });
        assert.deepEqual(numeric, { reads: 1, text: "2" });
        // Root bindings may be reevaluated by the framework; per-expression capture is tested directly.
        const enumerated = await page.evaluate(async () => {
          (window as any).onceHost.state.attributeSource = { get value() { return false; } };
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return document.getElementById("once-root")?.getAttribute("draggable");
        });
        assert.equal(enumerated, "false");
        const namespaceUse = page.locator("#namespace-once");
        assert.equal(await namespaceUse.getAttribute("xlink:href"), "#fallback");
        const namespaced = await page.evaluate(async () => {
          let reads = 0;
          (window as any).onceHost.state.namespaceRecord = { get href() { reads += 1; return "#accepted"; } };
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const element = document.getElementById("namespace-once") as unknown as SVGUseElement;
          return { reads, value: element.href.baseVal };
        });
        assert.deepEqual(namespaced, { reads: 1, value: "#accepted" });
        await page.evaluate(() => { (window as any).onceHost.state.namespaceRecord = { href: 17 }; }); await settle();
        assert.equal(await namespaceUse.getAttribute("xlink:href"), "#accepted");
        await page.evaluate(() => { (window as any).onceHost.state.namespaceRecord = { href: null }; }); await settle();
        assert.equal(await namespaceUse.getAttribute("xlink:href"), null);
        await page.evaluate(() => { (window as any).onceHost.state.namespaceRecord = { href: "#recovered" }; }); await settle();
        assert.equal(await namespaceUse.getAttribute("xlink:href"), "#recovered");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
