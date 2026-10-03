import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-controlled" status="early" summary="Controller parity." controller="./controlled.js"><defs>
  <prop name="amount" type="number" default="5">Controller prop.</prop>
  <state type="number" name="count" value="0"></state>
  <event name="saved" type="object" bubbles="false" composed="false" cancelable="true"><prop name="reason" type="keyword" values="action, programmatic" required></prop></event>
  <event name="contact" type="email"></event>
  <event name="quantity" type="number"></event>
  <event name="labels" type="keyword+"></event>
  <method name="increment" export="increment" returns="promise(number)"></method>
  <method name="missing" export="missingExport" returns="promise(undefined)"></method>
</defs><section><button type="button" $ref="button">Increment</button><output $value="count"></output></section>
<style>:host { display: block; width: 180px; padding: 4px; background: rgb(240 245 250); font: 16px/24px Arial, sans-serif; }</style></template>`;
const controller = `export default function connect(host) {
  window.trace.connects++;
  window.controllerHost = host;
  const local = host.signal(1);
  const doubled = host.computed(() => local.get() * 2);
  const stopDisplay = host.effect(() => {
    window.trace.effects++;
    host.root.setAttribute("data-local", String(doubled.get()));
    return () => { window.trace.effectCleanups++; };
  });
  const stopProp = host.effect(() => {
    host.root.setAttribute("data-amount-value", String(host.props.amount.value));
    host.root.setAttribute("data-amount-input", String(host.props.amount.inputValue));
    host.root.setAttribute("data-amount-valid", String(host.props.amount.validate().valid));
    host.root.setAttribute("data-state-has-amount", String("amount" in host.state));
  });
  const stopClick = host.effect(() => {
    const button = host.refs.button;
    const click = () => { local.update((value) => value + 1); host.state.count += 1; };
    button.addEventListener("click", click);
    return () => button.removeEventListener("click", click);
  });
  const cleanup = () => { window.cleanupRoot = host.root.localName; stopDisplay(); stopProp(); stopClick(); window.trace.disconnects++; };
  if (window.delayController) return new Promise((resolve) => { window.releaseController = () => resolve(cleanup); });
  return cleanup;
}
export async function increment(host) { host.state.count += 1; return host.state.count; }`;

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

describe.skipIf(!enabled)("React controller parity", () => {
  let directory = "";
  let loaderBundle = "";
  const outputs = new Map<"application" | "library", { readonly bundle: string; readonly markup: string; readonly css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-controller-"));
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
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory,
        entries: ["components/**"], publicRootURL: "/app/" });
      try {
        await promisify(execFile)(fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)), [
          "--noEmit", "--jsx", "react-jsx", "--module", "preserve", "--moduleResolution", "bundler",
          "--target", "ES2022", "--allowJs", "--skipLibCheck", "--strict",
          join(outDirectory, manifest.components[0]!.artifact),
        ], { cwd: directory });
      } catch (error) {
        assert.fail((error as Error & { stdout?: string }).stdout ?? String(error));
      }
      assert.ok(manifest.output.artifacts.some((artifact) => artifact.kind === "controller" && artifact.path.endsWith("controlled.js")));
      assert.ok(manifest.output.artifacts.some((artifact) => artifact.kind === "helper" && artifact.path === "react/host.ts"));
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const mountEntry = join(outDirectory, "mount.tsx");
      await writeFile(mountEntry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XControlled } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
const container = document.querySelector("main")!;
const element = <XControlled id="case" />;
const hydrating = container.hasChildNodes();
const root = hydrating ? hydrateRoot(container, element) : createRoot(container);
if (!hydrating) root.render(element);
(window as any).reactRoot = root;
(window as any).reactSetAmount = (amount: unknown) => root.render(<XControlled id="case" amount={amount as number} />);`);
      const bundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [mountEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const markup = renderToString(createElement(module.exports.XControlled!, { id: "case" }));
      assert.match(markup, /<section[^>]*id="case"/);
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} matches controller effects, methods, and cleanup`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          const errors: string[] = [];
          const warnings: string[] = [];
          try {
            const live = await browser.newPage();
            pages.push(live);
            const react = await browser.newPage();
            pages.push(react);
            react.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
            for (const page of [live, react]) {
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
            await Promise.all([live.goto("https://app.example/live"), react.goto("https://app.example/react")]);
            await live.evaluate(() => { (window as unknown as { trace: Record<string, number> }).trace = { connects: 0, effects: 0, effectCleanups: 0, disconnects: 0 }; });
            await react.evaluate(() => { (window as unknown as { trace: Record<string, number> }).trace = { connects: 0, effects: 0, effectCleanups: 0, disconnects: 0 }; });
            await live.addScriptTag({ path: loaderBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): void } }).HtmlNextLoader.startBrowserComponents());
            await react.addScriptTag({ path: outputs.get(mode)!.bundle });
            await Promise.all([live, react].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.effects === 1)));
            const compare = async () => {
              const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
              assert.deepEqual(converted.behavior, native.behavior);
              await assertPixelsEqual(react, converted.pixels, native.pixels, "React controller pixels differ", live);
            };
            await compare();
            for (const amount of [2, "bad", 7] as const) {
              await live.evaluate((value) => (window as unknown as { HtmlNextLoader: {
                updateComponentProps(element: Element, props: Record<string, unknown>): void;
              } }).HtmlNextLoader.updateComponentProps(document.querySelector("#case")!, { amount: value }), amount);
              await react.evaluate((value) => (window as unknown as { reactSetAmount(value: unknown): void }).reactSetAmount(value), amount);
              await Promise.all([live, react].map((page) => page.waitForFunction((value) =>
                document.querySelector("#case")?.getAttribute("data-amount-input") === String(value), amount)));
              await compare();
            }
            const undeclared = await Promise.all([live, react].map((page) => page.evaluate(() => {
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
            const declared = await Promise.all([live, react].map((page) => page.evaluate(() => {
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
            const typedEmail = await Promise.all([live, react].map((page) => page.evaluate(() => {
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
            const numericString = await Promise.all([live, react].map((page) => page.evaluate(() => {
              const host = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } }).controllerHost;
              let delivered = 0;
              document.querySelector("#case")!.addEventListener("quantity", () => { delivered += 1; });
              let invalid: string | undefined;
              try { host.dispatch("quantity", "17"); }
              catch (error) { invalid = (error as Error & { diagnostic?: { code: string } }).diagnostic?.code; }
              return { delivered, invalid };
            })));
            assert.deepEqual(numericString, [{ delivered: 0, invalid: "HR002" }, { delivered: 0, invalid: "HR002" }]);
            const separatedList = await Promise.all([live, react].map((page) => page.evaluate(() => {
              const root = document.querySelector("#case")!;
              let detail: unknown;
              root.addEventListener("labels", (event) => { detail = (event as CustomEvent).detail; }, { once: true });
              const delivered = (window as unknown as { controllerHost: { dispatch(name: string, detail: unknown): boolean } })
                .controllerHost.dispatch("labels", "one two");
              return { detail, delivered };
            })));
            assert.deepEqual(separatedList, [{ detail: "one two", delivered: true }, { detail: "one two", delivered: true }]);
            await Promise.all([live, react].map((page) => page.locator("#case button").click()));
            await Promise.all([live, react].map((page) => page.waitForFunction(() =>
              document.querySelector("#case output")?.textContent === "1" && document.querySelector("#case")?.getAttribute("data-local") === "4")));
            await compare();
            const results = await Promise.all([live, react].map((page) => page.evaluate(() =>
              (document.querySelector("#case") as Element & { increment(): Promise<number> }).increment())));
            assert.deepEqual(results, [2, 2]);
            await Promise.all([live, react].map((page) => page.waitForFunction(() => document.querySelector("#case output")?.textContent === "2")));
            await compare();
            const failures = await Promise.all([live, react].map((page) => page.evaluate(async () => {
              try { await (document.querySelector("#case") as Element & { missing(): Promise<void> }).missing(); return null; }
              catch (error) { const failure = error as Error & { diagnostic?: { code: string } }; return { code: failure.diagnostic?.code, message: failure.message }; }
            })));
            assert.deepEqual(failures, [
              { code: "HJ003", message: "HJ003: Controller does not export method `missingExport`." },
              { code: "HJ003", message: "HJ003: Controller does not export method `missingExport`." },
            ]);
            await Promise.all([live, react].map((page) => page.evaluate(() => {
              const root = document.querySelector("#case")!;
              (window as unknown as { detachedRoot: Element }).detachedRoot = root;
              root.remove();
            })));
            await Promise.all([live, react].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.disconnects === 1)));
            await Promise.all([live, react].map((page) => page.evaluate(() =>
              document.querySelector("main")!.append((window as unknown as { detachedRoot: Element }).detachedRoot))));
            await Promise.all([live, react].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.connects === 2)));
            await compare();
            await Promise.all([live, react].map((page) => page.evaluate(() => {
              const main = document.querySelector("main")!;
              const root = document.querySelector("#case")!;
              main.append(document.createElement("span"));
              main.append(root);
            })));
            await Promise.all([live, react].map((page) => page.evaluate(() =>
              new Promise<void>((resolve) => setTimeout(resolve, 0)))));
            assert.deepEqual((await Promise.all([live, react].map((page) => page.evaluate(() =>
              ({ ...(window as unknown as { trace: Record<string, number> }).trace }))))).map((trace) =>
              ({ connects: trace.connects, disconnects: trace.disconnects })),
            [{ connects: 2, disconnects: 1 }, { connects: 2, disconnects: 1 }]);
            await Promise.all([
              live.evaluate(() => document.querySelector("#case")!.remove()),
              react.evaluate(() => (window as unknown as { reactRoot: { unmount(): void } }).reactRoot.unmount()),
            ]);
            await Promise.all([live, react].map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.disconnects === 2)));
            const traces = await Promise.all([live, react].map((page) => page.evaluate(() => ({ ...(window as unknown as { trace: Record<string, number> }).trace }))));
            assert.deepEqual(traces[1], traces[0]);
            const cleanupRoots = await Promise.all([live, react].map((page) => page.evaluate(() =>
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
            const react = await browser.newPage(); pages.push(react);
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
            await Promise.all([live.goto("https://app.example/live"), react.goto("https://app.example/react")]);
            await Promise.all(pages.map((page) => page.evaluate(() => {
              const globals = window as unknown as { trace: Record<string, number>; delayController: boolean };
              globals.trace = { connects: 0, effects: 0, effectCleanups: 0, disconnects: 0 };
              globals.delayController = true;
            })));
            await live.addScriptTag({ path: loaderBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } })
              .HtmlNextLoader.startBrowserComponents());
            await react.addScriptTag({ path: outputs.get(mode)!.bundle });
            await Promise.all(pages.map((page) => page.waitForFunction(() => {
              const globals = window as unknown as { trace: Record<string, number>; releaseController?: () => void };
              return globals.trace.connects === 1 && typeof globals.releaseController === "function";
            })));
            await Promise.all([
              live.evaluate(() => document.querySelector("#case")!.remove()),
              react.evaluate(() => (window as unknown as { reactRoot: { unmount(): void } }).reactRoot.unmount()),
            ]);
            await Promise.all(pages.map((page) => page.evaluate(() =>
              (window as unknown as { releaseController(): void }).releaseController())));
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (window as unknown as { trace: Record<string, number> }).trace.disconnects === 1)));
            const traces = await Promise.all(pages.map((page) => page.evaluate(() =>
              ({ ...(window as unknown as { trace: Record<string, number> }).trace }))));
            assert.deepEqual(traces[1], traces[0]);
            assert.deepEqual(traces[0], { connects: 1, effects: 1, effectCleanups: 1, disconnects: 1 });
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
      }
    }
  }
});
