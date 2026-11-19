import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

import { reactRenderArtifact } from "../../html-next/src/targets/react-render.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("React slot claims through abandoned transitions", () => {
  let directory = "";
  let bundle = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-slot-transition-"));
    await writeFile(join(directory, "render.tsx"), reactRenderArtifact("test").content);
    const entry = join(directory, "entry.tsx");
    await writeFile(entry, `import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { ChildEntries, ChildSlot, useChildEntry, useChildLists, useSlotClaims } from "./render";
      let release; const waiting = new Promise(resolve => { release = resolve; });
      function Pause() { window.didSuspend = true; throw waiting; }
      function Own() {
        const link = useChildEntry("rows:one", { tags: ["x-claim-child"], props: {} }, {});
        const slot = useSlotClaims(link);
        return <b id="own">{slot("cell", link?.slots?.cell, "Own fallback", "own")}</b>;
      }
      function Owner() {
        const [state, set] = React.useState({ borrowed: false, own: false, paused: false });
        const result = useChildLists({ rows: [{ key: "rows:one", tag: "x-claim-child", props: {}, slots: { cell: <input defaultValue="Initial" /> } }] },
          { rows: ["", ["x-claim-child"]] }, "x-list", "", {});
        window.abandon = () => React.startTransition(() => set({ borrowed: true, own: false, paused: true }));
        window.showOwn = () => { flushSync(() => set({ borrowed: false, own: true, paused: false })); release(); };
        return <ChildEntries.Provider value={result.entries}><section>
          {state.borrowed && <p id="borrowed"><ChildSlot entry={result.lists.rows[0]} name="cell" slots={{ "x-claim-child": [[], [], ["cell"], "cell"] }} file="" fallback="Borrowed fallback" /></p>}
          {state.paused && <Pause />}
          {state.own && <Own />}
        </section></ChildEntries.Provider>;
      }
      createRoot(document.querySelector("#mount")).render(<React.StrictMode><React.Suspense fallback={<em>Waiting</em>}><Owner /></React.Suspense></React.StrictMode>);
    `);
    bundle = join(directory, "entry.js");
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
      nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${engine} makes an abandoned outlet's content available to a later mounted outlet`, async () => {
      const browser = await launchParityBrowser(type);
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent('<div id="mount"></div>');
        await page.addScriptTag({ path: bundle });
        await page.waitForFunction(() => typeof (window as any).abandon === "function");
        await page.evaluate(() => (window as any).abandon());
        await page.waitForFunction(() => (window as any).didSuspend === true);
        await page.evaluate(() => (window as any).showOwn());
        const input = page.locator("#own input");
        await input.waitFor({ state: "visible", timeout: 5_000 });
        assert.equal(await page.locator("input").count(), 1);
        assert.equal(await page.locator("#borrowed").count(), 0);
        await input.fill("Edited");
        assert.equal(await input.inputValue(), "Edited");
        assert.equal(await input.evaluate(element => element === document.activeElement), true);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
