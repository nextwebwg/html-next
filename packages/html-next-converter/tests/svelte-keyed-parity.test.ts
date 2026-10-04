import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-keyed-list" status="early" summary="Keyed rows."><defs>
  <state type="list(unknown)" name="rows" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]"></state>
  <handler name="reorder"><set name="rows" expr:value="[{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }, { id: 'b', label: 'Bee' }]"></set></handler>
  <handler name="duplicate"><set name="rows" expr:value="[{ id: 'a', label: 'One' }, { id: 'a', label: 'Two' }]"></set></handler>
  <handler name="recover"><set name="rows" expr:value="[{ id: 'b', label: 'B' }, { id: 'a', label: 'Again' }]"></set></handler>
</defs><section><button type="button" class="reorder" on:click="reorder">Reorder</button>
  <button type="button" class="duplicate" on:click="duplicate">Duplicate</button>
  <button type="button" class="recover" on:click="recover">Recover</button>
  <ul><li $each="row of rows" $key="row.id" from:data-id="row.id"><span $value="row.label"></span><input value="Authored" size="6"></li></ul>
</section><style>:host { display: block; width: 180px; font: 16px/24px Arial, sans-serif; } li { border-bottom: 1px solid black; }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    rows: await page.locator("#case li").evaluateAll((rows) => rows.map((row) => [row.getAttribute("data-id"), row.textContent])),
    inputs: await page.locator("#case li").evaluateAll(rows => rows.map(row => [row.getAttribute("data-id"), row.querySelector<HTMLInputElement>('input')!.value])),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("Svelte keyed rows and duplicate diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { readonly bundle: string; readonly markup: string; readonly css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-keyed-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "list.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["list.html"] });
      const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
      const css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
      await writeFile(join(outDirectory, "App.svelte"), `<script>import XKeyedList from "./${manifest.components[0]!.artifact}";</script><XKeyedList id="case" />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("main")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      outputs.set(mode, { bundle, markup, css });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} preserves focused keyed inputs and native focus events`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const native = await browser.newPage();
            const converted = await browser.newPage();
            const output = outputs.get(mode)!;
            await native.setContent(`${source}<main><x-keyed-list id="case"></x-keyed-list></main>`);
            await native.addScriptTag({ path: liveBundle });
            await native.evaluate(() => window.HtmlRuntime.lowerDocument());
            await converted.setContent(`<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>`);
            await converted.addScriptTag({ path: output.bundle });
            for (const page of [native, converted]) {
              await page.locator('#case li[data-id="c"] input').waitFor();
              await page.evaluate(() => {
                const input = document.querySelector<HTMLInputElement>('#case li[data-id="c"] input')!;
                input.value = "Edited";
                input.focus();
                input.setSelectionRange(1, 4, "backward");
                const events: string[] = [];
                for (const type of ["blur", "focusout", "focus", "focusin"]) document.addEventListener(type, event => {
                  if ((event.target as Element).matches('#case li[data-id="c"] input')) events.push(type);
                }, true);
                Object.assign(window, { keyedFocusEvents: events });
                document.querySelector<HTMLButtonElement>("#case .reorder")!.click();
              });
              await page.waitForFunction(() => document.querySelector("#case li")?.getAttribute("data-id") === "c");
            }
            const read = (page: Page) => page.evaluate(() => {
              const state = window as unknown as { keyedFocusEvents: string[] };
              const input = document.querySelector<HTMLInputElement>('#case li[data-id="c"] input')!;
              return {
                value: input.value, selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
                focused: document.activeElement === input, events: state.keyedFocusEvents };
            });
            assert.deepEqual(await read(converted), await read(native));
          } finally { await browser.close(); }
        });
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} preserves rows and recovers after duplicate keys`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          try {
            const live = await browser.newPage();
            pages.push(live);
            const svelte = await browser.newPage();
            pages.push(svelte);
            const pageErrors: string[][] = [[], []];
            for (const [index, page] of [live, svelte].entries()) page.on("pageerror", (error) => pageErrors[index]!.push(`${error.name}: ${error.message}`));
            const output = outputs.get(mode)!;
            await live.setContent(`${source}<main><x-keyed-list id="case"></x-keyed-list></main>`);
            await svelte.setContent(`<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>`);
            for (const page of [live, svelte]) await page.evaluate(() => {
              const target = window as unknown as { keyedDiagnostics: { name: string; code: string | undefined; message: string }[] };
              target.keyedDiagnostics = [];
              const original = console.error;
              console.error = (error: unknown, ...rest: unknown[]) => {
                if (error instanceof Error) {
                  const failure = error as Error & { diagnostic?: { code: string } };
                  target.keyedDiagnostics.push({ name: failure.name, code: failure.diagnostic?.code, message: failure.message });
                }
                original(error, ...rest);
              };
              window.addEventListener("error", (event) => {
                const error = event.error as Error & { diagnostic?: { code: string } } | undefined;
                if (error != null) target.keyedDiagnostics.push({ name: error.name, code: error.diagnostic?.code, message: error.message });
              });
            });
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => window.HtmlRuntime.lowerDocument());
            await svelte.addScriptTag({ path: output.bundle });
            const compare = async (expected: readonly (readonly [string, string])[]) => {
              await Promise.all([live, svelte].map((page) => page.waitForFunction((rows) =>
                JSON.stringify(Array.from(document.querySelectorAll("#case li"), (row) => [row.getAttribute("data-id"), row.textContent])) === JSON.stringify(rows), expected,
              { timeout: 5_000 })));
              const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(converted.rows, native.rows);
              assert.deepEqual(converted.inputs, native.inputs);
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte keyed pixels differ", live);
            };
            await compare([["a", "A"], ["b", "B"], ["c", "C"]]);
            await Promise.all(pages.map((page) => page.evaluate(() => {
              document.querySelector<HTMLInputElement>('#case li[data-id="b"] input')!.value = 'Edited B';
            })));
            await Promise.all([live, svelte].map((page) => page.locator("#case .reorder").click()));
            await compare([["c", "C"], ["a", "A"], ["b", "Bee"]]);
            await Promise.all([live, svelte].map((page) => page.locator("#case .duplicate").click()));
            await compare([["c", "C"], ["a", "A"], ["b", "Bee"]]);
            const diagnostics = await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              (window as unknown as { keyedDiagnostics: { name: string; code: string | undefined; message: string }[] }).keyedDiagnostics)));
            for (const [index, reported] of diagnostics.entries()) assert.ok(reported.some((error) => error.name === "HtmlDiagnosticError" && error.code === "HR004" &&
              error.message === "HR004: A keyed list produced duplicate key `a`.") ||
              pageErrors[index]!.some((message) => message.includes("HR004: A keyed list produced duplicate key `a`.")),
            JSON.stringify({ diagnostics, pageErrors }));
            await Promise.all([live, svelte].map((page) => page.locator("#case .recover").click()));
            await compare([["b", "B"], ["a", "Again"]]);
            for (const messages of pageErrors) assert.equal(messages.some((message) => !message.includes("HR004")), false, JSON.stringify(pageErrors));
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
      }
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
