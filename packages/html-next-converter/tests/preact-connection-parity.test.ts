import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("framework subtree connection", () => {
  let directory: string;
  const bundles = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-subtree-connection-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "probe.html"), '<template component="x-probe" module="./probe.js"><button type="button">Run</button></template>');
    await writeFile(join(directory, "probe.js"), `export function connect(host) {
      host.element.setAttribute("data-connected", "");
      const click = () => { window.hits++; };
      host.element.addEventListener("click", click);
      return () => host.element.removeEventListener("click", click);
    }`);
    for (const target of ["react", "preact"] as const) {
      const output = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: output, entries: ["probe.html"] });
      const entry = join(output, "entry.tsx");
      await writeFile(entry, `import React from ${JSON.stringify(target === "preact" ? "preact/compat" : "react")};
        import { flushSync } from ${JSON.stringify(target === "preact" ? "preact/compat" : "react-dom")};
        ${target === "preact" ? 'import { render } from "preact";' : 'import { createRoot } from "react-dom/client";'}
        import Probe from ${JSON.stringify("./" + manifest.components[0]!.artifact)};
        function App() { return <main><div id="warm"><Probe /></div></main>; }
        window.showProbe = () => {
          const detached = document.createElement("section"); detached.id = "late";
          flushSync(() => { ${target === "preact" ? 'render(<Probe />, detached);' : 'createRoot(detached).render(<Probe />);'} });
          document.querySelector("#mount").append(detached);
        };
        window.hits = 0;
        ${target === "preact" ? 'render(<App />, document.querySelector("#mount"));' : 'flushSync(() => createRoot(document.querySelector("#mount")).render(<App />));'}
      `);
      const bundle = join(output, "probe.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}), loader: { ".css": "empty" } });
      bundles.set(target, bundle);
    }
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  for (const target of ["react", "preact"] as const) {
    for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
      it(`${engine} ${target} connects a newly inserted subtree before its first painted interaction`, async () => {
        const browser = await launchParityBrowser(type);
        try {
          const page = await browser.newPage();
          await page.setContent('<div id="mount"></div>');
          await page.addScriptTag({ path: bundles.get(target)! });
          await page.waitForFunction(() => Boolean(document.querySelector("#warm button[data-connected]")));
          const result = await page.evaluate(async () => {
            const app = window as unknown as { hits: number; showProbe(): void };
            document.querySelector<HTMLButtonElement>("#warm button")!.click();
            const warm = app.hits;
            app.showProbe();
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            document.querySelector<HTMLButtonElement>("#late button")!.click();
            return { warm, hits: app.hits };
          });
          assert.deepEqual(result, { warm: 1, hits: 2 });
        } finally { await browser.close(); }
      });
    }
  }
});
