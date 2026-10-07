import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { convertComponents, type ConversionGraph } from "../src/index.js";
import { receiver, consumer, dynamicReceiver, dynamicConsumer } from "./fixtures/scoped-slot-diagnostics.js";
import { sveltePlugin } from "./helpers/svelte.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
type Kind = "static" | "dynamic";
type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };
const expected: Diagnostic = { name: "HtmlDiagnosticError", code: "HR007",
  message: 'HR007: Scoped slot `row` requires a consumer <template slot="row">.' };

describe.skipIf(!enabled)("Svelte invalid scoped-slot consumer parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<ConversionGraph, { readonly client: string; readonly render: (kind: Kind) => string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-slot-diagnostic-"));
    await mkdir(join(directory, "components"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, source] of [["receiver", receiver], ["consumer", consumer],
      ["dynamic-receiver", dynamicReceiver], ["dynamic-consumer", dynamicConsumer]] as const) {
      await writeFile(join(directory, "components", `${name}.html`), source);
    }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime",
      platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory,
        entries: ["components/consumer.html", "components/dynamic-consumer.html"] });
      const entry = join(outDirectory, "client.ts");
      const client = join(outDirectory, "client.js");
      await writeFile(entry, `import { mount, flushSync } from "svelte";
import { XInvalidScopedConsumer, XInvalidDynamicScopedConsumer } from "./${manifest.output.entry}";
const Component = window.scopedSlotKind === "dynamic" ? XInvalidDynamicScopedConsumer : XInvalidScopedConsumer;
try { flushSync(() => mount(Component, { target: document.querySelector("#mount")!, props: { id: "case" } })); }
catch (error) { window.svelteScopedSlotDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message }; }`);
      await build({ entryPoints: [entry], outfile: client, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, nodePaths: [nodeModules], plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const server = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server";
import { XInvalidScopedConsumer, XInvalidDynamicScopedConsumer } from "./${manifest.output.entry}";
export const markup = (kind) => render(kind === "static" ? XInvalidScopedConsumer : XInvalidDynamicScopedConsumer, { props: { id: "case" } }).body;`);
      await build({ entryPoints: [serverEntry], outfile: server, bundle: true, format: "esm", platform: "node", packages: "external",
        loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const module = await import(pathToFileURL(server).href) as { markup(kind: Kind): string };
      outputs.set(mode, { client, render: module.markup });
    }
  });
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const kind of ["static", "dynamic"] as const) {
      it(`${mode} ${kind} SSR reports HR007`, () => {
        assert.throws(() => outputs.get(mode)!.render(kind), (error) => {
          const failure = error as Error & { diagnostic?: { code?: string } };
          assert.deepEqual({ name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message }, expected);
          return true;
        });
      });
    }
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const kind of ["static", "dynamic"] as const) {
        it(`${engine} ${mode} ${kind} preserves the live diagnostic`, async () => {
          const browser = await browserType.launch({ headless: true });
          const [live, converted] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            const tag = kind === "static" ? "x-invalid-scoped-consumer" : "x-invalid-dynamic-scoped-consumer";
            await live.setContent(`${receiver}${consumer}${dynamicReceiver}${dynamicConsumer}<${tag} id="case"></${tag}>`);
            await live.addScriptTag({ path: liveBundle });
            const native = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const failure = error as Error & { diagnostic?: { code?: string } };
                return { name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message };
              }
            });
            await converted.setContent("<div id=mount></div>");
            await converted.evaluate((value) => { window.scopedSlotKind = value; }, kind);
            await converted.addScriptTag({ path: outputs.get(mode)!.client });
            await converted.waitForFunction(() => window.svelteScopedSlotDiagnostic !== undefined);
            assert.deepEqual(native, expected);
            assert.deepEqual(await converted.evaluate(() => window.svelteScopedSlotDiagnostic), native);
          } finally { await live.close(); await converted.close(); await browser.close(); }
        });
      }
    }
  }
});

declare global {
  interface Window { svelteScopedSlotDiagnostic?: Diagnostic; }
}
