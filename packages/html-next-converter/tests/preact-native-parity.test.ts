import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { convertComponents } from "../src/index.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Preact native bindings", () => {
  let directory = "";
  let bundle = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-preact-native-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "styled.html"), `<template component="x-styled"><defs>
      <state name="choice" type="string" value="23"></state>
      <handler name="choose"><set name="choice" expr:value="$$event.detail"></set></handler>
      <state name="rows" type="list" value="[{ tag: { label: 'Tag' } }]"><prop type="object">
        <prop name="tag" type="object"><prop name="label" required type="string"></prop><prop name="color" type="string"></prop></prop>
      </prop></state><handler name="change"><set name="rows" expr:value="$$event.detail"></set></handler>
      </defs><section on:set-color="change" on:set-choice="choose"><i $each="row of $rows"><b $if="$row.tag" style:--label-color="$row.tag.color">Label</b></i><select><option value="12">12</option><option from:value="$choice">23</option></select></section></template>`);
    const output = join(directory, "output");
    const manifest = await convertComponents({ target: "preact", mode: "library", entries: ["styled.html"], root: directory, outDirectory: output });
    const entry = join(output, "entry.js");
    await writeFile(entry, `import { h, render } from "preact";
      import { XStyled } from "./${manifest.output.entry}";
      render(h(XStyled, { id: "case" }), document.querySelector("main"));
      window.setColor = color => document.querySelector("#case").dispatchEvent(new CustomEvent("set-color", { detail: [{ tag: color === undefined ? { label: "Tag" } : { label: "Tag", color } }] }));`);
    bundle = join(output, "app.js");
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" } });
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${engine} removes an absent custom style on initial render and updates`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundle });
        for (const color of [undefined, "red", undefined]) {
          await page.evaluate(color => (window as unknown as { setColor(color?: string): void }).setColor(color), color);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await page.locator("#case b").evaluate(element => (element as HTMLElement).style.getPropertyValue("--label-color")), color ?? "");
        }
      } finally { await browser.close(); }
    });
    it(`${engine} preserves explicit option values equal to their text`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundle });
        await page.locator("option").last().waitFor({ state: "attached" });
        assert.deepEqual(await page.locator("option").evaluateAll(options => options.map(option => option.getAttribute("value"))), ["12", "23"]);
        for (const choice of ["24", "23"]) {
          await page.locator("#case").evaluate((element, detail) => element.dispatchEvent(new CustomEvent("set-choice", { detail })), choice);
          await page.waitForFunction(value => document.querySelectorAll("option")[1]?.getAttribute("value") === value, choice);
        }
      } finally { await browser.close(); }
    });
  }
});
