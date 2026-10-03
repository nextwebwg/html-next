import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { missingContextSource as source } from "./fixtures/context-diagnostic.js";

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Svelte converter missing-context diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<"application" | "library", string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-context-diagnostic-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "reader.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["reader.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-context-reader"]);
      const app = join(outDirectory, "App.svelte");
      await writeFile(app, `<script>import XContextReader from "./${manifest.components[0]!.artifact}";</script><XContextReader id="case" />`);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "svelte.js");
      await writeFile(entry, `import { mount, flushSync } from "svelte"; import App from "./App.svelte";
try { flushSync(() => mount(App, { target: document.querySelector("main")! })); }
catch (error) { const failure = error as Error & { diagnostic?: { code: string } };
(window as any).svelteContextDiagnostic = { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message }; }`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const renderScene = () => render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const module = await import(pathToFileURL(serverBundle).href) as { renderScene(): string };
      assert.throws(module.renderScene, (error: unknown) => {
        const failure = error as Error & { diagnostic?: { code: string } };
        return failure.name === "HtmlDiagnosticError" && failure.diagnostic?.code === "HR009" &&
          failure.message === "HR009: <x-context-reader> requires context `current` from <x-steps>.";
      });
      converted.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} reports HR009 with no provider component in the graph`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        try {
          await live.setContent(`${source}<main><x-context-reader id="case"></x-context-reader></main>`);
          await live.addScriptTag({ path: liveBundle });
          const native = await live.evaluate((): Diagnostic | null => {
            try { window.HtmlRuntime.lowerDocument(); return null; }
            catch (error) {
              const failure = error as Error & { diagnostic?: { code: string } };
              return { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message };
            }
          });
          await svelte.setContent("<main></main>");
          await svelte.addScriptTag({ path: converted.get(mode)! });
          await svelte.waitForFunction(() => window.svelteContextDiagnostic !== undefined);
          const convertedDiagnostic = await svelte.evaluate(() => window.svelteContextDiagnostic ?? null);
          assert.deepEqual(native, {
            name: "HtmlDiagnosticError", code: "HR009",
            message: "HR009: <x-context-reader> requires context `current` from <x-steps>.",
          });
          assert.deepEqual(convertedDiagnostic, native);
        } finally {
          await Promise.all([live.close(), svelte.close()]);
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    svelteContextDiagnostic?: Diagnostic;
  }
}
