import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const browserLoaderPath = new URL("../../html-next/src/browser-loader.ts", import.meta.url).pathname;
const component = `<template component="x-controlled" status="early" summary="Controller parity." controller="./controlled.js"><defs>
  <prop name="amount" type="number" default="5">The amount.</prop>
  <state type="number" name="count" value="0"></state>
  <computed name="double" from="count * 2"></computed>
  <state name="arm" type="keyword" value="section"></state>
  <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
  <method name="focusButton" export="focusButton" returns="promise(undefined)"></method>
  <method name="loadHelper" export="loadHelper" returns="promise(number)"></method>
  <method name="missing" export="missingExport" returns="promise(undefined)"></method>
</defs><template $match>
  <article $when="arm = 'article'" $ref="articleRoot"><button type="button" $ref="button">Increment</button><output $value="count"></output></article>
  <section $else $ref="sectionRoot"><button type="button" $ref="button">Increment</button><output $value="count"></output></section>
</template></template>`;
const controller = `export default function connect(host) {
  window.trace.connects++;
  window.controllerHost = host;
  const local = host.signal(1);
  const doubled = host.computed(() => local.get() * 2);
  const stop = host.effect(() => {
    window.trace.effects++;
    host.root.setAttribute("data-local", String(doubled.get()));
    host.root.setAttribute("data-amount", String(host.props.amount.value));
    host.root.setAttribute("data-input", String(host.props.amount.inputValue));
    host.root.setAttribute("data-valid", String(host.props.amount.validity.valid));
    host.root.setAttribute("data-state-has-amount", String("amount" in host.state));
    host.root.setAttribute("data-state-has-count", String("count" in host.state));
    host.root.setAttribute("data-double", String(host.state.double));
    return () => { window.trace.effectCleanups++; };
  });
  const stopListening = host.effect(() => {
    const root = host.root;
    const onClick = (event) => {
      if (event.target !== host.refs.button) return;
      local.update((value) => value + 1);
      host.state.count += 1;
      host.state.arm = host.state.arm === "section" ? "article" : "section";
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  });
  const cleanup = () => { stop(); stopListening(); window.trace.disconnects++; };
  if (window.delayController) return new Promise((resolve) => { window.releaseController = () => resolve(cleanup); });
  return cleanup;
}
export function focusButton(host) {
  host.refs.button.focus();
  window.trace.methods++;
}
export async function loadHelper() {
  const module = await import("./helper.js");
  return module.answer;
}`;
const helper = "export const answer = 42;\n";

type Snapshot = { tag: string | null; count: string | null; local: string | null; amount: string | null; input: string | null; valid: string | null; stateHasAmount: string | null; stateHasCount: string | null; double: string | null; trace: Record<string, number>; focused: boolean };

