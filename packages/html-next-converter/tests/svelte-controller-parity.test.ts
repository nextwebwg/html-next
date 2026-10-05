import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { assertTargetedDispatch } from "./fixtures/targeted-dispatch.js";
import { controllerParitySource as source, controllerParityModule as controller } from "./fixtures/controller-parity.js";

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => ({
      count: root.querySelector("output")?.textContent,
      local: root.getAttribute("data-local"),
      amount: root.getAttribute("data-amount-value"),
      input: root.getAttribute("data-amount-input"),
      valid: root.getAttribute("data-amount-valid"),
      stateHasAmount: root.getAttribute("data-state-has-amount"),
      trace: { ...(window as unknown as { trace: Record<string, number> }).trace },
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("Svelte controller parity", () => {
  let directory = "";
  let loaderBundle = "";
  const outputs = new Map<"application" | "library", { readonly bundle: string; readonly markup: string; readonly css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-controller-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/controlled.html"), source);
    await writeFile(join(directory, "components/controlled.js"), controller);
    const loaderEntry = join(directory, "loader-entry.ts");
    await writeFile(loaderEntry, `export { startBrowserComponents } from ${JSON.stringify(fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url)))};
export { updateComponentProps } from ${JSON.stringify(fileURLToPath(new URL("../../html-next/src/runtime.ts", import.meta.url)))};`);
    loaderBundle = join(directory, "loader.js");
    await build({ entryPoints: [loaderEntry],
      outfile: loaderBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory,
        entries: ["components/**"], publicRootURL: "/app/" });
      assert.ok(manifest.output.artifacts.some((artifact) => artifact.kind === "controller" && artifact.path.endsWith("controlled.js")));
      assert.ok(manifest.output.artifacts.some((artifact) => artifact.kind === "helper" && artifact.path === "svelte/host.svelte.ts"));
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const app = join(outDirectory, "App.svelte");
      await writeFile(app, `<script lang="ts">
import XControlled from "./${manifest.components[0]!.artifact}";
let amount = $state<unknown>(undefined);
if (typeof window !== "undefined") (window as any).svelteSetAmount = (next: unknown) => { amount = next; };
</script><XControlled id="case" amount={amount as number} />`);
      const mountEntry = join(outDirectory, "mount.ts");
      await writeFile(mountEntry, `import { mount, hydrate, unmount } from "svelte";
import App from "./App.svelte";
const target = document.querySelector("main")!;
const instance = target.hasChildNodes() ? hydrate(App, { target }) : mount(App, { target });
(window as any).svelteRoot = { unmount: () => unmount(instance) };`);
      const bundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [mountEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /<section[^>]*id="case"/);
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} matches controller effects, events, and cleanup`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          const errors: string[] = [];
          const warnings: string[] = [];
          try {
            const live = await browser.newPage();
            pages.push(live);
            const svelte = await browser.newPage();
            pages.push(svelte);
            svelte.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
            for (const page of [live, svelte]) {
              page.on("pageerror", (error) => errors.push(error.message));
              await page.route("https://app.example/**", async (route) => {
                const url = route.request().url();
                if (url.endsWith("/components/controlled.html")) await route.fulfill({ contentType: "text/html", body: source });
                else if (url.endsWith("/components/controlled.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
                else await route.fulfill({ contentType: "text/html", body: page === live
                  ? `<link rel="component" href="/components/controlled.html"><main><x-controlled id="case"></x-controlled></main>`
                  : `<style>${outputs.get(mode)!.css}</style><main>${hydrate ? outputs.get(mode)!.markup : ""}</main>` });
              });
            }
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await live.evaluate(() => { (window as unknown as { trace: Record<string, number> }).trace = { connects: 0, effects: 0, nestedEffects: 0, effectCleanups: 0, disconnects: 0 }; });
            await svelte.evaluate(() => { (window as unknown as { trace: Record<string, number> }).trace = { connects: 0, effects: 0, nestedEffects: 0, effectCleanups: 0, disconnects: 0 }; });
            await live.addScriptTag({ path: loaderBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): void } }).HtmlNextLoader.startBrowserComponents());
            await svelte.addScriptTag({ path: outputs.get(mode)!.bundle });
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.effects === 1)));
            const compare = async () => {
              const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(converted.behavior, native.behavior);
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte controller pixels differ", live);
            };
            for (const page of [live, svelte]) await assertTargetedDispatch(page);
            await compare();
            await Promise.all([live, svelte].map((page) => page.locator("#case button.same-nested").click()));
            assert.equal((await snapshot(live)).behavior.trace.nestedEffects, 1, "a no-op nested write must not rerun its controller effect");
            await compare();
            for (const amount of [2, "bad", 7] as const) {
              await live.evaluate((value) => (window as unknown as { HtmlNextLoader: {
                updateComponentProps(element: Element, props: Record<string, unknown>): void;
              } }).HtmlNextLoader.updateComponentProps(document.querySelector("#case")!, { amount: value }), amount);
              await svelte.evaluate((value) => (window as unknown as { svelteSetAmount(value: unknown): void }).svelteSetAmount(value), amount);
              await Promise.all([live, svelte].map((page) => page.waitForFunction((value) =>
                document.querySelector("#case")?.getAttribute("data-amount-input") === String(value), amount)));
              await compare();
            }
            const undeclared = await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const root = document.querySelector("#case")!;
              let observed: { detail: unknown; bubbles: boolean; composed: boolean; cancelable: boolean } | null = null;
              root.addEventListener("ping", (event) => {
                const custom = event as CustomEvent;
                observed = { detail: custom.detail, bubbles: custom.bubbles, composed: custom.composed, cancelable: custom.cancelable };
              }, { once: true });
              const returned = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } }).controllerHost.dispatch("ping", 7);
              return { observed, returned };
            })));
            assert.deepEqual(undeclared, [
              { observed: { detail: 7, bubbles: true, composed: true, cancelable: false }, returned: true },
              { observed: { detail: 7, bubbles: true, composed: true, cancelable: false }, returned: true },
            ]);
            const declared = await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const root = document.querySelector("#case")!;
              let observed: { detail: unknown; bubbles: boolean; composed: boolean; cancelable: boolean } | null = null;
              root.addEventListener("saved", (event) => {
                const custom = event as CustomEvent;
                observed = { detail: custom.detail, bubbles: custom.bubbles, composed: custom.composed, cancelable: custom.cancelable };
                custom.preventDefault();
              }, { once: true });
              const host = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } }).controllerHost;
              const returned = host.dispatch("saved", { reason: "action" });
              let invalid: { code: string | undefined; message: string } | null = null;
              try { host.dispatch("saved", { reason: "other" }); }
              catch (error) {
                const failure = error as Error & { diagnostic?: { code: string } };
                invalid = { code: failure.diagnostic?.code, message: failure.message };
              }
              return { observed, returned, invalid };
            })));
            assert.deepEqual(declared, [
              { observed: { detail: { reason: "action" }, bubbles: false, composed: false, cancelable: true }, returned: false,
                invalid: { code: "HR002", message: "HR002: Event `saved` detail does not satisfy its declared type." } },
              { observed: { detail: { reason: "action" }, bubbles: false, composed: false, cancelable: true }, returned: false,
                invalid: { code: "HR002", message: "HR002: Event `saved` detail does not satisfy its declared type." } },
            ]);
            const typedEmail = await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const host = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } }).controllerHost;
              let delivered = 0;
              document.querySelector("#case")!.addEventListener("contact", () => { delivered += 1; });
              host.dispatch("contact", "person@example.com");
              let invalid: string | undefined;
              try { host.dispatch("contact", "not an email"); }
              catch (error) { invalid = (error as Error & { diagnostic?: { code: string } }).diagnostic?.code; }
              return { delivered, invalid };
            })));
            assert.deepEqual(typedEmail, [{ delivered: 1, invalid: "HR002" }, { delivered: 1, invalid: "HR002" }]);
            const numericString = await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const host = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } }).controllerHost;
              let delivered = 0;
              document.querySelector("#case")!.addEventListener("quantity", () => { delivered += 1; });
              let invalid: string | undefined;
              try { host.dispatch("quantity", "17"); }
              catch (error) { invalid = (error as Error & { diagnostic?: { code: string } }).diagnostic?.code; }
              return { delivered, invalid };
            })));
            assert.deepEqual(numericString, [{ delivered: 0, invalid: "HR002" }, { delivered: 0, invalid: "HR002" }]);
            const separatedList = await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const root = document.querySelector("#case")!;
              let detail: unknown;
              root.addEventListener("labels", (event) => { detail = (event as CustomEvent).detail; }, { once: true });
              const delivered = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } })
                .controllerHost.dispatch("labels", "one two");
              return { detail, delivered };
            })));
            assert.deepEqual(separatedList, [{ detail: "one two", delivered: true }, { detail: "one two", delivered: true }]);
            await Promise.all([live, svelte].map((page) => page.locator("#case button").first().click()));
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
              document.querySelector("#case output")?.textContent === "1" && document.querySelector("#case")?.getAttribute("data-local") === "4")));
            await compare();
            const results = await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              new Promise<number>((resolve) => {
                const root = document.querySelector("#case")!;
                root.addEventListener("incremented", (event) => resolve((event as CustomEvent<number>).detail), { once: true });
                root.dispatchEvent(new Event("request-increment"));
              }))));
            assert.deepEqual(results, [2, 2]);
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() => document.querySelector("#case output")?.textContent === "2")));
            await compare();
            await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const globals = window as unknown as { extraEffects: number; extraValue: number;
                extraSignal: { set(value: number): void }; controllerHost: {
                  root: Element; element: Element; signal(value: number): { get(): number; set(value: number): void };
                  effect(run: () => void): () => void;
                } };
              const host = globals.controllerHost;
              if (host.element !== host.root || !Object.isFrozen(host)) throw new Error("Native host identity and immutability differ");
              globals.extraEffects = 0;
              const signal = host.signal(1);
              globals.extraSignal = signal;
              host.effect(() => { globals.extraEffects++; globals.extraValue = signal.get(); });
            })));
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
              (window as unknown as { extraEffects: number }).extraEffects === 1)));
            await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const root = document.querySelector("#case")!;
              (window as unknown as { detachedRoot: Element }).detachedRoot = root;
              root.remove();
            })));
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.disconnects === 1)));
            await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              (window as unknown as { extraSignal: { set(value: number): void } }).extraSignal.set(2);
              return new Promise<void>((resolve) => setTimeout(resolve, 0));
            })));
            assert.deepEqual(await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              (window as unknown as { extraEffects: number }).extraEffects))), [1, 1], "controller-owned effects pause during the disconnected gap");
            await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              document.querySelector("main")!.append((window as unknown as { detachedRoot: Element }).detachedRoot))));
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.connects === 2)));
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() => {
              const globals = window as unknown as { extraEffects: number; extraValue: number };
              return globals.extraEffects === 2 && globals.extraValue === 2;
            })));
            await compare();
            await Promise.all([live, svelte].map((page) => page.evaluate(() => {
              const main = document.querySelector("main")!;
              const root = document.querySelector("#case")!;
              main.append(document.createElement("span"));
              main.append(root);
            })));
            await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              new Promise<void>((resolve) => setTimeout(resolve, 0)))));
            assert.deepEqual((await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              ({ ...(window as unknown as { trace: Record<string, number> }).trace }))))).map((trace) =>
              ({ connects: trace.connects, disconnects: trace.disconnects })),
            [{ connects: 2, disconnects: 1 }, { connects: 2, disconnects: 1 }]);
            await Promise.all([
              live.evaluate(() => document.querySelector("#case")!.remove()),
              svelte.evaluate(() => (window as unknown as { svelteRoot: { unmount(): void } }).svelteRoot.unmount()),
            ]);
            await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.disconnects === 2)));
            const traces = await Promise.all([live, svelte].map((page) => page.evaluate(() => ({ ...(window as unknown as { trace: Record<string, number> }).trace }))));
            assert.deepEqual(traces[1], traces[0]);
            const cleanupRoots = await Promise.all([live, svelte].map((page) => page.evaluate(() =>
              (window as unknown as { cleanupRoot: string }).cleanupRoot)));
            assert.deepEqual(cleanupRoots, ["section", "section"]);
            assert.deepEqual(errors, []);
            assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} cleans up async controller setup after unmount`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          try {
            const live = await browser.newPage(); pages.push(live);
            const svelte = await browser.newPage(); pages.push(svelte);
            for (const page of pages) {
              await page.route("https://app.example/**", (route) => {
                const url = route.request().url();
                if (url.endsWith("/components/controlled.html")) return route.fulfill({ contentType: "text/html", body: source });
                if (url.endsWith("/components/controlled.js")) return route.fulfill({ contentType: "text/javascript", body: controller });
                return route.fulfill({ contentType: "text/html", body: page === live
                  ? '<link rel="component" href="/components/controlled.html"><main><x-controlled id="case"></x-controlled></main>'
                  : `<style>${outputs.get(mode)!.css}</style><main>${hydrate ? outputs.get(mode)!.markup : ""}</main>` });
              });
            }
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await Promise.all(pages.map((page) => page.evaluate(() => {
              const globals = window as unknown as { trace: Record<string, number>; delayController: boolean };
              globals.trace = { connects: 0, effects: 0, nestedEffects: 0, effectCleanups: 0, disconnects: 0 };
              globals.delayController = true;
            })));
            await live.addScriptTag({ path: loaderBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } })
              .HtmlNextLoader.startBrowserComponents());
            await svelte.addScriptTag({ path: outputs.get(mode)!.bundle });
            await Promise.all(pages.map((page) => page.waitForFunction(() => {
              const globals = window as unknown as { trace: Record<string, number>; releaseController?: () => void };
              return globals.trace.connects === 1 && typeof globals.releaseController === "function";
            })));
            const eventResults = await Promise.all(pages.map((page) => page.evaluate(async () =>
              Promise.race([
                new Promise<number>((resolve) => {
                  const root = document.querySelector("#case")!;
                  root.addEventListener("incremented", (event) => resolve((event as CustomEvent<number>).detail), { once: true });
                  root.dispatchEvent(new Event("request-increment"));
                }),
                new Promise<string>((resolve) => setTimeout(() => resolve("pending setup"), 500)),
              ]))));
            assert.deepEqual(eventResults, [1, 1], "registered controller events work during asynchronous initialization");
            await Promise.all([
              live.evaluate(() => document.querySelector("#case")!.remove()),
              svelte.evaluate(() => (window as unknown as { svelteRoot: { unmount(): void } }).svelteRoot.unmount()),
            ]);
            await Promise.all(pages.map((page) => page.evaluate(() =>
              (window as unknown as { releaseController(): void }).releaseController())));
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.disconnects === 1)));
            const traces = await Promise.all(pages.map((page) => page.evaluate(() =>
              ({ ...(window as unknown as { trace: Record<string, number> }).trace }))));
            assert.deepEqual(traces[1], traces[0]);
            assert.deepEqual(traces[0], { connects: 1, effects: 1, nestedEffects: 1, effectCleanups: 1, disconnects: 1 });
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
      }
    }
  }
});
