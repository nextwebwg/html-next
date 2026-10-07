import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { HtmlDiagnosticError } from "@nextwebwg/html-next";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents, type ConversionGraph } from "../src/index.js";
import { cases, runMatrix, snapshot, source } from "./event-modifier-cases.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));

describe.skipIf(!enabled)("public React converter event modifier matrix", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly browser: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-event-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "matrix.html"), source);
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["components/matrix.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-event-matrix"]);
      const entry = `./${manifest.output.entry.replace(/\.ts$/, "")}`;
      const browserEntry = join(outDirectory, "browser.tsx");
      const browser = join(outDirectory, "browser.js");
      await writeFile(browserEntry, `import { useEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XEventMatrix } from ${JSON.stringify(entry)};
function App() { useEffect(() => { (window as any).eventReady = true; }, []); return <XEventMatrix id="case" />; }
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <App />);
else createRoot(mount).render(<App />);
`);
      await build({ entryPoints: [browserEntry], outfile: browser, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", nodePaths: [nodeModulesPath] });
      const serverEntry = join(outDirectory, "server.tsx");
      await writeFile(serverEntry, `import { renderToString } from "react-dom/server";
import { XEventMatrix } from ${JSON.stringify(entry)};
export const render = () => renderToString(<XEventMatrix id="case" />);
`);
      const serverBuild = await build({ entryPoints: [serverEntry], bundle: true, format: "cjs", platform: "node",
        write: false, jsx: "automatic", packages: "external" });
      const module = { exports: {} as { render(): string } };
      new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      converted.set(mode, { browser, server: module.exports.render() });
    }
  }, 60_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("rejects invalid modifier combinations with source-located diagnostics", async () => {
    for (const [name, binding] of [
      ["passive-prevent", "on:click.passive.prevent"],
      ["repeated-stop", "on:click.stop.stop"],
      ["unknown-modifier", "on:click.unknown"],
      ["deferred-lifecycle", "on:connect"],
    ] as const) {
      const entry = `components/${name}.html`;
      await writeFile(join(directory, entry), `<template component="x-${name}" status="early" summary="Invalid event modifier."><defs><handler name="hit"></handler></defs><button ${binding}="hit">Go</button></template>`);
      await assert.rejects(
        () => convertComponents({ mode: "application", target: "react", entries: [entry], root: directory,
          outDirectory: join(directory, `invalid-${name}`) }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT010" &&
          error.diagnostic.source?.endsWith(entry) === true,
      );
    }
  });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} matches every supported modifier after mount and hydration`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, react, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, react, hydrated];
        const errors: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          const output = converted.get(mode)!;
          await live.setContent(`${source}<main><x-event-matrix id="case"></x-event-matrix></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent("<main></main>");
          await react.addScriptTag({ path: output.browser });
          await hydrated.setContent(`<main>${output.server}</main>`);
          await react.waitForFunction(() => (window as any).eventReady === true);
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.counts, serverLive.counts, "server-rendered event counts differ");
          await assertPixelsEqual(hydrated, serverHydrated.pixels, serverLive.pixels, "server-rendered event pixels differ", live);
          await hydrated.addScriptTag({ path: output.browser });
          await hydrated.waitForFunction(() => (window as any).eventReady === true);
          const [initialLive, initialReact, initialHydrated] = await Promise.all([snapshot(live), snapshot(react), snapshot(hydrated)]);
          assert.deepEqual(initialReact.counts, initialLive.counts);
          assert.deepEqual(initialHydrated.counts, initialLive.counts);
          await assertPixelsEqual(react, initialReact.pixels, initialLive.pixels, "mounted event pixels differ", live);
          await assertPixelsEqual(hydrated, initialHydrated.pixels, initialLive.pixels, "hydrated event pixels differ", live);
          const [liveResults, reactResults, hydratedResults] = await Promise.all([runMatrix(live), runMatrix(react), runMatrix(hydrated)]);
          assert.deepEqual(reactResults, liveResults, "event dispatch behavior differs");
          assert.deepEqual(hydratedResults, liveResults, "hydrated event dispatch behavior differs");
          for (const [index, scenario] of cases.entries()) {
            for (const [stepIndex, step] of scenario.steps.entries()) {
              const result = liveResults[index]![stepIndex]!;
              assert.equal(result.bubbled, step.bubbled ?? true, `${scenario.id} step ${stepIndex} propagation`);
              assert.equal(result.prevented, step.prevented ?? false, `${scenario.id} step ${stepIndex} cancellation`);
              assert.equal(result.returned, !(step.prevented ?? false), `${scenario.id} step ${stepIndex} dispatch return`);
            }
          }
          const [afterLive, afterReact, afterHydrated] = await Promise.all([snapshot(live), snapshot(react), snapshot(hydrated)]);
          const expected = cases.map(({ steps }) => String(steps.at(-1)!.count));
          assert.deepEqual(afterLive.counts, expected, "live-runtime modifier baseline changed");
          assert.deepEqual(afterReact.counts, expected, "converted modifier counts differ");
          assert.deepEqual(afterHydrated.counts, expected, "hydrated modifier counts differ");
          await assertPixelsEqual(react, afterReact.pixels, afterLive.pixels, "converted modifier pixels differ", live);
          await assertPixelsEqual(hydrated, afterHydrated.pixels, afterLive.pixels, "hydrated modifier pixels differ", live);
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
