import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { build } from "esbuild";
import { chromium } from "playwright";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const layout = new URL("../examples/looma/layout/", import.meta.url);

describe("HTML Next Looma layout primitives", { skip: !enabled }, () => {
  it("lowers semantic layout roots, applies CSS, and supports sidebar resizing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-layout-"));
    const runtimeBundle = join(directory, "runtime.js");
    const controllerBundle = join(directory, "sidebar.js");
    try {
      await Promise.all([
        build({ entryPoints: [new URL("../src/runtime.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", outfile: runtimeBundle, platform: "browser", target: ["es2022"] }),
        build({ stdin: { contents: `import * as module from ${JSON.stringify(new URL("ui-sidebar.js", layout).pathname)}; globalThis.SidebarController = module;`, resolveDir: layout.pathname }, bundle: true, format: "iife", outfile: controllerBundle, platform: "browser", target: ["es2022"] }),
      ]);
      const tags = ["ui-center", "ui-cluster", "ui-grid", "ui-inline", "ui-reel", "ui-separator", "ui-sidebar", "ui-stack", "ui-switcher"];
      const definitions = (await Promise.all(tags.map((tag) => readFile(new URL(`${tag}.html`, layout), "utf8")))).join("\n");
      const css = await readFile(new URL("../examples/looma/package-assets/layout.css", import.meta.url), "utf8");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<style>${css}</style>${definitions}<ui-stack id="stack" gap="s"><span>A</span><span>B</span></ui-stack><ui-reel id="reel"></ui-reel><ui-separator id="separator" orientation="vertical"></ui-separator><ui-sidebar id="sidebar" resizable min-width="200" max-width="400" resize-step="25"><aside>Nav</aside><main>Body</main></ui-sidebar>`);
        await page.addScriptTag({ path: runtimeBundle });
        await page.addScriptTag({ path: controllerBundle });
        const result = await page.evaluate(`(async () => {
          const events = [];
          document.addEventListener('resize', event => { if (event.target?.id === 'sidebar') events.push(event.detail); });
          window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
            if (definition.contract.tag !== 'ui-sidebar') return;
            window.HtmlRuntime.setControllerModule(root, Promise.resolve(window.SidebarController));
            return window.SidebarController.default(window.HtmlRuntime.getComponentHost(root));
          }});
          await new Promise(resolve => setTimeout(resolve, 0));
          const stack = document.getElementById('stack');
          const sidebar = document.getElementById('sidebar');
          const handle = sidebar.querySelector('[data-ui-sidebar-resizer]');
          handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          return {
            stack: { tag: stack.localName, display: getComputedStyle(stack).display, direction: getComputedStyle(stack).flexDirection },
            reel: { tag: document.getElementById('reel').localName, role: document.getElementById('reel').getAttribute('role'), tabIndex: document.getElementById('reel').tabIndex },
            separator: { tag: document.getElementById('separator').localName, orientation: document.getElementById('separator').getAttribute('aria-orientation') },
            sidebar: { width: sidebar.style.getPropertyValue('--ui-sidebar-width'), handle: handle.getAttribute('role'), events },
          };
        })()`);
        assert.deepEqual(result, {
          stack: { tag: "div", display: "flex", direction: "column" },
          reel: { tag: "div", role: "region", tabIndex: 0 },
          separator: { tag: "hr", orientation: "vertical" },
          sidebar: { width: "313px", handle: "separator", events: [
            { width: 288, trigger: "programmatic" }, { width: 313, trigger: "keyboard" },
          ] },
        });
      } finally { await browser.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
