import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { componentBindingsSource as sharedSource, componentBindingsModule as controller, selectedBindingModule, componentOptionsModule, componentOwnedModule } from "./fixtures/component-bindings.js";

const source = sharedSource.replace("</form>", `  <x-literal-number id="mixed-from" value="14" from:value="selected.value"></x-literal-number>
  <x-literal-number id="mixed-bind" value="14" bind:value="selected.value"></x-literal-number>
  <x-literal-number id="mixed-invalid-from" value="14" from:value="literalInput.value"></x-literal-number>
  <x-literal-number id="mixed-invalid-bind" value="14" bind:value="literalInput.value"></x-literal-number>
  <x-literal-number $each="row, index of [1, 2]" from:id="concat('mixed-row-', index)" value="14" from:value="literalInput.value"></x-literal-number>
  <x-literal-number id="literal-number" value="14"></x-literal-number>
  <x-literal-boolean id="literal-boolean" value></x-literal-boolean>
  <x-literal-list id="literal-list" value="One Two"></x-literal-list>
  <x-prop-field id="literal-selected" value="14" from:mode="mode"></x-prop-field>
</form>`).replace('<state name="selected"', '<state name="literalInput" type="object({ value: unknown })" value="{ value: \'invalid\' }"></state><state name="selected"') + `<template component="x-literal-number" status="early" summary="Literal number handle." controller="./selected.js"><defs><prop name="value" type="number" default="5">Value.</prop></defs><output .value="value"></output></template>
<template component="x-literal-boolean" status="early" summary="Literal boolean handle." controller="./selected.js"><defs><prop name="value" type="boolean" default="false">Value.</prop></defs><output .value="value"></output></template>
<template component="x-literal-list" status="early" summary="Literal list handle." controller="./selected.js"><defs><prop name="value" type="keyword+">Value.</prop></defs><output .value="value"></output></template>
`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => ({
      amount: root.querySelector("#amount")?.textContent,
      text: root.querySelector("#label")?.textContent,
      flag: root.querySelector("#checked")?.textContent,
      generic: (() => { const output = root.querySelector<HTMLOutputElement>("#untyped-output"); return output === null ? null : {
        attribute: output.getAttribute("value"), value: output.value, defaultValue: output.defaultValue,
      }; })(),
      changingRoots: Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLOutputElement>("#native-switch, #delegated-switch"), (element) => ({
        id: element.id, tag: element.localName, value: element.value, defaultValue: element.defaultValue, attribute: element.getAttribute("value"), mode: element.getAttribute("data-mode"),
      })),
      genericEdges: Array.from(root.querySelectorAll<HTMLOutputElement>("#unbound-output, #prototype-output, #typed-generic"), (element) => ({
        id: element.id, value: element.value, attribute: element.getAttribute("value"), prototype: element.getAttribute("__proto__"), constructor: element.getAttribute("constructor"),
      })),
      area: (() => { const element = root.querySelector<HTMLTextAreaElement>("#untyped-area"); return element === null ? null : {
        value: element.value, attribute: element.getAttribute("value"), defaultValue: element.defaultValue,
      }; })(),
      selects: Array.from(root.querySelectorAll("select"), (element) => ({
        value: element.value, attribute: element.getAttribute("value"),
        options: Array.from(element.options, (option) => ({ value: option.value, selected: option.selected, defaultSelected: option.defaultSelected })),
      })),
      controls: Array.from(root.querySelectorAll("input"), (element) => ({
        value: element.value, title: element.title, checked: element.checked, defaultValue: element.defaultValue,
        defaultChecked: element.defaultChecked, files: element.type === "file" ? Array.from(element.files ?? [], (file) => file.name) : undefined, amount: element.getAttribute("data-amount"),
        text: element.getAttribute("data-value"), local: element.getAttribute("data-local"), flag: element.getAttribute("data-checked"),
        valid: element.getAttribute("data-valid"),
      })),
    })),
    selected: await page.evaluate(() => Object.fromEntries(Object.entries((window as unknown as {
      selectedHosts: Record<string, { props: { value: { value: unknown; inputValue: unknown; validity: { valid: boolean } } } }>;
    }).selectedHosts).sort().map(([id, host]) => [id, { value: host.props.value.value, input: host.props.value.inputValue, valid: host.props.value.validity.valid }]))),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte component binding parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-component-binding-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "fields.html"), source);
    await writeFile(join(directory, "fields.js"), controller);
    await writeFile(join(directory, "selected.js"), selectedBindingModule);
    await writeFile(join(directory, "options.js"), componentOptionsModule);
    await writeFile(join(directory, "owned.js"), componentOwnedModule);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["fields.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      await writeFile(join(outDirectory, "App.svelte"), `<script>import XFields from "./${manifest.components.find((component) => component.tag === "x-bound-fields")!.artifact}";</script><XFields id="case" />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("main")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
      const bundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /data-amount="12"/);
      assert.match(markup, /value="Ready"/);
      for (const [id, value] of [["state-selected", "12"], ["prop-selected", "12"], ["literal-selected", "14"]]) {
        const input = markup.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
        assert.ok(input);
        assert.match(input, new RegExp(`data-value="${value}"`));
        assert.match(input, new RegExp(`value="${value}"`));
      }
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} updates native typed component props from root controls`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          const errors: string[] = [];
          const warnings: string[] = [];
          try {
            const live = await browser.newPage(); pages.push(live);
            const svelte = await browser.newPage(); pages.push(svelte);
            const output = outputs.get(mode)!;
            for (const page of pages) {
              page.setDefaultTimeout(5_000);
              page.on("pageerror", (error) => errors.push(error.message));
              page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
              await page.route("https://app.example/**", (route) => {
                const url = route.request().url();
                if (url.endsWith("/fields.html")) return route.fulfill({ contentType: "text/html", body: source });
                if (url.endsWith("/owned.js")) return route.fulfill({ contentType: "text/javascript", body: componentOwnedModule });
                if (url.endsWith("/options.js")) return route.fulfill({ contentType: "text/javascript", body: componentOptionsModule });
                if (url.endsWith("/selected.js")) return route.fulfill({ contentType: "text/javascript", body: selectedBindingModule });
                if (url.endsWith("/fields.js")) return route.fulfill({ contentType: "text/javascript", body: controller });
                return route.fulfill({ contentType: "text/html", body: page === live
                  ? '<link rel="component" href="/fields.html"><main><x-bound-fields id="case"></x-bound-fields></main>'
                  : `<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>` });
              });
            }
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
            if (hydrate) {
              const native = await live.locator("#untyped-output").evaluate((element) => ({ attribute: element.getAttribute("value"), text: element.textContent }));
              const server = await svelte.locator("#untyped-output").evaluate((element) => ({ attribute: element.getAttribute("value"), text: element.textContent }));
              assert.deepEqual(server, native, "SSR generic binding differs before hydration");
              for (const id of ["unbound-output", "prototype-output"]) {
                const read = (element: Element) => ({ text: element.textContent, value: element.getAttribute("value"), prototype: element.getAttribute("__proto__"), constructor: element.getAttribute("constructor") });
                assert.deepEqual(await svelte.locator(`#${id}`).evaluate(read), await live.locator(`#${id}`).evaluate(read), `SSR ${id} differs`);
              }
              for (const id of ["untyped-number", "untyped-flag", "untyped-raw-flag", "raw-binding-flag", "raw-property-flag", "radio-first", "radio-second", "untyped-file"]) {
                const read = (element: Element) => ({ value: (element as HTMLInputElement).value, checked: (element as HTMLInputElement).checked });
                assert.deepEqual(await svelte.locator(`#${id}`).evaluate(read), await live.locator(`#${id}`).evaluate(read));
              }
              for (const id of ["untyped-area", "untyped-select", "untyped-multiple", "plain-select", "unbound-select", "literal-select", "plain-root-select"]) {
                const read = (element: Element) => ({ value: (element as HTMLInputElement).value, selected: element instanceof HTMLSelectElement ? Array.from(element.selectedOptions, (option) => option.value) : undefined });
                assert.deepEqual(await svelte.locator(`#${id}`).evaluate(read), await live.locator(`#${id}`).evaluate(read), `SSR ${id} differs`);
              }
              await Promise.all(pages.map((page) => page.locator("#untyped-area").evaluate((element) => { (element as HTMLTextAreaElement).value = "Native edit"; })));
              await Promise.all(pages.map((page) => page.locator("#untyped-number").evaluate((element) => { (element as HTMLInputElement).value = "31"; })));
            }
            await svelte.addScriptTag({ path: output.bundle });
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (window as unknown as { ownedHost?: unknown }).ownedHost !== undefined && (window as unknown as { fieldsHost?: unknown }).fieldsHost !== undefined && Object.keys((window as unknown as { selectedHosts?: object }).selectedHosts ?? {}).length === 12 && Object.keys((window as unknown as { optionHosts?: object }).optionHosts ?? {}).length === 3)));
            const compare = async () => {
              const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(converted.behavior, native.behavior);
              assert.deepEqual(converted.selected, native.selected);
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte component binding pixels differ", live);
            };
            await compare();
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { ownedHost: { state: { local: string } } }).ownedHost.state.local = "Child update";
            })));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#owned-input").evaluate((element) => {
              (element as HTMLInputElement).value = "External local";
              (element as HTMLInputElement).title = "External title";
              element.setAttribute("data-local", "External data");
            })));
            for (const local of [42, "Child recovered"]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { ownedHost: { state: { local: unknown } } }).ownedHost.state.local = value;
              }, local)));
              await compare();
            }
            await Promise.all(pages.map((page) => page.locator("#typed-generic").evaluate((element) => element.setAttribute("value", "External attribute"))));
            for (const text of [42, "Parent recovered"]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { fieldsHost: { state: { form: { text: unknown } } } }).fieldsHost.state.form.text = value;
              }, text)));
              await compare();
            }
            for (const page of pages) {
              await page.locator("#number").fill("17");
              await page.locator("#text").fill("Changed");
              await page.locator("#flag").uncheck();
            }
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              document.querySelector("#amount")?.textContent === "17" &&
              document.querySelector("#label")?.textContent === "Changed" && document.querySelector("#checked")?.textContent === "false")));
            await compare();
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { fieldsHost: { state: { form: Record<string, unknown> } } }).fieldsHost.state.form.amount = "invalid";
            })));
            await compare();
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { fieldsHost: { state: { form: { amount: number; text: string; checked: boolean } } } })
                .fieldsHost.state.form = { amount: 23, text: "Model", checked: true };
            })));
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (document.querySelector("#number") as HTMLInputElement).value === "23")));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#number").fill("")));
            await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector("#amount")?.textContent === "")));
            await compare();
            const setSelected = async (value: unknown) => {
              await Promise.all(pages.map((page) => page.evaluate((next) => {
                (window as unknown as { fieldsHost: { state: { selected: { value: unknown } } } }).fieldsHost.state.selected.value = next;
              }, value)));
            };
            const setMode = async (owner: "state" | "prop", mode: "number" | "text" | "none") => {
              await Promise.all(pages.map((page) => page.evaluate(({ owner, mode }) => {
                const globals = window as unknown as { fieldsHost: { state: { mode: string } }; selectedHosts: Record<string, { state: { mode: string } }> };
                (owner === "state" ? globals.selectedHosts["state-selected"]! : globals.fieldsHost).state.mode = mode;
              }, { owner, mode })));
            };
            const compareSelected = async (state: readonly [unknown, unknown, boolean], prop: readonly [unknown, unknown, boolean]) => {
              await compare();
              const actual = (await snapshot(live)).selected;
              assert.deepEqual(Object.fromEntries(Object.entries(actual).filter(([id]) => !id.startsWith("mixed-"))), { "state-selected": { value: state[0], input: state[1], valid: state[2] },
                "prop-selected": { value: prop[0], input: prop[1], valid: prop[2] },
                "literal-number": { value: 14, input: "14", valid: true },
                "literal-selected": { value: 14, input: "14", valid: true },
                "literal-boolean": { value: true, input: "", valid: true },
                "literal-list": { value: ["One", "Two"], input: "One Two", valid: true } });
            };
            await compareSelected([12, 12, true], [12, 12, true]);
            const initialMixed = (await snapshot(live)).selected;
            for (const id of ["mixed-from", "mixed-bind"]) assert.deepEqual(initialMixed[id], { value: 12, input: 12, valid: true });
            for (const id of ["mixed-invalid-from", "mixed-invalid-bind", "mixed-row-0", "mixed-row-1"]) assert.deepEqual(initialMixed[id], { value: 14, input: "14", valid: true });
            await setMode("state", "text");
            await compareSelected([12, 12, false], [12, 12, true]);
            await setSelected("Hello");
            await compareSelected(["Hello", "Hello", true], [12, 12, true]);
            await setMode("prop", "text");
            await compareSelected(["Hello", "Hello", true], ["Hello", "Hello", true]);
            await setSelected(42);
            await compareSelected(["Hello", "Hello", true], ["Hello", "Hello", true]);
            await setMode("state", "number");
            await compareSelected([42, 42, true], ["Hello", "Hello", true]);
            await Promise.all(pages.map((page) => page.locator("#state-selected").fill("5")));
            await compareSelected([5, 5, true], ["Hello", "Hello", true]);
            await setMode("prop", "number");
            await compareSelected([5, 5, true], [5, 5, true]);
            await Promise.all(pages.map((page) => page.locator("#state-selected").fill("")));
            await compareSelected([5, 5, true], [5, 5, true]);
            await setSelected(17);
            await compareSelected([17, 17, true], [17, 17, true]);
            await setMode("state", "none");
            await compareSelected([17, 17, false], [17, 17, true]);
            await setSelected(null);
            await compareSelected([17, 17, false], [17, 17, true]);
            await setMode("state", "number");
            await compareSelected([17, 17, true], [17, 17, true]);
            for (const next of [14, "invalid", 6, null]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { fieldsHost: { state: { literalInput: { value: unknown } } } }).fieldsHost.state.literalInput.value = value;
              }, next)));
              await compare();
              const mixed = (await snapshot(live)).selected;
              const value = next === 14 || next === "invalid" ? 14 : 6;
              for (const id of ["mixed-invalid-from", "mixed-invalid-bind", "mixed-row-0", "mixed-row-1"]) assert.deepEqual(mixed[id], { value, input: value, valid: true });
            }
            await Promise.all(pages.map((page) => page.locator("#untyped-number").fill("23")));
            await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector("#amount")?.textContent === "23")));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#untyped-flag").check()));
            await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector("#checked")?.textContent === "true")));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#untyped-output").evaluate((element) => {
              (element as HTMLOutputElement).value = "Edited";
              element.dispatchEvent(new Event("input", { bubbles: true }));
            })));
            await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector("#label")?.textContent === "Edited")));
            await compare();
            for (const rootMode of ["area", "generic", "area", "field"]) {
              await Promise.all(pages.map((page) => page.evaluate((mode) => {
                (window as unknown as { fieldsHost: { state: { rootMode: string } } }).fieldsHost.state.rootMode = mode;
              }, rootMode)));
              await compare();
              if (rootMode === "area") await Promise.all(pages.map((page) => page.locator("#delegated-switch").fill("Area bridged")));
              else if (rootMode === "generic") await Promise.all(pages.map((page) => page.locator("#delegated-switch").evaluate((element) => {
                (element as HTMLOutputElement).value = "Generic bridged";
                element.dispatchEvent(new Event("input", { bubbles: true }));
              })));
              await compare();
            }
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { fieldsHost: { state: { choices: string[] } } }).fieldsHost.state.choices.push("c");
            })));
            await compare();
            assert.equal(await live.locator("#untyped-array").evaluate((element) => (element as HTMLInputElement).defaultValue), "a b");
            for (const checked of [[], {}, [1], { present: true }, false, true, 0, 1, "", "checked"]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { fieldsHost: { state: { rawChecked: { value: unknown } } } }).fieldsHost.state.rawChecked.value = value;
              }, checked)));
              await compare();
            }
            await Promise.all(pages.map((page) => page.locator("#radio-second").check()));
            await compare();
            const radios = await live.evaluate(() => (window as unknown as { fieldsHost: { state: { radios: { first: boolean; second: boolean } } } }).fieldsHost.state.radios);
            assert.deepEqual(radios, { first: true, second: true });
            assert.deepEqual(await svelte.evaluate(() => (window as unknown as { fieldsHost: { state: { radios: { first: boolean; second: boolean } } } }).fieldsHost.state.radios), radios);
            await Promise.all(pages.map((page) => page.locator("#radio-first").dispatchEvent("change")));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#untyped-file").setInputFiles({ name: "bound.txt", mimeType: "text/plain", buffer: Buffer.from("Bound file") })));
            await compare();
            for (const page of pages) assert.match(await page.evaluate(() => (window as unknown as { fieldsHost: { state: { file: string } } }).fieldsHost.state.file), /bound\.txt$/);
            await Promise.all(pages.map((page) => page.evaluate(() => {
              (window as unknown as { fieldsHost: { state: { file: string } } }).fieldsHost.state.file = "";
            })));
            await compare();
            for (const optionValue of ["bb", "b"]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                const hosts = (window as unknown as { optionHosts: Record<string, { state: { optionValue: string } }> }).optionHosts;
                for (const host of Object.values(hosts)) host.state.optionValue = value;
              }, optionValue)));
              await compare();
            }
            await Promise.all(pages.map((page) => page.locator("#untyped-area").fill("Area edit")));
            await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector("#label")?.textContent === "Area edit")));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#untyped-select").selectOption("c")));
            await compare();
            await Promise.all(pages.map((page) => page.evaluate(() => {
              const hosts = (window as unknown as { optionHosts: Record<string, { state: { hasC: boolean } }> }).optionHosts;
              for (const host of Object.values(hosts)) host.state.hasC = false;
            })));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#untyped-multiple").selectOption(["b"])));
            await compare();
            await Promise.all(pages.map((page) => page.locator("#case").evaluate((element) => (element as HTMLFormElement).reset())));
            await compare();
            assert.deepEqual(errors, []);
            assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
          } catch (error) {
            const observed = await Promise.all(pages.map((page) => page.evaluate(() => ({
              html: document.querySelector("main")?.innerHTML,
            }))));
            throw new Error(JSON.stringify({ observed, errors, warnings }), { cause: error });
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
      }
    }
  }
});
