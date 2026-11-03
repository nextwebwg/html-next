import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { convertComponents } from "../src/index.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Reactive native root refs", () => {
  let directory = "";
  const bundles = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-root-ref-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "field.html"), `<template component="x-field"><defs>
      <prop name="multiline" type="boolean" default="false">Render a textarea.</prop><prop name="value" type="string" default="">Field value.</prop>
      </defs><template $match><textarea $when="$multiline" from:data-value="$value"></textarea><input $else from:data-value="$value"></template></template>`);
    for (const target of ["react", "preact"] as const) {
      const output = join(directory, target);
      const manifest = await convertComponents({ target, mode: "library", entries: ["field.html"], root: directory, outDirectory: output });
      const entry = join(output, "entry.tsx");
      const react = target === "react" ? "react" : "preact/compat";
      const client = target === "react" ? "react-dom/client" : "preact/compat/client";
      await writeFile(entry, `import React from "${react}"; import { createRoot } from "${client}";
        import { XField } from "./${manifest.output.entry}";
        const root = createRoot(document.querySelector("main"));
        window.refs = []; window.renders = 0;
        function App() {
          const [element, setElement] = React.useState(null), [value, setValue] = React.useState("initial"), [multiline, setMultiline] = React.useState(false);
          if (++window.renders > 20) throw Error("Ref publication caused a render loop");
          const ref = React.useCallback(node => { window.refs.push(node?.localName ?? null); setElement(node); }, []);
          window.change = () => setValue("changed"); window.switchRoot = () => setMultiline(true); window.unmount = () => root.unmount();
          return React.createElement(XField, { ref, value, multiline, id: "field", "data-current": element?.localName });
        }
        root.render(React.createElement(App));`);
      const bundle = join(output, "app.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" } });
      bundles.set(target, bundle);
    }
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  for (const target of ["react", "preact"]) for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${target} ${engine} publishes only changed roots to a state ref`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage(); page.setDefaultTimeout(3000); const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent("<main></main>"); await page.addScriptTag({ path: bundles.get(target)! });
        const snapshot = () => page.evaluate(() => ({ refs: Reflect.get(window, "refs"), renders: Reflect.get(window, "renders") }));
        await page.waitForFunction(() => document.querySelector("#field")?.getAttribute("data-current") === "input", undefined, { timeout: 1500 });
        await page.evaluate(() => Reflect.get(window, "change")());
        await page.waitForFunction(() => document.querySelector("#field")?.getAttribute("data-value") === "changed");
        assert.deepEqual((await snapshot()).refs, ["input"]);
        await page.evaluate(() => Reflect.get(window, "switchRoot")());
        await page.waitForFunction(() => document.querySelector("#field")?.getAttribute("data-current") === "textarea");
        assert.deepEqual((await snapshot()).refs, ["input", null, "textarea"]);
        await page.evaluate(() => Reflect.get(window, "unmount")());
        assert.deepEqual((await snapshot()).refs, ["input", null, "textarea", null]);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
