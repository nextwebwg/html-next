import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, firefox, webkit } from "playwright";
import { parseComponent } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";
import { htmlNext, hydrationModule } from "../src/index.js";

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("selected server hydration", () => {
  let root: string;
  let server: PreviewServer;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "html-next-client-browser-"));
    const sources = {
      "page.html": '<link rel="component" href="./shell.html"><link rel="component" href="./reader.html"><template component="ui-page"><section><ui-shell><ui-reader></ui-reader></ui-shell></section></template>',
      "shell.html": '<link rel="component" href="./label.html"><template component="ui-shell"><defs><state name="active" type="boolean" value="false"></state><handler name="toggle"><set name="active" expr:value="not $active"></set></handler></defs><main><button on:click="toggle">Toggle</button><input aria-label="Draft"><slot></slot><ui-label $if="$active"></ui-label></main></template>',
      "reader.html": '<template component="ui-reader"><defs><context name="active" from="ui-shell"></context></defs><output>{$active}</output></template>',
      "label.html": '<template component="ui-label"><span>FutureLabelMarker</span></template>',
      "poster.html": '<template component="ui-poster"><article>StaticPosterFactoryMarker</article><style>:host { color: blue; }</style></template>',
    };
    for (const [name, source] of Object.entries(sources)) await writeFile(join(root, name), source);
    await writeFile(join(root, "main.js"), `import { hydrate } from ${JSON.stringify(hydrationModule)}; hydrate(); window.hydrationReady = true;`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext.vite({ entries: ["page.html", "poster.html"], hydrate: true })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": new URL("../../html-next/src/generated-runtime.ts", import.meta.url).pathname } },
      build: { minify: false, lib: { entry: join(root, "main.js"), formats: ["es"], fileName: () => "app.js", cssFileName: "components" } } });
    assert.doesNotMatch(await readFile(join(root, "dist/app.js"), "utf8"), /StaticPosterFactoryMarker/);
    const rendered = await renderComponents("<ui-poster></ui-poster><ui-page></ui-page>", {
      definitions: Object.values(sources).map(source => parseComponent(source.replace(/<link[^>]+>/g, ""))),
    });
    await writeFile(join(root, "dist/index.html"), `<!doctype html><html><head><link rel="stylesheet" href="/components.css"></head><body>${rendered.html}<script>
      window.originalMain = document.querySelector('main');
      window.originalOutput = document.querySelector('output');
      document.querySelector('input').value = 'Early draft';
      </script><script type="module" src="/app.js"></script></body></html>`);
    server = await preview({ root, configFile: false, logLevel: "silent", preview: { host: "127.0.0.1", port: 0 } });
  });
  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${name} preserves projection, context, early control edits, and future branches`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(server.resolvedUrls!.local[0]!);
        await page.waitForFunction(() => Reflect.get(window, "hydrationReady") === true);
        assert.equal(await page.locator("output").textContent(), "false");
        assert.equal(await page.locator("input").inputValue(), "Early draft");
        assert.equal(await page.locator("article").evaluate(element => getComputedStyle(element).color), "rgb(0, 0, 255)");
        await page.getByRole("button", { name: "Toggle" }).click();
        await page.waitForFunction(() => document.querySelector("output")?.textContent === "true");
        assert.equal(await page.locator("span").textContent(), "FutureLabelMarker");
        assert.equal(await page.evaluate(() => document.querySelector("main") === Reflect.get(window, "originalMain")
          && document.querySelector("output") === Reflect.get(window, "originalOutput")), true);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
