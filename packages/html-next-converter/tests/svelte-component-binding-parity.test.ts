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
import { componentBindingsSource as source, componentBindingsModule as controller } from "./fixtures/component-bindings.js";

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => ({
      amount: root.querySelector("#amount")?.textContent,
      text: root.querySelector("#label")?.textContent,
      flag: root.querySelector("#checked")?.textContent,
      controls: Array.from(root.querySelectorAll("input"), (element) => ({
        value: element.value, checked: element.checked, defaultValue: element.defaultValue,
        defaultChecked: element.defaultChecked, amount: element.getAttribute("data-amount"),
        text: element.getAttribute("data-value"), flag: element.getAttribute("data-checked"),
        valid: element.getAttribute("data-valid"),
      })),
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte component binding parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-component-binding-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "fields.html"), source);
    await writeFile(join(directory, "fields.js"), controller);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["fields.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      await writeFile(join(outDirectory, "App.svelte"), `<script>import XFields from "./${manifest.components.find((component) => component.tag === "x-bound-fields")!.artifact}";</script><XFields id="case" />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("main")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
      const bundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /data-amount="12"/);
      assert.match(markup, /value="Ready"/);
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} updates native typed component props from root controls`, async () => {
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
                if (url.endsWith("/fields.html")) return route.fulfill({ contentType: "text/html", body: source });
                if (url.endsWith("/fields.js")) return route.fulfill({ contentType: "text/javascript", body: controller });
                return route.fulfill({ contentType: "text/html", body: page === live
                  ? '<link rel="component" href="/fields.html"><main><x-bound-fields id="case"></x-bound-fields></main>'
                  : `<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>` });
              });
            }
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
            await svelte.addScriptTag({ path: output.bundle });
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (window as unknown as { fieldsHost?: unknown }).fieldsHost !== undefined)));
            const compare = async () => {
              const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(converted.behavior, native.behavior);
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte component binding pixels differ", live);
            };
            await compare();
            for (const page of pages) {
              await page.locator("#number").fill("17");
              await page.locator("#text").fill("Changed");
              await page.locator("#flag").uncheck();
            }
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              document.querySelector("#amount")?.textContent === "17" &&
              document.querySelector("#label")?.textContent === "Changed" && document.querySelector("#checked")?.textContent === "false")));
            await compare();
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { fieldsHost: { state: { form: Record<string, unknown> } } }).fieldsHost.state.form.amount = "invalid";
            })));
            await compare();
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { fieldsHost: { state: { form: { amount: number; text: string; checked: boolean } } } })
                .fieldsHost.state.form = { amount: 23, text: "Model", checked: true };
            })));
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (document.querySelector("#number") as HTMLInputElement).value === "23")));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#number").fill("")));
            await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector("#amount")?.textContent === "")));
            await compare();
            assert.deepEqual(errors, []);
            assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
          } catch (error) {
            const observed = await Promise.all(pages.map((page) => page.evaluate(() => ({
              html: document.querySelector("main")?.innerHTML,
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