async function snapshot(page: Page): Promise<{ behavior: Snapshot; pixels: Buffer }> {
  await page.waitForFunction(() => document.querySelector("#case")?.getAttribute("data-local") !== null);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.evaluate(() => ({
      tag: document.querySelector("#case")?.localName ?? null,
      count: document.querySelector("#case output")?.textContent ?? null,
      local: document.querySelector("#case")?.getAttribute("data-local") ?? null,
      amount: document.querySelector("#case")?.getAttribute("data-amount") ?? null,
      input: document.querySelector("#case")?.getAttribute("data-input") ?? null,
      valid: document.querySelector("#case")?.getAttribute("data-valid") ?? null,
      stateHasAmount: document.querySelector("#case")?.getAttribute("data-state-has-amount") ?? null,
      stateHasCount: document.querySelector("#case")?.getAttribute("data-state-has-count") ?? null,
      double: document.querySelector("#case")?.getAttribute("data-double") ?? null,
      trace: { ...window.trace },
      focused: document.activeElement === document.querySelector("#case button"),
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter controller parity", () => {
  let directory = "";
  let loaderBundle = "";
  let vueBundle = "";
  const hydrationOutputs = new Map<"application" | "library", { readonly bundle: string; readonly markup: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-controller-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "controlled.html"), component);
    await writeFile(join(directory, "components", "controlled.js"), controller);
    await writeFile(join(directory, "components", "helper.js"), helper);
    loaderBundle = join(directory, "loader.js");
    await build({ entryPoints: [browserLoaderPath], outfile: loaderBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const output = join(directory, `generated-${mode}`);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/controlled.html"], root: directory, outDirectory: output });
      assert.ok(manifest.components[0]?.controller?.endsWith("controlled.js"));
      assert.ok(manifest.output.artifacts.some((artifact) => artifact.kind === "controller" && artifact.path.endsWith("/helper.js")));
      const vuePath = join(output, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(vuePath, "utf8"), { filename: vuePath });
      assert.deepEqual(parsed.errors, []);
      await writeFile(vuePath.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `controller-parity-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `controller-parity-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: vuePath,
        id: `controller-parity-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(serverTemplate.errors, []);
      await writeFile(vuePath.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      if (mode === "application") {
        const entry = join(output, "entry.ts");
        vueBundle = join(output, "vue.js");
        await writeFile(entry, `import { createApp, h, ref } from "vue";
import XControlled from "./vue/XControlled";
window.trace = { connects: 0, effects: 0, effectCleanups: 0, methods: 0, disconnects: 0 };
window.delayController = location.search.includes("delay");
const controlled = ref(null);
window.vueApp = createApp({ render: () => h(XControlled, { id: "case", ref: controlled }) });
window.vueMethod = () => controlled.value.focusButton();
window.vueLoadHelper = () => controlled.value.loadHelper();
window.vueMissingMethod = () => controlled.value.missing();
window.vueApp.mount(document.querySelector("main"));\n`);
        await build({ entryPoints: [entry], outfile: vueBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath] });
      }
      const hydrateEntry = join(output, "hydrate.ts");
      const hydrateBundle = join(output, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XControlled } from "./vue/${mode === "application" ? "application" : "index"}";
window.trace = { connects: 0, effects: 0, effectCleanups: 0, methods: 0, disconnects: 0 };
window.delayController = false;
window.vueApp = createSSRApp({ render: () => h(XControlled, { id: "case" }) });
window.vueApp.mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrateBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(output, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XControlled } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => h(XControlled, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const markup = await serverModule.render() as string;
      assert.match(markup, /<section[^>]*id="case"/);
      hydrationOutputs.set(mode, { bundle: hydrateBundle, markup });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [name, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
    it(`${name} ${mode} starts the controller once on hydration and cleans it up on unmount`, async () => {
      const browser = await launchParityBrowser(browserType);
      const [live, hydrated] = await Promise.all([browser.newPage(), browser.newPage()]);
      const errors: string[] = [];
      const warnings: string[] = [];
      try {
        for (const page of [live, hydrated]) {
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("https://app.example/**", async (route) => {
            const url = route.request().url();
            if (url.endsWith("/components/controlled.html")) await route.fulfill({ contentType: "text/html", body: component });
            else if (url.endsWith("/components/controlled.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
            else if (url.endsWith("/components/helper.js")) await route.fulfill({ contentType: "text/javascript", body: helper });
            else await route.fulfill({ contentType: "text/html", body: page === live
              ? `<link rel="component" href="/components/controlled.html"><main><x-controlled id="case"></x-controlled></main>`
              : `<main>${hydrationOutputs.get(mode)!.markup}</main>` });
          });
        }
        hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
        await Promise.all([live.goto("https://app.example/live"), hydrated.goto("https://app.example/hydrated")]);
        await live.evaluate(() => { window.trace = { connects: 0, effects: 0, effectCleanups: 0, methods: 0, disconnects: 0 }; });
        await live.addScriptTag({ path: loaderBundle });
        await live.evaluate(() => window.HtmlNextLoader.startBrowserComponents());
        await hydrated.addScriptTag({ path: hydrationOutputs.get(mode)!.bundle });
        await Promise.all([live, hydrated].map((page) => page.waitForFunction(() => window.trace.effects === 1)));
        const [initialLive, initialHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
        assert.deepEqual(initialHydrated.behavior, initialLive.behavior, "hydrated controller behavior differs");
        await assertPixelsEqual(hydrated, initialHydrated.pixels, initialLive.pixels, "hydrated controller pixels differ");
        assert.equal(initialLive.behavior.trace.connects, 1);

        await Promise.all([live, hydrated].map((page) => page.locator("#case button").focus()));
        await Promise.all([live, hydrated].map((page) => page.locator("#case button").press("Enter")));
        await Promise.all([live, hydrated].map((page) => page.waitForFunction(() =>
          document.querySelector("#case output")?.textContent === "1" && document.querySelector("#case")?.getAttribute("data-local") === "4")));
        const [updatedLive, updatedHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
        assert.deepEqual(updatedHydrated.behavior, updatedLive.behavior, "hydrated controller update differs");
        await assertPixelsEqual(hydrated, updatedHydrated.pixels, updatedLive.pixels, "hydrated controller update pixels differ");

        await Promise.all([
          live.evaluate(() => document.querySelector("#case")?.remove()),
          hydrated.evaluate(() => window.vueApp.unmount()),
        ]);
        await Promise.all([live, hydrated].map((page) => page.waitForFunction(() => window.trace.disconnects === 1)));
        const [liveTrace, hydratedTrace] = await Promise.all([live, hydrated].map((page) => page.evaluate(() => ({ ...window.trace }))));
        assert.deepEqual(hydratedTrace, liveTrace, "hydrated controller cleanup differs");
        assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
        assert.deepEqual(errors, []);
      } finally {
        await Promise.all([live.close(), hydrated.close()]);
        await browser.close();
      }
    });
    }

    it(`${name} matches state, effects, methods, and disconnect cleanup`, async () => {
      const browser = await launchParityBrowser(browserType);
      const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
      const errors: string[] = [];
      try {
        for (const page of [live, vue]) {
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("https://app.example/**", async (route) => {
            const url = route.request().url();
            if (url.endsWith("/components/controlled.html")) await route.fulfill({ contentType: "text/html", body: component });
            else if (url.endsWith("/components/controlled.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
            else if (url.endsWith("/components/helper.js")) await route.fulfill({ contentType: "text/javascript", body: helper });
            else await route.fulfill({ contentType: "text/html", body: page === live
              ? `<link rel="component" href="/components/controlled.html"><main><x-controlled id="case"></x-controlled></main>`
              : "<main></main>" });
          });
        }
        await Promise.all([live.goto("https://app.example/live"), vue.goto("https://app.example/vue")]);
        await live.evaluate(() => { window.trace = { connects: 0, effects: 0, effectCleanups: 0, methods: 0, disconnects: 0 }; });
        await live.addScriptTag({ path: loaderBundle });
        await live.evaluate(() => window.HtmlNextLoader.startBrowserComponents());
        await vue.addScriptTag({ path: vueBundle });
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => window.trace.effects === 1)));
        const [initialLive, initialVue] = await Promise.all([snapshot(live), snapshot(vue)]);
        assert.deepEqual(initialVue.behavior, initialLive.behavior, "initial controller behavior differs");
        assert.deepEqual({ amount: initialVue.behavior.amount, input: initialVue.behavior.input, valid: initialVue.behavior.valid },
          { amount: "5", input: "null", valid: "true" }, "defaulted prop handle differs");
        assert.deepEqual({ amount: initialVue.behavior.stateHasAmount, count: initialVue.behavior.stateHasCount },
          { amount: "false", count: "true" }, "controller prop and state namespaces overlap");
        assert.equal(initialVue.behavior.double, "0", "derived state is unavailable to the controller");
        await assertPixelsEqual(vue, initialVue.pixels, initialLive.pixels, "initial controller pixels differ");

        await Promise.all([live, vue].map((page) => page.locator("#case button").focus()));
        await Promise.all([live, vue].map((page) => page.locator("#case button").press("Enter")));
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => document.querySelector("#case output")?.textContent === "1" && document.querySelector("#case")?.getAttribute("data-local") === "4")));
        const [switchedLive, switchedVue] = await Promise.all([snapshot(live), snapshot(vue)]);
        assert.equal(switchedLive.behavior.focused, true, "live root switch lost focus");
        assert.equal(switchedVue.behavior.focused, true, "Vue root switch lost focus");
        await Promise.all([live.evaluate(() => (document.querySelector("#case") as Element & { focusButton(): Promise<void> }).focusButton()), vue.evaluate(() => window.vueMethod())]);
        const [afterLive, afterVue] = await Promise.all([snapshot(live), snapshot(vue)]);
        assert.deepEqual(afterVue.behavior, afterLive.behavior, "updated controller behavior differs");
        await assertPixelsEqual(vue, afterVue.pixels, afterLive.pixels, "updated controller pixels differ");
        assert.equal(afterLive.behavior.tag, "article");
        const [liveHelper, vueHelper] = await Promise.all([
          live.evaluate(() => (document.querySelector("#case") as Element & { loadHelper(): Promise<number> }).loadHelper()),
          vue.evaluate(() => window.vueLoadHelper()),
        ]);
        assert.equal(liveHelper, 42);
        assert.equal(vueHelper, liveHelper, "relative dynamic controller import differs");
        const missingMethod = async (page: Page, vueCall: boolean) => page.evaluate(async (converted) => {
          try {
            if (converted) await window.vueMissingMethod();
            else await (document.querySelector("#case") as Element & { missing(): Promise<void> }).missing();
            return null;
          } catch (error) {
            const failure = error as Error & { diagnostic?: { code: string } };
            return { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message };
          }
        }, vueCall);
        const [liveMissing, vueMissing] = await Promise.all([missingMethod(live, false), missingMethod(vue, true)]);
        assert.deepEqual(liveMissing, {
          name: "HtmlDiagnosticError", code: "HJ003", message: "HJ003: Controller does not export method `missingExport`.",
        });
        assert.deepEqual(vueMissing, liveMissing, "missing controller export diagnostic differs");

        await Promise.all([live, vue].map((page) => page.locator("#case button").click()));
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => document.querySelector("#case output")?.textContent === "2" && document.querySelector("#case")?.localName === "section")));
        const [roundTripLive, roundTripVue] = await Promise.all([snapshot(live), snapshot(vue)]);
        assert.deepEqual(roundTripVue.behavior, roundTripLive.behavior, "root switch-back controller behavior differs");
        await assertPixelsEqual(vue, roundTripVue.pixels, roundTripLive.pixels, "root switch-back controller pixels differ");

        const dispatchProbe = async (page: Page) => page.evaluate(() => {
          const root = document.querySelector("#case")!;
          const received: unknown[] = [];
          let parentEvents = 0;
          root.parentElement!.addEventListener("saved", () => { parentEvents += 1; });
          root.addEventListener("saved", (event) => {
            event.preventDefault();
            received.push({
              detail: (event as CustomEvent).detail,
              bubbles: event.bubbles,
              composed: event.composed,
              cancelable: event.cancelable,
              prevented: event.defaultPrevented,
            });
          });
          const returned = window.controllerHost.dispatch("saved", 7);
          let invalid: { name: string; message: string; code: string | null } | null = null;
          try { window.controllerHost.dispatch("saved", "bad"); }
          catch (error) {
            const failure = error as Error & { diagnostic?: { code: string } };
            invalid = { name: failure.name, message: failure.message, code: failure.diagnostic?.code ?? null };
          }
          return { returned, received, parentEvents, invalid };
        });
        const [liveDispatch, vueDispatch] = await Promise.all([dispatchProbe(live), dispatchProbe(vue)]);
        assert.deepEqual(liveDispatch, {
          returned: false,
          received: [{ detail: 7, bubbles: false, composed: false, cancelable: true, prevented: true }],
          parentEvents: 0,
          invalid: { name: "HtmlDiagnosticError", message: "HR002: Event `saved` detail does not satisfy its declared type.", code: "HR002" },
        });
        assert.deepEqual(vueDispatch, liveDispatch, "controller event dispatch differs");

        await Promise.all([live, vue].map((page) => page.evaluate(() => {
          window.detachedControllerRoot = document.querySelector("#case")!;
          window.detachedControllerRoot.remove();
        })));
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => window.trace.disconnects === 1, undefined, { timeout: 3000 })));
        const [detachedLive, detachedVue] = await Promise.all([live, vue].map((page) => page.evaluate(() => ({ ...window.trace }))));
        assert.deepEqual(detachedVue, detachedLive, "external DOM removal cleanup differs");
        await Promise.all([live, vue].map((page) => page.evaluate(() => document.querySelector("main")!.append(window.detachedControllerRoot))));
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => window.trace.connects === 2 && document.querySelector("#case") === window.detachedControllerRoot)));
        const [reconnectedLive, reconnectedVue] = await Promise.all([snapshot(live), snapshot(vue)]);
        assert.deepEqual(reconnectedVue.behavior, reconnectedLive.behavior, "external DOM reinsertion controller behavior differs");
        await assertPixelsEqual(vue, reconnectedVue.pixels, reconnectedLive.pixels, "external DOM reinsertion controller pixels differ", live);
        await Promise.all([live, vue].map((page) => page.evaluate(() => {
          const main = document.querySelector("main")!;
          main.append(document.createElement("aside"));
          main.append(window.detachedControllerRoot);
        })));
        await Promise.all([live, vue].map((page) => page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))));
        const [movedLive, movedVue] = await Promise.all([
          live.evaluate(() => ({ ...window.trace })),
          vue.evaluate(() => ({ ...window.trace })),
        ]);
        assert.equal(movedLive.connects, 2, "an in-tree move restarted the live controller");
        assert.equal(movedLive.disconnects, 1, "an in-tree move disposed the live controller");
        assert.deepEqual(movedVue, movedLive, "an in-tree move changed the Vue controller connection");

        await Promise.all([live.evaluate(() => document.querySelector("#case")?.remove()), vue.evaluate(() => window.vueApp.unmount())]);
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => window.trace.disconnects === 2)));
        const [liveTrace, vueTrace] = await Promise.all([live, vue].map((page) => page.evaluate(() => ({ ...window.trace }))));
        assert.deepEqual(vueTrace, liveTrace, "controller cleanup differs");
        assert.deepEqual(errors, []);
      } finally {
        await Promise.all([live.close(), vue.close()]);
        await browser.close();
      }
    });

    it(`${name} cleans up a controller that finishes setup after unmount`, async () => {
      const browser = await launchParityBrowser(browserType);
      const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
      try {
        for (const page of [live, vue]) {
          await page.route("https://app.example/**", async (route) => {
            const url = route.request().url();
            if (url.endsWith("/components/controlled.html")) await route.fulfill({ contentType: "text/html", body: component });
            else if (url.endsWith("/components/controlled.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
            else await route.fulfill({ contentType: "text/html", body: page === live
              ? `<link rel="component" href="/components/controlled.html"><main><x-controlled id="case"></x-controlled></main>`
              : "<main></main>" });
          });
        }
        await Promise.all([live.goto("https://app.example/live?delay"), vue.goto("https://app.example/vue?delay")]);
        await live.evaluate(() => {
          window.trace = { connects: 0, effects: 0, effectCleanups: 0, methods: 0, disconnects: 0 };
          window.delayController = true;
        });
        await live.addScriptTag({ path: loaderBundle });
        await live.evaluate(() => window.HtmlNextLoader.startBrowserComponents());
        await vue.addScriptTag({ path: vueBundle });
        await Promise.all([live, vue].map((page) => page.waitForFunction(() => window.trace.connects === 1 && typeof window.releaseController === "function")));
        await Promise.all([live.evaluate(() => document.querySelector("#case")?.remove()), vue.evaluate(() => window.vueApp.unmount())]);
        await Promise.all([live, vue].map((page) => page.evaluate(() => window.releaseController())));
        await live.waitForFunction(() => window.trace.disconnects === 1);
        const [liveTrace, vueTrace] = await Promise.all([live, vue].map((page) => page.evaluate(() => ({ ...window.trace }))));
        assert.deepEqual(vueTrace, liveTrace, "late controller cleanup differs");
      } finally {
        await Promise.all([live.close(), vue.close()]);
        await browser.close();
      }
    });
  }
});

declare global {
  interface Window {
    trace: { connects: number; effects: number; effectCleanups: number; methods: number; disconnects: number };
    HtmlNextLoader: { startBrowserComponents(): Promise<unknown> };
    vueApp: { unmount(): void };
    vueMethod: () => Promise<void>;
    vueLoadHelper: () => Promise<number>;
    vueMissingMethod: () => Promise<void>;
    delayController: boolean;
    releaseController: () => void;
    controllerHost: { dispatch(event: string, detail?: unknown): boolean };
    detachedControllerRoot: Element;
  }
}
