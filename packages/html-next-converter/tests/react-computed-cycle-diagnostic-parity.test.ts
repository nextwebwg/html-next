import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const definitions = {
  self: '<template component="x-self-cycle" status="early" summary="Self cycle."><defs><computed name="loop" from="loop + 1"></computed></defs><div from:data-value="loop"></div></template>',
  mutual: '<template component="x-mutual-cycle" status="early" summary="Mutual cycle."><defs><computed name="left" from="right + 1"></computed><computed name="right" from="left + 1"></computed></defs><div from:data-value="left"></div></template>',
} as const;

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("React computed-cycle diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-computed-cycle-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/self.html"), definitions.self);
    await writeFile(join(directory, "components/mutual.html"), definitions.mutual);
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory, entries: ["components/**"] });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-mutual-cycle", "x-self-cycle"]);
      const entry = join(outDirectory, "mount.tsx");
      await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XSelfCycle, XMutualCycle } from "./react/${mode === "application" ? "application" : "index"}";
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error & { diagnostic?: { code?: string } }) {
    window.reactCycleDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
  }
  render() { return this.state.failed ? null : this.props.children; }
}
const Component = window.cycleKind === "self" ? XSelfCycle : XMutualCycle;
createRoot(document.querySelector("main")!).render(<Boundary><Component /></Boundary>);`);
      const bundle = join(outDirectory, "mount.js");
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
      });
      converted.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const kind of ["self", "mutual"] as const) {
      for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
        it(`${engine} ${mode} reports HR006 for a ${kind} cycle`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          try {
            const live = await browser.newPage();
            pages.push(live);
            const react = await browser.newPage();
            pages.push(react);
            const tag = kind === "self" ? "x-self-cycle" : "x-mutual-cycle";
            await live.setContent(`${definitions.self}${definitions.mutual}<main><${tag}></${tag}></main>`);
            await live.addScriptTag({ path: liveBundle });
            const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const value = error as Error & { diagnostic?: { code?: string } };
                return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
              }
            });
            await react.setContent("<main></main>");
            await react.evaluate((value) => { window.cycleKind = value; }, kind);
            await react.addScriptTag({ path: converted.get(mode)! });
            await react.waitForFunction(() => window.reactCycleDiagnostic !== undefined);
            const reactDiagnostic = await react.evaluate(() => window.reactCycleDiagnostic);
            const expected: Diagnostic = { name: "HtmlDiagnosticError", code: "HR006", message: "HR006: A reactive computed value depends on itself." };
            assert.deepEqual(liveDiagnostic, expected);
            assert.deepEqual(reactDiagnostic, expected);
          } finally {
            try { await Promise.all(pages.map((page) => page.close())); }
            finally { await browser.close(); }
          }
        });
      }
    }
  }
});

declare global {
  interface Window {
    cycleKind: "self" | "mutual";
    reactCycleDiagnostic?: Diagnostic;
  }
}
