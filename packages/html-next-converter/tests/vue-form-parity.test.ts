import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const source = `<template component="x-email" status="early" summary="A form-associated email control."><defs>
  <state name="email" value=""></state>
</defs><input type="email" name="email" required bind:value="email" from:data-current="email"></template>`;
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
  readonly submits: readonly (readonly [string, string])[][];
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
        data: Array.from(new FormData(form), ([name, value]) => [name, String(value)] as [string, string]),
        invalidEvents: window.formTrace.invalid,
        submits: window.formTrace.submits,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter form-associated root parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly client: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-form-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "email.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/email.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-email"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `forms-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `forms-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `forms-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(serverTemplate.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XEmail } from "./vue/${mode === "application" ? "application" : "index"}";
createApp({ render: () => [h("form", { id: "owner" }, h("button", { type: "submit" }, "Send")), h(XEmail, { id: "case", form: "owner", placeholder: "Email" })] }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XEmail } from "./vue/${mode === "application" ? "application" : "index"}";
createSSRApp({ render: () => [h("form", { id: "owner" }, h("button", { type: "submit" }, "Send")), h(XEmail, { id: "case", form: "owner", placeholder: "Email" })] }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XEmail } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => [h("form", { id: "owner" }, h("button", { type: "submit" }, "Send")), h(XEmail, { id: "case", form: "owner", placeholder: "Email" })] }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      converted.set(mode, { client: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} preserves external form association, validation, and submission after hydration`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${source}<main>${invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          const output = converted.get(mode)!;
          await vue.addScriptTag({ path: output.client });
          await hydrated.setContent(`<main>${output.server}</main>`);
          await Promise.all([live, hydrated].map((page) => page.evaluate(() => {
            window.formTrace = { invalid: 0, submits: [] };
          })));
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.behavior, serverLive.behavior, "server-rendered form behavior differs");
          await assertPixelsEqual(hydrated, serverHydrated.pixels, serverLive.pixels, "server-rendered form pixels differ");
          await hydrated.addScriptTag({ path: output.hydrate });
          await Promise.all(pages.map((page) => page.evaluate(() => {
            window.formTrace = { invalid: 0, submits: [] };
            const form = document.querySelector<HTMLFormElement>("#owner")!;
            document.querySelector("#case")!.addEventListener("invalid", () => { window.formTrace.invalid += 1; });
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              window.formTrace.submits.push(Array.from(new FormData(form), ([name, value]) => [name, String(value)] as [string, string]));
            });
          })));
          const compare = async (stage: string) => {
            const [actualLive, actualVue, actualHydrated] = await Promise.all([snapshot(live), snapshot(vue), snapshot(hydrated)]);
            assert.deepEqual(actualVue.behavior, actualLive.behavior, `${stage} form behavior differs`);
            await assertPixelsEqual(vue, actualVue.pixels, actualLive.pixels, `${stage} form pixels differ`);
            assert.deepEqual(actualHydrated.behavior, actualLive.behavior, `${stage} hydrated form behavior differs`);
            await assertPixelsEqual(hydrated, actualHydrated.pixels, actualLive.pixels, `${stage} hydrated form pixels differ`);
            return actualLive.behavior;
          };
          const initial = await compare("initial");
          assert.equal(initial.tag, "input");
          assert.equal(initial.owner, "owner");
          assert.equal(initial.inElements, true);
          assert.equal(initial.valueMissing, true);
          assert.deepEqual(initial.data, [["email", ""]]);
          assert.equal(initial.invalidEvents, 0);

          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const rejected = await compare("invalid submission");
          assert.deepEqual(rejected.submits, []);
          assert.equal(rejected.invalidEvents, 1);

          for (const page of pages) await page.locator("#case").fill("not-an-email");
          const malformed = await compare("malformed address");
          assert.equal(malformed.typeMismatch, true);
          assert.equal(malformed.current, "not-an-email");
          assert.deepEqual(malformed.submits, []);
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const malformedRejected = await compare("malformed-address submission");
          assert.equal(malformedRejected.invalidEvents, 2);
          assert.deepEqual(malformedRejected.submits, []);

          for (const page of pages) await page.locator("#case").fill("a@example.test");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const accepted = await compare("valid submission");
          assert.equal(accepted.valid, true);
          assert.deepEqual(accepted.data, [["email", "a@example.test"]]);
          assert.deepEqual(accepted.submits, [[["email", "a@example.test"]]]);
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
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
  interface Window { formTrace: { invalid: number; submits: Array<Array<[string, string]>> } }
}
