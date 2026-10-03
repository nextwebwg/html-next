import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { assembleComponentPackage } from "@nextwebwg/html-next";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import ts from "typescript";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const run = promisify(execFile);
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

describe.skipIf(!enabled)("distributable three-target component library", () => {
  it("packs nested HTML Next, Vue, and React outputs for an independent consumer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-three-target-package-"));
    try {
      const source = join(directory, "source");
      const nested = join(source, "components", "nested");
      const packageRoot = join(directory, "package");
      const consumer = join(directory, "consumer");
      await mkdir(nested, { recursive: true });
      await mkdir(consumer);
      const card = join(source, "components", "card.html");
      const badge = join(nested, "badge.html");
      const unused = join(nested, "unused.html");
      await writeFile(card, `<link rel="component" href="./nested/badge.html">
<template component="x-card" status="early" summary="A card."><defs>
  <prop name="title" type="string" default="Ready">Title.</prop>
  <prop name="body" type="string" default="&lt;b&gt;Safe&lt;/b&gt;">Body.</prop>
</defs><article class="card" from:aria-label="title"><x-badge></x-badge><div $html="body"></div><slot></slot></article>
<style>:host { display: block; padding: 4px; }</style></template>`);
      await writeFile(badge, `<template component="x-badge" status="early" summary="A badge.">
<span class="badge">New</span><style>:host { color: red; }</style></template>`);
      await writeFile(unused, `<template component="x-unused" status="early" summary="Unused.">
<aside>UNUSED_COMPONENT_MARKER</aside><style>:host { --unused-component-style: keep-out; }</style></template>`);

      await assembleComponentPackage({
        name: "@example/html-next-triad", version: "0.0.1", outDirectory: packageRoot,
        components: [{ source: card }, { source: badge }, { source: unused }],
      });
      const convertedRoot = join(packageRoot, "converted");
      const vue = await convertComponents({ mode: "library", target: "vue", root: source,
        entries: ["components/**"], outDirectory: join(convertedRoot, "vue-target") });
      const react = await convertComponents({ mode: "library", target: "react", root: source,
        entries: ["components/**"], outDirectory: join(convertedRoot, "react-target") });
      assert.deepEqual(vue.components.map((component) => component.tag), ["x-card", "x-badge", "x-unused"]);
      assert.deepEqual(react.components.map((component) => component.tag), ["x-card", "x-badge", "x-unused"]);
      const packageJsonPath = join(packageRoot, "package.json");
      const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        exports: Record<string, unknown>;
        dependencies?: Record<string, string>;
        peerDependencies: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional: boolean }>;
      };
      manifest.exports["./vue-converted"] = "./converted/vue-target/vue/index.ts";
      manifest.exports["./react"] = "./converted/react-target/react/index.ts";
      for (const component of react.components) {
        manifest.exports[`./react/${component.name}`] = `./converted/react-target/${component.artifact}`;
      }
      manifest.dependencies = { ...manifest.dependencies, ...vue.package.dependencies, ...react.package.dependencies };
      Object.assign(manifest.peerDependencies, vue.package.peerDependencies, react.package.peerDependencies);
      manifest.peerDependenciesMeta = { vue: { optional: true }, react: { optional: true } };
      assert.equal(manifest.dependencies.parse5, "^8.0.1");
      await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const packed = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: packageRoot });
      const archive = join(directory, (JSON.parse(packed.stdout) as readonly { filename: string }[])[0]!.filename);
      await writeFile(join(consumer, "package.json"), '{"name":"triad-consumer","private":true,"type":"module"}\n');
      await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", archive], { cwd: consumer });
      const installed = join(consumer, "node_modules", "@example", "html-next-triad");
      await access(join(consumer, "node_modules", "parse5", "package.json"));
      await mkdir(join(consumer, "node_modules", "@types"), { recursive: true });
      for (const name of ["react", "react-dom", "@types/react", "@types/react-dom"]) {
        await symlink(resolve(nodeModulesPath, name), join(consumer, "node_modules", name), "dir");
      }
      for (const path of ["dist/index.js", "components/card.html", "components/nested/badge.html",
        "converted/vue-target/vue/index.ts", "converted/react-target/react/index.ts", "converted/react-target/react/components/XCard.tsx",
        "converted/react-target/react/components/nested/XBadge.tsx", "converted/react-target/react/components/XCard.css",
        "converted/vue-target/html-next.conversion.json", "converted/react-target/html-next.conversion.json"]) {
        await access(join(installed, path));
      }

      const reactEntry = join(consumer, "react-consumer.tsx");
      await writeFile(reactEntry, `import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { XCard, XBadge } from "@example/html-next-triad/react";
export const render = () => renderToStaticMarkup(<XCard title="Hello"><XBadge /></XCard>);
`);
      const typeOptions: ts.CompilerOptions = {
        noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
        jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
      };
      const typeErrors = (file: string) => ts.getPreEmitDiagnostics(ts.createProgram([file], typeOptions))
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      assert.deepEqual(typeErrors(reactEntry), [], "an installed React library must typecheck in its consumer");
      const invalidReactEntry = join(consumer, "invalid-react-consumer.tsx");
      await writeFile(invalidReactEntry, `import React from "react";
import { XCard } from "@example/html-next-triad/react";
export const wrong = <XCard title={42} />;
`);
      assert.ok(typeErrors(invalidReactEntry).some((message) => /number.*string/.test(message)),
        "the installed React library must reject an incorrectly typed declared prop");
      const reactBundle = await build({ entryPoints: [reactEntry], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-dom"],
        loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
      const reactModule = { exports: {} as { render(): string } };
      new Function("require", "module", "exports", reactBundle.outputFiles[0]!.text)(createRequire(import.meta.url), reactModule, reactModule.exports);
      assert.match(reactModule.exports.render(), /aria-label="Hello"/);
      assert.match(reactModule.exports.render(), /New/);
      assert.match(reactModule.exports.render(), /<b>Safe<\/b>/);
      const browserBundle = await build({ entryPoints: [reactEntry], bundle: true, write: false,
        platform: "browser", format: "esm", jsx: "automatic", external: ["react", "react-dom"],
        outdir: join(consumer, "bundle"), nodePaths: [nodeModulesPath] });
      const bundledCSS = browserBundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
      assert.ok(bundledCSS, "published React entry must retain imported component CSS");
      assert.match(bundledCSS, /display:\s*block/, "card CSS must survive package bundling");
      assert.match(bundledCSS, /color:\s*red/, "nested badge CSS must survive package bundling");
      const shakenEntry = join(consumer, "react-shaken.tsx");
      await writeFile(shakenEntry, `import React from "react";
import XCard from "@example/html-next-triad/react/XCard";
import XBadge from "@example/html-next-triad/react/XBadge";
export const card = <XCard title="Hello"><XBadge /></XCard>;
`);
      assert.deepEqual(typeErrors(shakenEntry), [], "individual React exports must typecheck in a consumer");
      const shakenBundle = await build({ entryPoints: [shakenEntry], bundle: true, write: false,
        platform: "browser", format: "esm", jsx: "automatic", external: ["react", "react-dom"],
        outdir: join(consumer, "shaken"), nodePaths: [nodeModulesPath] });
      const shakenContent = shakenBundle.outputFiles.map((file) => file.text).join("\n");
      assert.match(shakenContent, /display:\s*block/);
      assert.match(shakenContent, /color:\s*red/);
      assert.equal(shakenContent.includes("UNUSED_COMPONENT_MARKER"), false);
      assert.equal(shakenContent.includes("--unused-component-style"), false);
      const mountedEntry = join(consumer, "react-browser.tsx");
      await writeFile(mountedEntry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XCard, XBadge } from "@example/html-next-triad/react";
createRoot(document.querySelector("main")!).render(<XCard title="Hello"><XBadge /></XCard>);
`);
      const mountedBundle = await build({ entryPoints: [mountedEntry], bundle: true, write: false,
        platform: "browser", format: "iife", jsx: "automatic", outdir: join(consumer, "mounted"), nodePaths: [nodeModulesPath] });
      const mountedJS = mountedBundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
      const mountedCSS = mountedBundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
      assert.ok(mountedJS);
      assert.ok(mountedCSS);
      const liveBundle = await build({ entryPoints: [new URL("../../html-next/src/live.ts", import.meta.url).pathname],
        bundle: true, write: false, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
      const cardDefinition = (await readFile(card, "utf8")).replace(/<link rel="component"[^>]*>/, "");
      const badgeDefinition = await readFile(badge, "utf8");
      for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
        const browser = await launchParityBrowser(browserType);
        const [live, convertedPage] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          await live.setContent(`${cardDefinition}${badgeDefinition}<main><x-card title="Hello"><x-badge></x-badge></x-card></main>`);
          await live.addScriptTag({ content: liveBundle.outputFiles[0]!.text });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await convertedPage.setContent(`<style>${mountedCSS}</style><main></main>`);
          await convertedPage.addScriptTag({ content: mountedJS });
          await convertedPage.locator("article.card").waitFor();
          const snapshot = async (page: typeof live) => {
            await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            return { text: await page.locator("main").innerText(), pixels: await page.locator("main").screenshot({ animations: "disabled" }) };
          };
          const [native, convertedSnapshot] = await Promise.all([snapshot(live), snapshot(convertedPage)]);
          assert.equal(convertedSnapshot.text, native.text, `${engine} installed React library text differs`);
          await assertPixelsEqual(convertedPage, convertedSnapshot.pixels, native.pixels,
            `${engine} installed React library pixels differ`, live);
        } finally {
          await Promise.all([live.close(), convertedPage.close()]);
          await browser.close();
        }
      }

      for (const component of vue.components) {
        const path = join(installed, "converted", "vue-target", component.artifact);
        const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
        assert.deepEqual(parsed.errors, []);
        await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.name, inlineTemplate: true }).content);
      }
      const vueEntry = join(consumer, "vue-consumer.ts");
      await writeFile(vueEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { XCard, XBadge } from "@example/html-next-triad/vue-converted";
export const render = () => renderToString(createSSRApp({ render: () => h(XCard, { title: "Hello" }, { default: () => h(XBadge) }) }));
`);
      const vueBundle = await build({ entryPoints: [vueEntry], bundle: true, write: false,
        platform: "node", format: "cjs", external: ["vue", "vue/server-renderer"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-package", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const vueModule = { exports: {} as { render(): Promise<string> } };
      new Function("require", "module", "exports", vueBundle.outputFiles[0]!.text)(createRequire(import.meta.url), vueModule, vueModule.exports);
      const vueMarkup = await vueModule.exports.render();
      assert.match(vueMarkup, /aria-label="Hello"/);
      assert.match(vueMarkup, /New/);
      assert.match(vueMarkup, /<b>Safe<\/b>/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
