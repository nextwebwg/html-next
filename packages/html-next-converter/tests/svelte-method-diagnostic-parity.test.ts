import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { sveltePlugin } from "./helpers/svelte.js";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
import { methodReadinessSource as source } from "./fixtures/method-readiness.js";

type Failure = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Svelte converter method-without-controller parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();
  const markups = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-method-diagnostic-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "no-controller.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["components/no-controller.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-no-controller"]);
      const app = join(outDirectory, "App.svelte");
      await writeFile(app, `<script>import XNoController from "./${manifest.components[0]!.artifact}";</script><XNoController id="case" />`);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "svelte.js");
      await writeFile(entry, `import { mount, hydrate, flushSync } from "svelte";
import XNoController from "./${manifest.components[0]!.artifact}";
const target = document.querySelector("main")!;
const instance = flushSync(() => target.hasChildNodes() ? hydrate(XNoController, { target, props: { id: "case" } }) : mount(XNoController, { target, props: { id: "case" } }));
(window as any).svelteNoControllerMethod = () => instance.ping();`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /Ping/);
      markups.set(mode, markup);
      converted.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const hydrate of [false, true]) {
      it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} preserves the not-ready method rejection`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, svelte] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          await live.setContent(`${source}<main><x-no-controller id="case"></x-no-controller></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await svelte.setContent(`<main>${hydrate ? markups.get(mode)! : ""}</main>`);
          await svelte.addScriptTag({ path: converted.get(mode)! });
          assert.equal(await live.locator("#case").textContent(), "Ping");
          assert.equal(await svelte.locator("#case").textContent(), "Ping");
          assert.deepEqual(await svelte.locator("#case").screenshot(), await live.locator("#case").screenshot());
          const liveFailure = await live.evaluate(async (): Promise<Failure | null> => {
            try { await (document.querySelector("#case") as Element & { ping(): Promise<void> }).ping(); return null; }
            catch (error) { const value = error as Error & { diagnostic?: { code?: string } }; return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message }; }
          });
          const svelteFailure = await svelte.evaluate(async (): Promise<Failure | null> => {
            try { await window.svelteNoControllerMethod(); return null; }
            catch (error) { const value = error as Error & { diagnostic?: { code?: string } }; return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message }; }
          });
          assert.deepEqual(liveFailure, {
            name: "TypeError", code: null, message: "Controller method `ping` is not ready for <x-no-controller>.",
          });
          assert.deepEqual(svelteFailure, liveFailure);
          const rootFailure = await svelte.evaluate(async (): Promise<Failure | null> => {
            try { await (document.querySelector("#case") as Element & { ping(): Promise<void> }).ping(); return null; }
            catch (error) { const value = error as Error & { diagnostic?: { code?: string } }; return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message }; }
          });
          assert.deepEqual(rootFailure, liveFailure);
          assert.deepEqual(await svelte.locator("#case").evaluate((root) => {
            const descriptor = Object.getOwnPropertyDescriptor(root, "ping");
            return { enumerable: descriptor?.enumerable, configurable: descriptor?.configurable };
          }), { enumerable: false, configurable: true });
        } finally {
          await Promise.all([live.close(), svelte.close()]);
          await browser.close();
        }
      });
      }
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    svelteNoControllerMethod: () => Promise<void>;
  }
}
