import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { contextProviderSource as steps, contextReaderSource as step, contextAppSource as app } from "./fixtures/context-projection.js";

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("main").evaluate((root) => ({
      outer: ["outer-one", "outer-two"].map((id) => root.querySelector(`#${id}`)?.getAttribute("data-active")),
      inner: ["inner-one", "inner-two"].map((id) => root.querySelector(`#${id}`)?.getAttribute("data-active")),
      color: getComputedStyle(root.querySelector("#outer-one")!).color,
    })),
    pixels: await page.locator("main").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("Svelte projected context parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<string, { bundle: string; markup: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-context-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/steps.html"), steps);
    await writeFile(join(directory, "components/step.html"), step);
    await writeFile(join(directory, "components/app.html"), `<link rel="component" href="./steps.html"><link rel="component" href="./step.html">${app}`);
    for (const mode of ["application", "library", "libraries"] as const) {
      const outDirectory = join(directory, mode);
      let appSource: string;
      let css = "";
      if (mode === "libraries") {
        const provider = await convertComponents({ mode: "library", target: "svelte", root: directory,
          outDirectory: join(outDirectory, "provider"), entries: ["components/steps.html"] });
        const reader = await convertComponents({ mode: "library", target: "svelte", root: directory,
          outDirectory: join(outDirectory, "reader"), entries: ["components/step.html"] });
        css = (await Promise.all([provider, reader].flatMap((manifest, index) => manifest.output.artifacts
          .filter((artifact) => artifact.kind === "style").map((artifact) =>
            readFile(join(outDirectory, index === 0 ? "provider" : "reader", artifact.path), "utf8"))))).join("\n");
        appSource = `<script>import XSteps from "./provider/${provider.components[0]!.artifact}";
import XStep from "./reader/${reader.components[0]!.artifact}";</script>
<main data-component="x-app"><XSteps id="outer"><XStep id="outer-one" number={1}>Outer one</XStep><XStep id="outer-two" number={2}>Outer two</XStep>
<XSteps id="inner"><XStep id="inner-one" number={1}>Inner one</XStep><XStep id="inner-two" number={2}>Inner two</XStep></XSteps></XSteps></main>`;
      } else {
        const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["components/**"] });
        css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
          .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
        appSource = `<script>import XApp from "./${manifest.components.find((component) => component.tag === "x-app")!.artifact}";</script><XApp />`;
      }
      await writeFile(join(outDirectory, "App.svelte"), appSource);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("#mount")!;
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
      assert.match(markup, /id="outer-one"[^>]*data-active="yes"|data-active="yes"[^>]*id="outer-one"/);
      outputs.set(mode, { bundle, markup, css });
    }
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library", "libraries"] as const) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} keeps nearest-provider context through updates`, async () => {
        const { bundle: svelteBundle, markup: serverMarkup, css } = outputs.get(mode)!;
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${steps}${step}${app}<div id="mount"><x-app></x-app></div>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await svelte.setContent(`<style>${css}</style><div id="mount">${hydrate ? serverMarkup : ""}</div>`);
          await svelte.addScriptTag({ path: svelteBundle });
          await Promise.all([live, svelte].map((page) => page.locator("#outer-one").waitFor()));
          for (const expected of [
            { outer: ["yes", "no"], inner: ["yes", "no"] },
            { outer: ["no", "yes"], inner: ["yes", "no"] },
            { outer: ["no", "yes"], inner: ["no", "yes"] },
          ]) {
            await Promise.all([live, svelte].map((page) => page.waitForFunction((values) =>
              JSON.stringify(["outer-one", "outer-two", "inner-one", "inner-two"].map((id) => document.getElementById(id)?.getAttribute("data-active"))) ===
              JSON.stringify([...values.outer, ...values.inner]), expected)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte context pixels differ", live);
            if (expected.outer[0] === "no" && expected.inner[0] === "yes") {
              await Promise.all([live, svelte].map((page) => page.evaluate(() =>
                document.querySelector("#inner")!.append(document.querySelector("#outer-one")!))));
              const [movedNative, movedConverted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(movedConverted.behavior, movedNative.behavior, "a DOM move preserves the invocation's original context provider");
              assert.equal(movedConverted.behavior.outer[0], "no", "the moved reader retains the original outer provider");
              await assertPixelsEqual(svelte, movedConverted.pixels, movedNative.pixels, "moved context pixels differ", live);
            }
            if (expected.outer[0] === "yes") await Promise.all([live, svelte].map((page) => page.locator("#outer > button").click()));
            else if (expected.inner[0] === "yes") await Promise.all([live, svelte].map((page) => page.locator("#inner > button").click()));
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await svelte.close(); await browser.close();
        }
      });
    }
    }
  }
});
