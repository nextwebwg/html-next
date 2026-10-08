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
const source = `<template component="x-email" status="early" summary="A form-associated email control."><defs>
  <state name="email" value=""></state>
</defs><input type="email" name="email" required bind:value="email" from:data-current="$email"></template>`;
const invocation = `<form id="owner"><button type="submit">Send</button></form><x-email id="case" form="owner" placeholder="Email"></x-email>`;

type FormBehavior = {
  readonly tag: string;
  readonly owner: string | null;
  readonly inElements: boolean;
  readonly value: string;
  readonly current: string | null;
  readonly valid: boolean;
  readonly valueMissing: boolean;
  readonly typeMismatch: boolean;
  readonly data: readonly (readonly [string, string])[];
  readonly invalidEvents: number;
  readonly submits: readonly (readonly (readonly [string, string])[])[];
};

async function snapshot(page: Page): Promise<{ readonly behavior: FormBehavior; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const control = document.querySelector<HTMLInputElement>("#case")!;
      const form = document.querySelector<HTMLFormElement>("#owner")!;
      return {
        tag: control.localName,
        owner: control.form?.id ?? null,
        inElements: Array.from(form.elements).includes(control),
        value: control.value,
        current: control.getAttribute("data-current"),
        valid: form.matches(":valid"),
        valueMissing: control.validity.valueMissing,
        typeMismatch: control.validity.typeMismatch,
        data: Array.from(new FormData(form), ([name, value]) => [name, String(value)] as const),
        invalidEvents: window.formTrace.invalid,
        submits: window.formTrace.submits,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public React converter form-associated root parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly client: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-form-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "email.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["components/email.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-email"]);
      const entry = join(outDirectory, "entry.tsx");
      const client = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XEmail } from "./react/${mode === "application" ? "application" : "index"}";
const tree = <><form id="owner"><button type="submit">Send</button></form><XEmail id="case" form="owner" placeholder="Email" /></>;
const main = document.querySelector("main")!;
if (main.hasChildNodes()) hydrateRoot(main, tree);
else createRoot(main).render(tree);
`);
      await build({ entryPoints: [entry], outfile: client, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
      const serverBuild = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as { XEmail: React.ComponentType<Record<string, unknown>> } };
      new Function("require", "module", "exports", serverBuild.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const server = renderToString(React.createElement(React.Fragment, null,
        React.createElement("form", { id: "owner" }, React.createElement("button", { type: "submit" }, "Send")),
        React.createElement(module.exports.XEmail, { id: "case", form: "owner", placeholder: "Email" })));
      converted.set(mode, { client, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} preserves external form association, validation, and submission after hydration`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, react, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
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
          await hydrated.setContent(`<main>${output.server}</main>`);
          for (const page of pages) await page.evaluate(() => { window.formTrace = { invalid: 0, submits: [] }; });
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.behavior, serverLive.behavior, "server-rendered form behavior differs");
          await assertPixelsEqual(hydrated, serverHydrated.pixels, serverLive.pixels, "server-rendered form pixels differ", live);
          await hydrated.addScriptTag({ path: output.client });
          for (const page of pages) await page.evaluate(() => {
            window.formTrace = { invalid: 0, submits: [] };
            const form = document.querySelector<HTMLFormElement>("#owner")!;
            document.querySelector("#case")!.addEventListener("invalid", () => { window.formTrace.invalid += 1; });
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              window.formTrace.submits.push(Array.from(new FormData(form), ([name, value]) => [name, String(value)] as [string, string]));
            });
          });
          const compare = async (stage: string): Promise<FormBehavior> => {
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
          assert.equal(initial.tag, "input");
          assert.equal(initial.owner, "owner");
          assert.equal(initial.inElements, true);
          assert.equal(initial.valueMissing, true);
          assert.deepEqual(initial.data, [["email", ""]]);

          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const rejected = await compare("empty submission");
          assert.deepEqual(rejected.submits, []);
          assert.equal(rejected.invalidEvents, 1);

          for (const page of pages) await page.locator("#case").fill("not-an-email");
          const malformed = await compare("malformed address");
          assert.equal(malformed.typeMismatch, true);
          assert.equal(malformed.current, "not-an-email");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const malformedRejected = await compare("malformed submission");
          assert.equal(malformedRejected.invalidEvents, 2);
          assert.deepEqual(malformedRejected.submits, []);

          for (const page of pages) await page.locator("#case").fill("a@example.test");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const accepted = await compare("valid submission");
          assert.equal(accepted.valid, true);
          assert.deepEqual(accepted.data, [["email", "a@example.test"]]);
          assert.deepEqual(accepted.submits, [[["email", "a@example.test"]]]);
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    formTrace: { invalid: number; submits: Array<Array<[string, string]>> };
  }
}
