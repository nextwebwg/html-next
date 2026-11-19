import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("React forwarded native control ownership", () => {
  let directory = "";
  let serverHtml = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-native-owner-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    const declarations = '<defs><prop name="caption" type="string" default="Initial">Title.</prop><prop name="kind" type="string" default="radio">Control type.</prop></defs>';
    await writeFile(join(directory, "controls.html"), `<template component="x-plain">${declarations}<input $attributes from:type="$kind" from:title="$caption"></template><template component="x-value">${declarations}<input $attributes from:type="$kind" from:title="$caption" from:value="'blue'"></template>`);
    await convertComponents({ mode: "application", target: "react", root: directory, outDirectory: directory, entries: ["controls.html"] });
    await writeFile(join(directory, "app.tsx"), `import React from "react"; import { XPlain, XValue } from "./react/application";
export const handles = new Map<string, HTMLInputElement>();
export function content(caption = "Initial", kind = "radio", name?: string) { return <React.StrictMode><form>{[XPlain, XValue].flatMap((Control, index) => [undefined, "color: red !important"].map((style, priority) => <Control key={index + ':' + priority} id={index + ':' + priority} caption={caption} kind={kind} name={name} ref={element => { const key = index + ':' + priority; if (element) handles.set(key, element); return () => { handles.delete(key); }; }} style={style as any} />))}</form></React.StrictMode>; }`);
    await writeFile(join(directory, "client.tsx"), `import { createRoot, hydrateRoot } from "react-dom/client"; import { flushSync } from "react-dom"; import { content, handles } from "./app";
const mount = document.querySelector("main")!; const root = mount.hasChildNodes() ? hydrateRoot(mount, content()) : createRoot(mount); if (!mount.hasChildNodes()) flushSync(() => root.render(content()));
(window as any).controlHandles = handles;
(window as any).updateControls = (caption?: string, kind?: string, name?: string) => flushSync(() => root.render(content(caption, kind, name)));`);
    await build({ entryPoints: [join(directory, "client.tsx")], outfile: join(directory, "client.js"), bundle: true, format: "iife", platform: "browser", jsx: "automatic" });
    await writeFile(join(directory, "server.tsx"), 'import { renderToString } from "react-dom/server"; import { content, handles } from "./app"; export const html = renderToString(content());');
    const server = await build({ entryPoints: [join(directory, "server.tsx")], bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic" });
    const module = { exports: {} as { html: string } };
    new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    serverHtml = module.exports.html;
  });
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const engine of [chromium, firefox, webkit]) for (const hydrated of [false, true]) {
    it(`${engine.name()} ${hydrated ? "hydrated" : "fresh"} preserves controller-owned name and type through commits`, async () => {
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(`<main>${hydrated ? serverHtml : ""}</main>`);
        await page.addScriptTag({ content: await readFile(join(directory, "client.js"), "utf8") });
        const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await settle();
        assert.deepEqual(await page.evaluate(() => [...(window as any).controlHandles.keys()].sort()), ["0:0", "0:1", "1:0", "1:1"], "StrictMode publishes the native handles after mounting");
        await page.locator("input").evaluateAll(nodes => nodes.forEach((node, index) => {
          const input = node as HTMLInputElement;
          input.name = `choice-${index}`;
          input.type = "checkbox";
          input.defaultChecked = true;
          input.checked = true;
        }));
        const snapshot = () => page.locator("input").evaluateAll(nodes => nodes.map(node => {
          const input = node as HTMLInputElement;
          return { name: input.name, type: input.type, value: input.value, checked: input.checked };
        }));
        const expected = Array.from({ length: 4 }, (_, index) => ({ name: `choice-${index}`, type: "checkbox", value: index < 2 ? "on" : "blue", checked: true }));
        assert.deepEqual(await snapshot(), expected);
        await page.evaluate(() => (window as any).updateControls()); await settle();
        assert.deepEqual(await snapshot(), expected, "an unrelated render preserves native control edits");
        await page.evaluate(() => (window as any).updateControls("Updated")); await settle();
        assert.deepEqual(await snapshot(), expected, "updating the title preserves the other native fields");
        assert.deepEqual(await page.locator("form").evaluate(form => [...new FormData(form as HTMLFormElement)]), expected.map(({ name, value }) => [name, value]));
        assert.deepEqual(await page.locator("input").evaluateAll(nodes => nodes.map(input => input.getAttribute("title"))), Array(4).fill("Updated"));
        await page.locator("input").evaluateAll(nodes => nodes.forEach((node, index) => {
          const input = node as HTMLInputElement;
          input.type = "radio";
          input.name = "group";
          input.checked = index === nodes.length - 1;
        }));
        const grouped = expected.map((input, index) => ({ ...input, name: "group", type: "radio", checked: index === expected.length - 1 }));
        assert.deepEqual(await snapshot(), grouped);
        await page.evaluate(() => (window as any).updateControls("Grouped")); await settle();
        assert.deepEqual(await snapshot(), grouped, "commits preserve the selected native radio in a shared group");
        assert.deepEqual(await page.locator("form").evaluate(form => [...new FormData(form as HTMLFormElement)]), [["group", "blue"]]);
        await page.evaluate(() => (window as any).updateControls("Updated", "text")); await settle();
        assert.deepEqual((await snapshot()).map(({ name, type }) => ({ name, type })), grouped.map(({ name }) => ({ name, type: "text" })), "an authored type change takes effect");
        await page.evaluate(() => (window as any).updateControls("Updated", "text", "authored")); await settle();
        assert.deepEqual((await snapshot()).map(({ name }) => name), Array(4).fill("authored"), "an authored name change takes effect");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
