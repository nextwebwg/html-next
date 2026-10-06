import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { missingContextSource as source } from "./fixtures/context-diagnostic.js";

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public React converter missing-context diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<"application" | "library", string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-context-diagnostic-"));
    await writeFile(join(directory, "reader.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["reader.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-context-reader"]);
      const entry = join(outDirectory, "entry.tsx");
      const bundle = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XContextReader } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
createRoot(document.querySelector("main")!, { onUncaughtError(error) {
  const failure = error as Error & { diagnostic?: { code: string } };
  (window as any).reactContextDiagnostic = { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message };
} }).render(<XContextReader id="case" />);
`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const serverEntry = join(outDirectory, "server.tsx");
      await writeFile(serverEntry, `import React from "react";
import { renderToString } from "react-dom/server";
import { XContextReader } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
export const render = () => renderToString(<XContextReader id="case" />);
`);
      const serverBuild = await build({ entryPoints: [serverEntry], bundle: true, format: "cjs", platform: "node",
        write: false, packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
      const module = { exports: {} as { render(): string } };
      new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      assert.throws(module.exports.render, (error: unknown) => {
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
        const react = await browser.newPage();
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
          await react.setContent("<main></main>");
          await react.addScriptTag({ path: converted.get(mode)! });
          await react.waitForFunction(() => window.reactContextDiagnostic !== undefined);
          const convertedDiagnostic = await react.evaluate(() => window.reactContextDiagnostic ?? null);
          assert.deepEqual(native, {
            name: "HtmlDiagnosticError", code: "HR009",
            message: "HR009: <x-context-reader> requires context `current` from <x-steps>.",
          });
          assert.deepEqual(convertedDiagnostic, native);
        } finally {
          await Promise.all([live.close(), react.close()]);
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    reactContextDiagnostic?: Diagnostic;
  }
}
