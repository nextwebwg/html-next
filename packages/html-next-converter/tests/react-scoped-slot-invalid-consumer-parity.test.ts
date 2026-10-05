import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
import { receiver, consumer, dynamicReceiver, dynamicConsumer } from "./fixtures/scoped-slot-diagnostics.js";

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public React converter invalid scoped-slot consumer parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly client: string; readonly render: (kind: "static" | "dynamic") => string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-invalid-scoped-slot-"));
    await mkdir(join(directory, "components"));
    for (const [name, source] of [["receiver", receiver], ["consumer", consumer],
      ["dynamic-receiver", dynamicReceiver], ["dynamic-consumer", dynamicConsumer]] as const) {
      await writeFile(join(directory, "components", `${name}.html`), source);
    }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["components/consumer.html", "components/dynamic-consumer.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), [
        "x-dynamic-scoped-receiver", "x-invalid-dynamic-scoped-consumer", "x-invalid-scoped-consumer", "x-scoped-receiver",
      ]);
      const entry = join(outDirectory, "entry.tsx");
      const client = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XInvalidScopedConsumer, XInvalidDynamicScopedConsumer } from "./react/${mode === "application" ? "application" : "index"}";
const Component = window.scopedSlotKind === "dynamic" ? XInvalidDynamicScopedConsumer : XInvalidScopedConsumer;
createRoot(document.querySelector("#mount")!, { onUncaughtError(error) {
  window.reactScopedSlotDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
} }).render(<Component id="case" />);
`);
      await build({ entryPoints: [entry], outfile: client, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
      const serverBuild = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as {
        XInvalidScopedConsumer: React.ComponentType<Record<string, unknown>>;
        XInvalidDynamicScopedConsumer: React.ComponentType<Record<string, unknown>>;
      } };
      new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      converted.set(mode, { client, render: (kind) => renderToString(React.createElement(
        kind === "static" ? module.exports.XInvalidScopedConsumer : module.exports.XInvalidDynamicScopedConsumer,
        { id: "case" },
      )) });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const kind of ["static", "dynamic"] as const) {
      it(`${mode} SSR reports HR007 for an ordinary ${kind} scoped-slot child`, () => {
        assert.throws(() => converted.get(mode)!.render(kind), (error) => {
          const failure = error as Error & { diagnostic?: { code?: string } };
          assert.deepEqual({ name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message }, {
            name: "HtmlDiagnosticError", code: "HR007",
            message: 'HR007: Scoped slot `row` requires a consumer <template slot="row">.',
          });
          return true;
        });
      });
    }
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const kind of ["static", "dynamic"] as const) {
        it(`${engine} ${mode} reports HR007 for an ordinary ${kind} scoped-slot child`, async () => {
          const browser = await browserType.launch({ headless: true });
          const [live, react] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            const tag = kind === "static" ? "x-invalid-scoped-consumer" : "x-invalid-dynamic-scoped-consumer";
            await live.setContent(`${receiver}${consumer}${dynamicReceiver}${dynamicConsumer}<${tag} id="case"></${tag}>`);
            await live.addScriptTag({ path: liveBundle });
            const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const value = error as Error & { diagnostic?: { code?: string } };
                return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
              }
            });
            await react.setContent("<div id=mount></div>");
            await react.evaluate((value) => { window.scopedSlotKind = value; }, kind);
            await react.addScriptTag({ path: converted.get(mode)!.client });
            await react.waitForFunction(() => window.reactScopedSlotDiagnostic !== undefined);
            const reactDiagnostic = await react.evaluate(() => window.reactScopedSlotDiagnostic ?? null);
            assert.deepEqual(liveDiagnostic, {
              name: "HtmlDiagnosticError", code: "HR007",
              message: 'HR007: Scoped slot `row` requires a consumer <template slot="row">.',
            });
            assert.deepEqual(reactDiagnostic, liveDiagnostic);
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
    scopedSlotKind: "static" | "dynamic";
    reactScopedSlotDiagnostic?: Diagnostic;
  }
}
