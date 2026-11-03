import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { parseComponent, compileComponentStylesForBuild } from "../../html-next/src/index.js";
import { convertComponents } from "../src/index.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Reactive native controls and refs", () => {
  let directory = "";
  let nativeCss = "";
  const bundles = new Map<string, string>();
  const styles = new Map<string, string>();
  const serverMarkup = new Map<string, { input: string; textarea: string; select: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-root-ref-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "field.html"), `<template component="x-field"><defs>
      <prop name="multiline" type="boolean" default="false">Render a textarea.</prop><prop name="select" type="boolean" default="false">Render a select.</prop><prop name="message" type="string" default="">Field value.</prop>
      </defs><template $match><select $when="$select" from:data-value="$message" from:value="$message"><option value="a">A</option><option value="b">B</option></select><textarea $when="$multiline" from:data-value="$message" from:value="$message"></textarea><input $else from:data-value="$message" from:value="$message"></template><style>
      :host { --declared-value: attr(value/**/); background: rgb(1 2 3); content: attr(/* attribute */value/**/); @media (min-width: 1px) { content: "overridden"; content: attr(/* attribute */value/**/); } }
      :host[/**/value/**/="initial"] { background: rgb(10 20 30); }
      :host { animation: value-label 1s step-end -1s paused both; }
      @keyframes value-label { from { content: "waiting"; } to { content: attr(/* attribute */value/**/); } }
      </style></template>`);
    const definition = parseComponent(await readFile(join(directory, "field.html"), "utf8"));
    nativeCss = compileComponentStylesForBuild(definition.css, definition).css;
    for (const target of ["react", "preact"] as const) {
      const output = join(directory, target);
      const manifest = await convertComponents({ target, mode: "library", entries: ["field.html"], root: directory, outDirectory: output });
      styles.set(target, (await Promise.all(manifest.output.artifacts.filter(artifact => artifact.kind === "style").map(artifact => readFile(join(output, artifact.path), "utf8")))).join("\n"));
      const entry = join(output, "entry.tsx");
      const react = target === "react" ? "react" : "preact/compat";
      const client = target === "react" ? "react-dom/client" : "preact/compat/client";
      await writeFile(entry, `import React from "${react}"; import { createRoot, hydrateRoot } from "${client}";
        import { XField } from "./${manifest.output.entry}";
        let root;
        window.refs = []; window.refValues = []; window.renders = 0;
        function App() {
          const [element, setElement] = React.useState(null), [value, setValue] = React.useState("initial"), [multiline, setMultiline] = React.useState(window.initialTag === "textarea"), [select, setSelect] = React.useState(window.initialTag === "select");
          if (++window.renders > 20) throw Error("Ref publication caused a render loop");
          const ref = React.useCallback(node => { window.refs.push(node?.localName ?? null); if (node) window.refValues.push(node.getAttribute("value")); setElement(node); }, []);
          window.change = value => setValue(value ?? "changed"); window.switchRoot = () => setMultiline(true); window.switchSelect = () => setSelect(true); window.unmount = () => root.unmount();
          return React.createElement(XField, { ref, message: value, multiline, select, id: "field", "data-current": element?.localName, style: { "--inline-value": "attr(value)" } });
        }
        if (document.querySelector("main").hasChildNodes()) root = hydrateRoot(document.querySelector("main"), React.createElement(App)); else { root = createRoot(document.querySelector("main")); root.render(React.createElement(App)); }`);
      const bundle = join(output, "app.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" } });
      bundles.set(target, bundle);
      const server = await build({ entryPoints: [join(output, manifest.output.entry)], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
      const require = createRequire(import.meta.url), module = { exports: {} as Record<string, any> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(require, module, module.exports);
      const { createElement } = require(target === "react" ? "react" : "preact");
      const render = target === "react" ? require("react-dom/server").renderToString : require("preact-render-to-string").renderToString;
      serverMarkup.set(target, {
        input: render(createElement(module.exports.XField, { id: "field", message: "initial", multiline: false, select: false, style: { "--inline-value": "attr(value)" } })),
        textarea: render(createElement(module.exports.XField, { id: "field", message: "initial", multiline: true, select: false, style: { "--inline-value": "attr(value)" } })),
        select: render(createElement(module.exports.XField, { id: "field", message: "initial", multiline: false, select: true, style: { "--inline-value": "attr(value)" } })),
      });
    }
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  for (const target of ["react", "preact"]) for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${target} ${engine} serializes native value attributes`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const markup = serverMarkup.get(target)!;
        for (const tag of ["input", "textarea", "select"] as const) {
          const native = tag === "select" ? '<select component="x-field" value="initial" style="--inline-value:attr(value)"><option value="a">A</option><option value="b">B</option></select>'
            : tag === "input" ? '<input component="x-field" value="initial" style="--inline-value:attr(value)">' : '<textarea component="x-field" value="initial" style="--inline-value:attr(value)"></textarea>';
          await page.setContent(`<div id="reference">${native}</div><main>${markup[tag]}</main>`);
          const nativeStyle = await page.addStyleTag({ content: nativeCss });
          const snapshot = (selector: string) => page.locator(selector).evaluate((element: HTMLInputElement) => ({
            value: element.value, defaults: element.defaultValue,
            animated: getComputedStyle(element).animationName, declared: getComputedStyle(element).getPropertyValue("--declared-value").trim(), background: getComputedStyle(element).backgroundColor, content: getComputedStyle(element).content, inline: getComputedStyle(element).getPropertyValue("--inline-value").trim(),
          }));
          const reference = await snapshot("#reference > *");
          assert.notEqual(reference.animated, "none", "the native reference exercises animated attribute reads");
          await nativeStyle.evaluate(style => style.parentNode?.removeChild(style));
          await page.addStyleTag({ content: styles.get(target)! });
          assert.deepEqual(await snapshot("main > *"), reference, `${tag} preserves native defaults and authored CSS before JavaScript`);
          await page.evaluate(tag => { Reflect.set(window, "initialTag", tag); }, tag);
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("console", message => { if (["warning", "error"].includes(message.type())) errors.push(message.text()); });
          await page.addScriptTag({ path: bundles.get(target)! });
          await page.waitForFunction(() => document.querySelector("#field")?.getAttribute("data-current") === Reflect.get(window, "initialTag"));
          assert.deepEqual(await snapshot("main > *"), reference, `${tag} retains its defaults and CSS through hydration`);
          assert.equal(await page.locator("main > *").getAttribute("data-html-next-native-value"), null);
          assert.deepEqual(await page.evaluate(() => Reflect.get(window, "refValues")), ["initial"]);
          for (const value of ["manual", null]) {
            await page.locator("#reference > *, main > *").evaluateAll((elements, value) => { for (const element of elements) { if (value === null) element.removeAttribute("value"); else element.setAttribute("value", value); } }, value);
            const control = await snapshot("main > *");
            const nativeControl = await snapshot("#reference > *");
            assert.equal(control.value, nativeControl.value, "hydration preserves native pristine-value behavior");
            assert.equal(control.defaults, nativeControl.defaults);
            assert.equal(control.content, nativeControl.content);
            assert.equal(control.inline, nativeControl.inline);
          }
          assert.deepEqual(errors, []);
          await page.evaluate(() => Reflect.get(window, "unmount")());
        }
      } finally { await browser.close(); }
    });
    it(`${target} ${engine} retains native value attribute behavior`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage(); page.setDefaultTimeout(3000);
        const warnings: string[] = [];
        page.on("console", message => { if (["warning", "error"].includes(message.type())) warnings.push(message.text()); });
        await page.setContent('<main></main><input id="native" value="initial">');
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.locator("#field").waitFor();
        assert.equal(await page.locator("#field").evaluate(element => element.matches(":defined")), true, "native controls stay defined elements");
        const values = (selector: string) => page.locator(selector).evaluate((element: HTMLInputElement) =>
          [element.value, element.defaultValue, element.getAttribute("value")]);
        for (const value of ["changed", "next"]) {
          await page.evaluate(value => { document.querySelector("#native")!.setAttribute("value", value); Reflect.get(window, "change")(value); }, value);
          await page.waitForFunction(value => document.querySelector("#field")?.getAttribute("data-value") === value, value);
          assert.deepEqual(await values("#field"), await values("#native"));
          if (value === "changed") { await page.locator("#field").fill("edited"); await page.locator("#native").fill("edited"); }
        }
        await page.evaluate(() => Reflect.get(window, "switchRoot")());
        await page.waitForFunction(() => document.querySelector("#field")?.localName === "textarea");
        assert.deepEqual(await values("#field"), ["", "", "next"], "textarea's value attribute is separate from its text default");
        await page.locator("#field").evaluate((element: HTMLTextAreaElement) => {
          const form = document.createElement("form"); form.id = "reset-form"; document.body.append(form);
          element.setAttribute("form", form.id); element.defaultValue = "native default";
        });
        await page.locator("#field").fill("edited");
        assert.deepEqual(await values("#field"), ["edited", "native default", "next"], "native input events retain controller defaults");
        await page.evaluate(() => Reflect.get(window, "change")("later"));
        await page.waitForFunction(() => document.querySelector("#field")?.getAttribute("data-value") === "later");
        assert.deepEqual(await values("#field"), ["edited", "native default", "later"]);
        await page.locator("#reset-form").evaluate((form: HTMLFormElement) => form.reset());
        await page.evaluate(() => Reflect.get(window, "change")("next"));
        await page.waitForFunction(() => document.querySelector("#field")?.getAttribute("data-value") === "next");
        assert.deepEqual(await values("#field"), ["native default", "native default", "next"], "a commit preserves the native reset default and pristine value");
        await page.evaluate(() => Reflect.get(window, "switchSelect")());
        await page.waitForFunction(() => document.querySelector("#field")?.localName === "select");
        assert.deepEqual(await values("#field"), ["a", undefined, "next"], "select's value attribute does not select an option");
        assert.deepEqual(warnings, []);
      } finally { await browser.close(); }
    });
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
