import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { componentDecorationsController } from "./fixtures/component-decorations.js";
import { delegatedDecorationsSource as source } from "./fixtures/delegated-decorations.js";

const controller = (owner: string): string => `window.styleModules ??= []; window.styleModules.push(${JSON.stringify(owner)});\n`
  + componentDecorationsController(owner)
  + "\nexport function outer(host) { return host.root.localName; }";

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((element) =>
      [...element.querySelectorAll<HTMLElement>("article, button, a, i")].map((root) => ({
        tag: root.localName, hasClass: root.hasAttribute("class"), hasStyle: root.hasAttribute("style"), components: root.getAttribute("data-component"), classes: [...root.classList],
        properties: Object.fromEntries([...root.style].map((name) => [name, [root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]])),
        color: getComputedStyle(root).color, padding: getComputedStyle(root).padding,
      }))),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte delegated decoration parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-delegated-decorations-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "refs.html"), source);
    for (const owner of ["leaf", "middle", "parent"]) await writeFile(join(directory, `${owner}.js`), controller(owner));
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["refs.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      await writeFile(join(outDirectory, "App.svelte"), `<script>import XStyledParent from "./${manifest.components.find((component) => component.tag === "x-styled-parent")!.artifact}";</script><XStyledParent id="case" />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("main")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
      const bundle = join(outDirectory, "mount.js");
      const clientBuild = await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", metafile: true,
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      assert.equal(Object.keys(clientBuild.metafile!.inputs).some((path) => /cssstyle|css-tree|css-color/.test(path)), false, "server CSSOM entered a browser bundle");
      assert.equal(manifest.package.dependencies.cssstyle, "^6.2.0");
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /<button\b/);
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} follows atomic decorations through a delegated root chain`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          const errors: string[] = [];
          const warnings: string[] = [];
          try {
            const live = await browser.newPage(); pages.push(live);
            const svelte = await browser.newPage(); pages.push(svelte);
            const output = outputs.get(mode)!;
            for (const page of pages) {
              page.setDefaultTimeout(5_000);
              page.on("pageerror", (error) => errors.push(error.message));
              page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
              await page.route("https://app.example/**", (route) => {
                const url = route.request().url();
                if (url.endsWith("/refs.html")) return route.fulfill({ contentType: "text/html", body: source });
                const owner = /\/(leaf|middle|parent)\.js$/.exec(url)?.[1];
                if (owner !== undefined) return route.fulfill({ contentType: "text/javascript", body: controller(owner) });
                return route.fulfill({ contentType: "text/html", body: page === live
                  ? '<link rel="component" href="/refs.html"><main><x-styled-parent id="case"></x-styled-parent></main>'
                  : `<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>` });
              });
            }
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
            if (hydrate) {
              const [native, server] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(server.behavior, native.behavior, "SSR decorations differ before hydration");
              await assertPixelsEqual(svelte, server.pixels, native.pixels, "Svelte SSR decoration pixels differ", live);
            }
            await svelte.addScriptTag({ path: output.bundle });
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              ["parent", "middle"].every((name) => Object.hasOwn((window as unknown as { styleHosts?: object }).styleHosts ?? {}, name)))));
            const compare = async (expectedTag: "button" | "a") => {
              const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.equal(native.behavior[0]!.tag, expectedTag);
              assert.deepEqual(converted.behavior, native.behavior);
              const owners = await Promise.all(pages.map((page) => page.evaluate(() =>
                Object.keys((window as unknown as { styleHosts: object }).styleHosts).sort())));
              assert.deepEqual(owners, [["middle", "parent"], ["middle", "parent"]], "delegated controllers must not start independently");
              const modules = await Promise.all(pages.map((page) => page.evaluate(() =>
                [...(window as unknown as { styleModules: string[] }).styleModules].sort())));
              assert.deepEqual(modules, owners, "delegated controller modules must not execute independently");
              const refs = await Promise.all(pages.map((page) => page.evaluate(() => {
                const ref = (window as unknown as { styleHosts: { parent: { refs: { shared: Element } } } }).styleHosts.parent.refs.shared;
                return { tag: ref.localName, connected: ref.isConnected, actualRoot: ref === document.querySelector("#case [data-leaf]") };
              })));
              assert.deepEqual(refs, Array.from({ length: 2 }, () => ({ tag: expectedTag, connected: true, actualRoot: true })));
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte decoration pixels differ", live);
            };
            await compare("button");
            const methods = await Promise.all(pages.map((page) => page.locator("#case button").evaluate(async (element) => {
              const root = element as unknown as Element & { outer(): Promise<string>; inner?: unknown; innerNoController?: unknown; };
              return { outer: await root.outer(), inner: typeof root.inner, innerNoController: typeof root.innerNoController };
            })));
            assert.deepEqual(methods, Array.from({ length: 2 }, () => ({ outer: "button", inner: "undefined", innerNoController: "undefined" })));
            await Promise.all(pages.map((page) => page.locator("#case [data-leaf]").click()));
            await compare("a");
            for (const [owner, name, value] of [
              ["parent", "color", "orange"], ["middle", "color", "blue"],
              ["middle", "active", false], ["parent", "active", true],
              ["parent", "color", "teal"], ["middle", "color", "purple"],
            ] as const) {
              await Promise.all(pages.map((page) => page.evaluate(({ owner, name, value }) => {
                const globals = window as unknown as { styleHosts: Record<string, { state: Record<string, unknown> }> };
                globals.styleHosts[owner]!.state[name] = value;
              }, { owner, name, value })));
              await compare("a");
            }
            await Promise.all(pages.map((page) => page.locator("#case [data-leaf]").click()));
            await compare("button");
            const replacedMethods = await Promise.all(pages.map((page) => page.locator("#case [data-leaf]").evaluate(async (element) =>
              (element as unknown as { outer(): Promise<string> }).outer())));
            assert.deepEqual(replacedMethods, ["button", "button"]);
            assert.deepEqual(errors, []);
            assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
          } catch (error) {
            const observed = await Promise.all(pages.map((page) => page.evaluate(() => ({
              html: document.querySelector("main")?.innerHTML,
              owners: Object.keys((window as unknown as { styleHosts?: object }).styleHosts ?? {}),
            }))));
            throw new Error(JSON.stringify({ observed, errors, warnings }), { cause: error });
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
      }
    }
  }
});
