import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { sveltePlugin } from "./helpers/svelte.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { stateSelectedReading as source } from "./fixtures/state-selected-reading.js";


describe.skipIf(!enabled)("Svelte state-selected prop parity", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<"application" | "library", { browser: string; server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-selected-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "selected.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["selected.html"], root: directory, outDirectory });
      const component = manifest.components[0]!;
      await writeFile(join(outDirectory, "App.svelte"), `<script lang="ts">
import Component from "./${component.artifact}";
let value = $state<string | number>(2);
(globalThis as typeof globalThis & { svelteSetValue: (value: string | number) => void }).svelteSetValue = (next) => { value = next; };
</script><Component value={value} />`);
      const entry = join(outDirectory, "entry.ts");
      await writeFile(entry, 'import { mount, hydrate } from "svelte"; import App from "./App.svelte"; const target = document.querySelector("main")!; if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });');
      const browser = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: browser, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, 'import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;');
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external",
        loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const server = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(server, /data-mode="number"/);
      assert.match(server, /<span[^>]*data-value="2"[^>]*>/);
      bundles.set(mode, { browser, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
      it(`${engine} ${mode} ${hydrate ? "hydrates" : "mounts"} state-selected props and retains invalid updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-state-reading value="2"></x-state-reading></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          // A native HTML attribute is a string input. Match the Svelte consumer's actual numeric value.
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & {
            updateComponentProps(root: Element, props: Record<string, unknown>): void;
          }).updateComponentProps(document.querySelector("button")!, { value: 2 }));
          const output = bundles.get(mode)!;
          await svelte.setContent(`<main>${hydrate ? output.server : ""}</main>`);
          await svelte.addScriptTag({ path: output.browser });
          const read = (page: Page) => page.locator("button").evaluate((element) => ({
            mode: element.getAttribute("data-mode"), value: element.querySelector("span")!.getAttribute("data-value"),
            title: element.querySelector("span")!.getAttribute("title"), text: element.querySelector("span")!.textContent,
            valid: (element as unknown as Element & { validity: ValidityState }).validity.valid,
          }));
          const compare = async (expected: { mode: string; value: string; title: string; text: string; valid: boolean }) => {
            await Promise.all([live, svelte].map((page) => page.evaluate(() => new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
            const [native, converted] = await Promise.all([read(live), read(svelte)]);
            assert.deepEqual(native, expected);
            assert.deepEqual(converted, native);
            await assertPixelsEqual(svelte, await svelte.locator("button").screenshot(), await live.locator("button").screenshot(), "state-selected prop pixels differ", live);
          };
          await compare({ mode: "number", value: "2", title: "two", text: "2", valid: true });
          await Promise.all([live, svelte].map((page) => page.locator("button").click()));
          await compare({ mode: "text", value: "2", title: "two", text: "2", valid: false });
          const set = async (value: number | string) => {
            await live.evaluate((next) => (window.HtmlRuntime as typeof window.HtmlRuntime & {
              updateComponentProps(root: Element, props: Record<string, unknown>): void;
            }).updateComponentProps(document.querySelector("button")!, { value: next }), value);
            await svelte.evaluate((next) => (window as unknown as { svelteSetValue(value: string | number): void }).svelteSetValue(next), value);
          };
          await set(42);
          await compare({ mode: "text", value: "2", title: "two", text: "2", valid: false });
          await set("hello");
          await compare({ mode: "text", value: "hello", title: "other", text: "hello", valid: true });
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await svelte.close(); await browser.close();
        }
      });
      }
    }
  }
});
