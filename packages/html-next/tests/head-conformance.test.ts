import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { authoredHead, expectedHead, headFiles, runHeadScenario } from "./head-scenario.js";

/**
 * Head declarations (https://nextwebwg.org/declarative-components/components#head-management) in the
 * live runtime, in Chromium, Firefox and WebKit: insertion and removal, shared and competing keys,
 * restoring the authored head as the same nodes, meta lists, the document-authority rule with and
 * without an application-components list, JSON-LD, and a page change as one reconciliation.
 */
const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const source = fileURLToPath(new URL("../src/", import.meta.url));

/** The live page: component links, an import map for the bare imports, and `app` acting on the DOM. */
function livePage(listed: boolean): string {
  const imports = { "@vendor/": "https://vendor.example/ui/", "@cdn/": "https://cdn.acme.example/ui/" };
  return `<!doctype html><head>${authoredHead(listed)}<script type="importmap">${JSON.stringify({ imports })}</script></head><body>
<link rel="component" href="/app.html"><link rel="component" href="@vendor/widget.html">
<link rel="component" href="${listed ? "https://cdn.acme.example/ui/badge.html" : "@cdn/badge.html"}">
<div id="mount"></div></body>`;
}

const liveApp = `const mount = () => document.querySelector("#mount");
const root = (tag) => mount().querySelector('[data-component~="' + tag + '"]');
globalThis.alert = () => { globalThis.alerted = true; };
globalThis.app = {
  mount() {
    mount().innerHTML = '<docs-layout><page-a></page-a></docs-layout><img-card></img-card><img-card></img-card>' +
      '<x-product></x-product><vendor-widget></vendor-widget><cdn-badge></cdn-badge>';
  },
  section(text) { HtmlNextLive.updateComponentProps(root("page-a"), { section: text }); },
  note(shown) { if (shown) root("page-a").append(document.createElement("x-note")); else root("x-note").remove(); },
  cards(count) { const cards = mount().querySelectorAll('[data-component~="img-card"]'); for (const card of [...cards].slice(count)) card.remove(); },
  schema(value) { HtmlNextLive.updateComponentProps(root("x-product"), { schema: value }); },
  page(name) { root("page-a").replaceWith(document.createElement("page-" + name)); },
  unmount() { mount().replaceChildren(); },
};`;

describe.skipIf(!enabled)("head declarations in the live runtime, in every engine", () => {
  let directory = "";
  let bundle = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-head-"));
    const entry = join(directory, "entry.ts");
    await writeFile(entry, `export * from ${JSON.stringify(join(source, "browser-loader.ts"))};
export { updateComponentProps } from ${JSON.stringify(join(source, "runtime.ts"))};\n`);
    bundle = join(directory, "live.js");
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", globalName: "HtmlNextLive", platform: "browser", target: ["es2022"] });
  });
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const listed of [false, true]) {
      it(`${engine} reconciles the head ${listed ? "with" : "without"} an application-components list`, async () => {
        const browser = await browserType.launch({ headless: true });
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          // A preconnect to these test hosts fails at the network, as it would for any page.
          page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to preconnect")) errors.push(message.text()); });
          const warnings: string[] = [];
          page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text().split(": ").slice(1, 2).join("")); });
          await page.route(/^https:\/\/(?:app|vendor|cdn\.acme)\.example\//, (route) => {
            const url = new URL(route.request().url());
            const name = url.pathname.split("/").at(-1)!;
            const headers = { "access-control-allow-origin": "*" };
            if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: livePage(listed), headers });
            return Object.hasOwn(headFiles, name) ? route.fulfill({ contentType: "text/html", body: headFiles[name]!, headers }) : route.fulfill({ status: 404, headers });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundle });
          await page.evaluate(() => (window as unknown as { HtmlNextLive: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLive.startBrowserComponents());
          await page.addScriptTag({ content: liveApp });
          const steps = await runHeadScenario(page);
          assert.deepEqual(steps, expectedHead(listed));
          assert.deepEqual(errors, []);
          // The imported widget's canonical link and theme color are ignored with a diagnostic, and so
          // is the badge's theme color when it is imported.
          assert.deepEqual(warnings.filter((code) => code === "HL011").length, listed ? 2 : 3);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
