import assert from "node:assert/strict";
import "@formatjs/intl-durationformat/polyfill.js";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit } from "playwright";

import { convertComponents } from "../src/index.js";
import { formattingSource as sharedFormattingSource } from "../../html-next/tests/formatting-fixture.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const formattingSource = sharedFormattingSource.replace("<defs>", `<defs>
  <prop name="·label" type="string" default="Ready">Label.</prop>
  <prop name="__proto__" type="string" default="Prototype safe">Prototype key.</prop>
  <state name="·price" type="number" value="7"></state>
  <state name="choice" type="string" value="$12.50"></state>
  <state name="createFormatValue" type="number" value="9"></state>`).replace("</section>", `<p data-format="identifiers">{$·label} {$·price} {$createFormatValue}<span $each="·row of [2, 1]" $where="$·row &gt; 0">{$·row}</span></p>
  <p data-format="protoName">{$__proto__}</p>
  <p data-format="rawParts">{formatParts($amount, 'currency', { currency: $currency }, $locale)}</p>
  <p data-format="invalidParts">{formatParts(1, 'currency', {}, $locale)}</p>
  <form><textarea cols="50">Total: {format($amount, 'currency', { currency: $currency }, $locale)} due.</textarea>
  <select bind:value="choice"><option>Other</option><option>{format($amount, 'currency', { currency: $currency }, $locale)}</option></select></form></section>`);
const run = promisify(execFile);
const checker = createRequire(new URL("../../html-next-unplugin/package.json", import.meta.url)).resolve("svelte-check/bin/svelte-check");

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";

describe.skipIf(!enabled)("Svelte Intl expression parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<string, { bundle: string; markup: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-formatting-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "formatting.html"), formattingSource);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["formatting.html"] });
      const artifact = manifest.components[0]!.artifact;
      const config = join(outDirectory, "tsconfig.json");
      await writeFile(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true,
        module: "ESNext", moduleResolution: "Bundler", target: "ES2022", allowJs: true }, include: ["svelte/**/*"] }));
      try { await run(process.execPath, [checker, "--tsconfig", config, "--output", "machine"], { cwd: outDirectory }); }
      catch (error) { assert.fail(`${mode} output typechecks: ${(error as { stdout: string }).stdout}`); }
      await writeFile(join(outDirectory, "server.ts"), `import { render } from 'svelte/server';
import Component from './${artifact}'; export const markup = render(Component).body;`);
      const server = join(outDirectory, "server.mjs");
      await build({ entryPoints: [join(outDirectory, "server.ts")], outfile: server, bundle: true,
        platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const { markup } = await import(pathToFileURL(server).href) as { markup: string };
      await writeFile(join(outDirectory, "entry.ts"), `import { mount, hydrate, flushSync } from 'svelte';
import Component from './${artifact}';
const target = document.querySelector('main')!;
(target.hasChildNodes() ? hydrate : mount)(Component, { target }); flushSync();`);
      const bundle = join(outDirectory, "browser.js");
      await build({ entryPoints: [join(outDirectory, "entry.ts")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      outputs.set(mode, { bundle, markup });
    }
  }, 60_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const mode of ["application", "library"]) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "SSR hydration" : "mount"} matches native Intl output and reactive locale changes`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const native = await browser.newPage();
            const svelte = await browser.newPage();
            const errors: string[] = [];
            svelte.on("pageerror", (error) => errors.push(error.message));
            svelte.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
            await native.setContent(`${formattingSource}<main><x-formatting></x-formatting></main>`);
            await native.addScriptTag({ path: liveBundle });
            await native.evaluate(() => window.HtmlRuntime.lowerDocument());
            const output = outputs.get(mode)!;
            await svelte.setContent(`<main>${hydrate ? output.markup : ""}</main>`);
            const read = async (page: typeof svelte) => page.locator("main section").evaluate((root) => ({
              label: root.getAttribute("aria-label"),
              controls: Array.from(root.querySelectorAll("textarea, select"), (element) => element instanceof HTMLTextAreaElement
                ? [element.textContent, element.defaultValue, element.value] : [(element as HTMLSelectElement).value, (element as HTMLSelectElement).selectedIndex, Array.from((element as HTMLSelectElement).options, option => [option.value, option.hasAttribute("data-html-next-option-default") ? option.getAttribute("data-html-next-option-default") === "true" : option.defaultSelected, option.getAttribute("value")])]),
              values: Object.fromEntries(Array.from(root.querySelectorAll("[data-format]"), (element) => [element.getAttribute("data-format"), element.textContent])),
            }));
            if (hydrate) await Promise.all([native, svelte].map((page) => page.locator("textarea").evaluate((element) => { (element as HTMLTextAreaElement).value = "Before hydration"; })));
            await svelte.addScriptTag({ path: output.bundle });
            for (const changed of [false, true]) {
              await svelte.waitForFunction((after) => document.querySelector("main section")?.getAttribute("aria-label") === (after ? "25,00 €" : "$12.50"), changed);
              assert.deepEqual(await read(svelte), await read(native));
              const [nativePixels, sveltePixels] = await Promise.all([native, svelte].map((page) => page.locator("main section").screenshot({ animations: "disabled" })));
              await assertPixelsEqual(svelte, sveltePixels!, nativePixels!, `${engine} ${mode} formatting ${changed}`);
              if (!changed) await Promise.all([native, svelte].map((page) => page.locator("textarea").fill("Edited")));
              if (!changed) await Promise.all([native, svelte].map((page) => page.locator("button").first().click()));
            }
            await Promise.all([native, svelte].map((page) => page.locator("button").last().click()));
            await svelte.waitForFunction(() => document.querySelector('[data-format="list"]')?.textContent === "Zed");
            const retained = await read(svelte);
            assert.deepEqual(retained, await read(native));
            assert.equal(retained.values.currency, "Total: 25,00 € due.");
            assert.equal(retained.values.valueBinding, "25,00 €");
            assert.equal(retained.values.initialInvalid, "Before  after");
            assert.equal(retained.values.initialInvalidBinding, "");
            assert.equal(retained.values.literal, "$amount $HOME $file.name.txt $1.15 {name}");
            assert.equal(retained.values.mixed, "Total: 25,00 € for Zed.");
            assert.equal(retained.values.scoped, "Total: 12,00 € for Zed.");
            assert.equal(retained.values.absent, "");
            await Promise.all([native, svelte].map((page) => page.locator("form").evaluate((form) => (form as HTMLFormElement).reset())));
            assert.deepEqual(await read(svelte), await read(native), "native form reset");
            assert.equal(retained.values.identifiers, "Ready 7 921");
            assert.equal(retained.values.protoName, "Prototype safe");
            assert.deepEqual(errors, []);
          } finally { await browser.close(); }
        });
      }
    }
  }
});
