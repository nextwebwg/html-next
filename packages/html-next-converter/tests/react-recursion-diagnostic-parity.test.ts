import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { recursiveDepthSource as source } from "./fixtures/recursive-depth.js";
type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };
const expected: Diagnostic = { name: "HtmlDiagnosticError", code: "HR008", message: "HR008: Component invocations nested deeper than the lowering limit." };

describe.skipIf(!enabled)("public React converter recursive lowering parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<"application" | "library", { readonly bundle: string; readonly render: (level: number) => string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-recursion-"));
    await writeFile(join(directory, "depth.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["depth.html"], root: directory, outDirectory });
      const entry = join(outDirectory, "entry.tsx");
      const bundle = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XDepth } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
createRoot(document.querySelector("main")!, { onUncaughtError(error) {
  const failure = error as Error & { diagnostic?: { code: string } };
  (window as any).reactRecursionDiagnostic = { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message };
} }).render(<XDepth id="case" level={(window as any).initialLevel} />);
`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const serverEntry = join(outDirectory, "server.tsx");
      await writeFile(serverEntry, `import React from "react";
import { renderToString } from "react-dom/server";
import { XDepth } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
export const render = (level: number) => renderToString(<XDepth id="case" level={level} />);
`);
      const serverBuild = await build({ entryPoints: [serverEntry], bundle: true, format: "cjs", platform: "node",
        write: false, packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
      const module = { exports: {} as { render(level: number): string } };
      new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      converted.set(mode, { bundle, render: module.exports.render });
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
          const react = await browser.newPage();
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
            await react.setContent("<main></main>");
            await react.evaluate((value) => { window.initialLevel = value; }, level);
            await react.addScriptTag({ path: converted.get(mode)!.bundle });
            if (level <= 1) await react.waitForFunction(() => window.reactRecursionDiagnostic !== undefined);
            else await react.locator("#case span").first().waitFor();
            const diagnostic = await react.evaluate(() => window.reactRecursionDiagnostic ?? null);
            assert.deepEqual(diagnostic, native);
            if (level > 1) {
              const read = (page: Page) => page.locator("#case span").allTextContents();
              assert.deepEqual(await read(live), Array.from({ length: 34 - level }, (_, index) => String(level + index)));
              assert.deepEqual(await read(react), await read(live));
              await assertPixelsEqual(react, await react.locator("#case").screenshot(), await live.locator("#case").screenshot(),
                "React recursive pixels differ", live);
            } else assert.deepEqual(native, expected);
          } finally {
            await Promise.all([live.close(), react.close()]);
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
    reactRecursionDiagnostic?: Diagnostic;
  }
}
