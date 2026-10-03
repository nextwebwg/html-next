import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { controllerDiagnosticCases as cases } from "./fixtures/controller-diagnostics.js";

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string; readonly source: string | null };

describe.skipIf(!enabled)("public Svelte converter controller module diagnostic parity", () => {
  let directory = "";
  let loaderBundle = "";
  const converted = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-controller-errors-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    loaderBundle = join(directory, "loader.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: loaderBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const testCase of cases) {
      const root = join(directory, testCase.tag);
      await mkdir(join(root, "components"), { recursive: true });
      await writeFile(join(root, "components", "bad.html"), testCase.source);
      await writeFile(join(root, "components", "bad.js"), testCase.controller);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(root, mode);
        const manifest = await convertComponents({ mode, target: "svelte", entries: ["components/bad.html"], root,
          outDirectory, publicRootURL: "https://app.example/" });
        const app = join(outDirectory, "App.svelte");
        await writeFile(app, `<script>import Component from "./${manifest.components[0]!.artifact}";</script><Component id="case" />`);
        const entry = join(outDirectory, "entry.ts");
        const bundle = join(outDirectory, "svelte.js");
        await writeFile(entry, `import { mount } from "svelte"; import App from "./App.svelte"; mount(App, { target: document.querySelector("main")! });`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
        converted.set(`${testCase.tag}:${mode}`, bundle);
      }
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const testCase of cases) {
    for (const mode of ["application", "library"] as const) {
      for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
        it(`${engine} ${mode} preserves the root and reports ${testCase.code}`, async () => {
          const browser = await launchParityBrowser(browserType);
          const live = await browser.newPage();
          const svelte = await browser.newPage();
          try {
            for (const page of [live, svelte]) await page.route("https://app.example/**", async (route) => {
              const url = route.request().url();
              if (url.endsWith("/components/bad.html")) await route.fulfill({ contentType: "text/html", body: testCase.source });
              else if (url.endsWith("/components/bad.js")) await route.fulfill({ contentType: "text/javascript", body: testCase.controller });
              else await route.fulfill({ contentType: "text/html", body: page === live
                ? `<link rel="component" href="/components/bad.html"><main><${testCase.tag} id="case"></${testCase.tag}></main>`
                : "<main></main>" });
            });
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await svelte.evaluate(() => window.addEventListener("error", (event) => {
              const failure = event.error as Error & { diagnostic?: { code?: string; source?: string } } | undefined;
              if (failure !== undefined) {
                window.svelteModuleDiagnostic = { name: failure.name, code: failure.diagnostic?.code ?? null,
                  message: failure.message, source: failure.diagnostic?.source ?? null };
                (window.svelteModuleDiagnostics ??= []).push(window.svelteModuleDiagnostic);
              }
            }));
            await live.addScriptTag({ path: loaderBundle });
            await live.evaluate(() => (window.HtmlNextLoader as typeof window.HtmlNextLoader & {
              startBrowserComponents(root: Document, options: { onError(error: unknown): void }): Promise<unknown>;
            }).startBrowserComponents(document, {
              onError(error: unknown) {
                const failure = error as Error & { diagnostic?: { code?: string; source?: string } };
                window.liveModuleDiagnostic = { name: failure.name, code: failure.diagnostic?.code ?? null,
                  message: failure.message, source: failure.diagnostic?.source ?? null };
                (window.liveModuleDiagnostics ??= []).push(window.liveModuleDiagnostic);
              },
            }));
            await svelte.addScriptTag({ path: converted.get(`${testCase.tag}:${mode}`)! });
            await live.waitForFunction(() => window.liveModuleDiagnostic !== undefined);
            await svelte.waitForFunction(() => window.svelteModuleDiagnostic !== undefined);
            const expected: Diagnostic = { name: "HtmlDiagnosticError", code: testCase.code,
              message: `https://app.example/components/bad.html: ${testCase.code}: ${testCase.message}`,
              source: "https://app.example/components/bad.html" };
            assert.deepEqual(await live.evaluate(() => window.liveModuleDiagnostic), expected);
            assert.deepEqual(await svelte.evaluate(() => window.svelteModuleDiagnostic), expected);
            assert.equal((await live.locator("#case").textContent())?.trim(), "Ready");
            assert.equal((await svelte.locator("#case").textContent())?.trim(), "Ready");
            await assertPixelsEqual(svelte, await svelte.locator("#case").screenshot(), await live.locator("#case").screenshot(),
              "Svelte controller-error pixels differ", live);
            for (const page of [live, svelte]) await page.evaluate(() => {
              window.detachedModuleRoot = document.querySelector("#case")!;
              window.detachedModuleRoot.remove();
            });
            await Promise.all([live, svelte].map((page) => page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))));
            for (const page of [live, svelte]) await page.evaluate(() => document.querySelector("main")!.append(window.detachedModuleRoot));
            await live.waitForFunction(() => window.liveModuleDiagnostics?.length === 2);
            await svelte.waitForFunction(() => window.svelteModuleDiagnostics?.length === 2);
            assert.deepEqual(await live.evaluate(() => window.liveModuleDiagnostics), [expected, expected]);
            assert.deepEqual(await svelte.evaluate(() => window.svelteModuleDiagnostics), [expected, expected]);
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
    liveModuleDiagnostic?: Diagnostic;
    svelteModuleDiagnostic?: Diagnostic;
    liveModuleDiagnostics?: Diagnostic[];
    svelteModuleDiagnostics?: Diagnostic[];
    detachedModuleRoot: Element;
  }
}
