import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
const source = `<template component="x-choice" status="early" summary="A form-associated select."><defs>
  <state name="choice" value="b"></state>
</defs><select name="choice" required bind:value="choice" from:data-current="choice">
  <option value="">Choose</option><option value="a" selected>Alpha</option><option value="b">Beta</option>
</select></template>`;
const invocation = `<form id="owner"><button type="submit">Send</button></form><x-choice id="case" form="owner"></x-choice>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>("#case")!;
      const form = document.querySelector<HTMLFormElement>("#owner")!;
      return {
        tag: select.localName,
        owner: select.form?.id ?? null,
        inElements: Array.from(form.elements).includes(select),
        value: select.value,
        current: select.getAttribute("data-current"),
        selected: Array.from(select.options, (option) => [option.value, option.selected, option.defaultSelected]),
        valid: form.matches(":valid"),
        valueMissing: select.validity.valueMissing,
        data: Array.from(new FormData(form), ([name, value]) => [name, String(value)]),
        invalidEvents: window.selectFormTrace.invalid,
        submits: window.selectFormTrace.submits,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public React converter form-associated select root parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly client: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-select-form-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "choice.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["components/choice.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-choice"]);
      const entry = join(outDirectory, "entry.tsx");
      const client = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XChoice } from "./react/${mode === "application" ? "application" : "index"}";
const tree = <><form id="owner"><button type="submit">Send</button></form><XChoice id="case" form="owner" /></>;
const main = document.querySelector("main")!;
if (main.hasChildNodes()) hydrateRoot(main, tree);
else createRoot(main).render(tree);
`);
      await build({ entryPoints: [entry], outfile: client, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
      const serverBuild = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as { XChoice: React.ComponentType<Record<string, unknown>> } };
      new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const server = renderToString(React.createElement(React.Fragment, null,
        React.createElement("form", { id: "owner" }, React.createElement("button", { type: "submit" }, "Send")),
        React.createElement(module.exports.XChoice, { id: "case", form: "owner" })));
      converted.set(mode, { client, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} preserves external select ownership, selection, validation, and reset after hydration`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, react, hydrated, liveServer] = await Promise.all([
          browser.newPage(), browser.newPage(), browser.newPage(), browser.newPage(),
        ]);
        const pages = [live, react, hydrated];
        const errors: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main>${invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          const output = converted.get(mode)!;
          await react.setContent("<main></main>");
          await react.addScriptTag({ path: output.client });
          await react.locator("#case").waitFor();
          const serializedLive = await live.evaluate(() =>
            (window.HtmlRuntime as typeof window.HtmlRuntime & { serializeRenderedForm(container: Element): string })
              .serializeRenderedForm(document.querySelector("main")!));
          await liveServer.setContent(`<main>${serializedLive}</main>`);
          await hydrated.setContent(`<main>${output.server}</main>`);
          for (const page of [liveServer, hydrated]) await page.evaluate(() => { window.selectFormTrace = { invalid: 0, submits: [] }; });
          const [serverLive, serverHydrated] = await Promise.all([snapshot(liveServer), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.behavior, serverLive.behavior, "server-rendered select behavior differs");
          await assertPixelsEqual(hydrated, serverHydrated.pixels, serverLive.pixels, "server-rendered select pixels differ", liveServer);
          await hydrated.addScriptTag({ path: output.client });
          for (const page of pages) await page.evaluate(() => {
            window.selectFormTrace = { invalid: 0, submits: [] };
            const form = document.querySelector<HTMLFormElement>("#owner")!;
            document.querySelector("#case")!.addEventListener("invalid", () => { window.selectFormTrace.invalid += 1; });
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              window.selectFormTrace.submits.push(Array.from(new FormData(form), ([name, value]) => [name, String(value)] as [string, string]));
            });
          });
          const compare = async (stage: string) => {
            const [native, convertedReact, convertedHydrated] = await Promise.all([
              snapshot(live), snapshot(react), snapshot(hydrated),
            ]);
            assert.deepEqual(convertedReact.behavior, native.behavior, `${stage} React form behavior differs`);
            await assertPixelsEqual(react, convertedReact.pixels, native.pixels, `${stage} React form pixels differ`, live);
            assert.deepEqual(convertedHydrated.behavior, native.behavior, `${stage} hydrated form behavior differs`);
            await assertPixelsEqual(hydrated, convertedHydrated.pixels, native.pixels, `${stage} hydrated form pixels differ`, live);
            return native.behavior;
          };
          const initial = await compare("initial");
          assert.equal(initial.tag, "select");
          assert.equal(initial.owner, "owner");
          assert.equal(initial.inElements, true);
          assert.equal(initial.value, "b");
          assert.deepEqual(initial.data, [["choice", "b"]]);

          for (const page of pages) await page.locator("#case").selectOption("");
          const empty = await compare("required selection cleared");
          assert.equal(empty.valueMissing, true);
          assert.equal(empty.current, "");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const rejected = await compare("invalid submission");
          assert.deepEqual(rejected.submits, []);
          assert.equal(rejected.invalidEvents, 1);

          for (const page of pages) await page.locator("#case").selectOption("a");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const accepted = await compare("valid submission");
          assert.deepEqual(accepted.data, [["choice", "a"]]);
          assert.deepEqual(accepted.submits, [[["choice", "a"]]]);

          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.reset());
          const reset = await compare("native reset");
          assert.equal(reset.value, "a");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([...pages, liveServer].map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    selectFormTrace: { invalid: number; submits: Array<Array<[string, string]>> };
  }
}
