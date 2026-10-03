import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { recursiveDepthSource as source } from "./fixtures/recursive-depth.js";
type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };
const expected: Diagnostic = { name: "HtmlDiagnosticError", code: "HR008", message: "HR008: Component invocations nested deeper than the lowering limit." };

describe.skipIf(!enabled)("public Svelte converter recursive lowering parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<"application" | "library", { readonly bundle: string; readonly render: (level: number) => string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-recursion-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "depth.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["depth.html"], root: directory, outDirectory });
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "svelte.js");
      await writeFile(entry, `import { mount, flushSync } from "svelte";
import { XDepth } from "./${manifest.output.entry}";
try { flushSync(() => mount(XDepth, { target: document.querySelector("main")!, props: { id: "case", level: window.initialLevel } })); }
catch (error) { window.svelteRecursionDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message }; }`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server";
import { XDepth } from "./${manifest.output.entry}";
export const markup = (level: number) => render(XDepth, { props: { id: "case", level } }).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const module = await import(pathToFileURL(serverBundle).href) as { markup(level: number): string };
      converted.set(mode, { bundle, render: (level) => module.markup(level).replace(/<!--[\s\S]*?-->/g, "") });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    it(`${mode} SSR enforces the recursive lowering limit`, () => {
      const render = converted.get(mode)!.render;
      assert.deepEqual([...render(2).matchAll(/<span>(\d+)<\/span>/g)].map((match) => match[1]),
        Array.from({ length: 32 }, (_, index) => String(index + 2)));
      assert.throws(() => render(1), (error: unknown) => {
        const failure = error as Error & { diagnostic?: { code: string } };
        assert.deepEqual({ name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message }, expected);
        return true;
      });
    });
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const level of [31, 2, 1, 0] as const) {
        it(`${engine} ${mode} ${level <= 1 ? `reports HR008 from level ${level}` : `renders recursion from level ${level}`}`, async () => {
          const browser = await launchParityBrowser(browserType);
          const live = await browser.newPage();
          const svelte = await browser.newPage();
          try {
            await live.setContent(`${source}<main><x-depth id="case" level="${level}"></x-depth></main>`);
            await live.addScriptTag({ path: liveBundle });
            const native = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const failure = error as Error & { diagnostic?: { code: string } };
                return { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message };
              }
            });
            await svelte.setContent("<main></main>");
            await svelte.evaluate((value) => { window.initialLevel = value; }, level);
            await svelte.addScriptTag({ path: converted.get(mode)!.bundle });
            if (level <= 1) await svelte.waitForFunction(() => window.svelteRecursionDiagnostic !== undefined);
            else await svelte.locator("#case span").first().waitFor();
            const diagnostic = await svelte.evaluate(() => window.svelteRecursionDiagnostic ?? null);
            assert.deepEqual(diagnostic, native);
            if (level > 1) {
              const read = (page: Page) => page.locator("#case span").allTextContents();
              assert.deepEqual(await read(live), Array.from({ length: 34 - level }, (_, index) => String(level + index)));
              assert.deepEqual(await read(svelte), await read(live));
              await assertPixelsEqual(svelte, await svelte.locator("#case").screenshot(), await live.locator("#case").screenshot(),
                "Svelte recursive pixels differ", live);
            } else assert.deepEqual(native, expected);
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
    initialLevel: number;
    svelteRecursionDiagnostic?: Diagnostic;
  }
}
