import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { HtmlDiagnosticError } from "@nextwebwg/html-next";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;

interface DispatchStep {
  readonly button?: number;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly child?: boolean;
  readonly count: number;
  readonly bubbled?: boolean;
  readonly prevented?: boolean;
}

interface ModifierCase {
  readonly id: string;
  readonly event: "click" | "keydown";
  readonly modifiers: string;
  readonly steps: readonly DispatchStep[];
}

const click = (button: number, count: number, extras: Partial<DispatchStep> = {}): DispatchStep => ({ button, count, ...extras });
const key = (value: string, count: number, extras: Partial<DispatchStep> = {}): DispatchStep => ({ key: value, count, ...extras });

const cases: readonly ModifierCase[] = [
  { id: "stop", event: "click", modifiers: "stop", steps: [click(0, 1, { bubbled: false })] },
  { id: "prevent", event: "click", modifiers: "prevent", steps: [click(0, 1, { prevented: true })] },
  { id: "self_stop", event: "click", modifiers: "stop.self", steps: [click(0, 0, { child: true }), click(0, 1, { bubbled: false })] },
  { id: "once", event: "click", modifiers: "once", steps: [click(0, 1), click(0, 1)] },
  { id: "passive", event: "click", modifiers: "passive", steps: [click(0, 1)] },
  { id: "capture", event: "click", modifiers: "capture", steps: [click(0, 1, { child: true })] },
  { id: "capture_order", event: "click", modifiers: "capture", steps: [click(0, 11)] },
  { id: "left_mouse", event: "click", modifiers: "left", steps: [click(2, 0), click(0, 1)] },
  { id: "middle_mouse", event: "click", modifiers: "middle", steps: [click(0, 0), click(1, 1)] },
  { id: "right_mouse", event: "click", modifiers: "right", steps: [click(0, 0), click(2, 1)] },
  { id: "ctrl", event: "keydown", modifiers: "ctrl", steps: [key("x", 0), key("x", 1, { ctrlKey: true })] },
  { id: "shift", event: "keydown", modifiers: "shift", steps: [key("x", 0), key("x", 1, { shiftKey: true })] },
  { id: "alt", event: "keydown", modifiers: "alt", steps: [key("x", 0), key("x", 1, { altKey: true })] },
  { id: "meta", event: "keydown", modifiers: "meta", steps: [key("x", 0), key("x", 1, { metaKey: true })] },
  { id: "exact", event: "keydown", modifiers: "ctrl.exact", steps: [key("x", 1, { ctrlKey: true }), key("x", 1, { ctrlKey: true, shiftKey: true })] },
  { id: "enter", event: "keydown", modifiers: "enter", steps: [key("Escape", 0), key("Enter", 1)] },
  { id: "escape", event: "keydown", modifiers: "escape", steps: [key("Enter", 0), key("Escape", 1)] },
  { id: "space", event: "keydown", modifiers: "space", steps: [key("Enter", 0), key(" ", 1)] },
  { id: "tab", event: "keydown", modifiers: "tab", steps: [key("Enter", 0), key("Tab", 1)] },
  { id: "up", event: "keydown", modifiers: "up", steps: [key("ArrowDown", 0), key("ArrowUp", 1)] },
  { id: "down", event: "keydown", modifiers: "down", steps: [key("ArrowUp", 0), key("ArrowDown", 1)] },
  { id: "left_key", event: "keydown", modifiers: "left", steps: [key("ArrowRight", 0), key("ArrowLeft", 1)] },
  { id: "right_key", event: "keydown", modifiers: "right", steps: [key("ArrowLeft", 0), key("ArrowRight", 1)] },
  { id: "once_enter", event: "keydown", modifiers: "enter.once", steps: [key("Escape", 0), key("Enter", 0)] },
  { id: "ctrl_enter_exact", event: "keydown", modifiers: "ctrl.enter.exact", steps: [key("Enter", 0), key("Escape", 0, { ctrlKey: true }), key("Enter", 0, { ctrlKey: true, shiftKey: true }), key("Enter", 1, { ctrlKey: true })] },
];

const source = `<template component="x-event-matrix" status="early" summary="Event modifier parity."><defs>
${cases.map(({ id }) => id === "capture_order"
  ? `<state name="count_${id}" :value="0"></state><handler name="capture_${id}"><set name="count_${id}" :value="count_${id} + 1"></set></handler><handler name="bubble_${id}"><set name="count_${id}" :value="count_${id} * 10 + 1"></set></handler>`
  : `<state name="count_${id}" :value="0"></state><handler name="hit_${id}"><set name="count_${id}" :value="count_${id} + 1"></set></handler>`).join("\n")}
</defs><section>
${cases.map(({ id, event, modifiers }) => id === "capture_order"
  ? `<div data-case="${id}" on:click.capture="capture_${id}"><button type="button" on:click="bubble_${id}">${id}</button><output $value="count_${id}"></output></div>`
  : `<div data-case="${id}"><button type="button" on:${event}.${modifiers}="hit_${id}">${id}<span>child</span></button><output $value="count_${id}"></output></div>`).join("\n")}
</section></template>`;

type DispatchResult = { readonly bubbled: boolean; readonly prevented: boolean; readonly returned: boolean };

async function runMatrix(page: Page): Promise<readonly (readonly DispatchResult[])[]> {
  return page.evaluate((scenarios) => {
    const bubbles = { count: 0 };
    document.addEventListener("click", () => { bubbles.count += 1; });
    document.addEventListener("keydown", () => { bubbles.count += 1; });
    return scenarios.map(({ id, event, steps }) => {
      const control = document.querySelector<HTMLButtonElement>(`#case [data-case="${id}"] button`)!;
      return steps.map((step) => {
        const target = step.child ? control.querySelector("span")! : control;
        const before = bubbles.count;
        const dispatched = event === "click"
          ? new MouseEvent("click", { bubbles: true, cancelable: true, button: step.button ?? 0 })
          : new KeyboardEvent("keydown", {
            bubbles: true, cancelable: true, key: step.key ?? "",
            ctrlKey: step.ctrlKey ?? false, shiftKey: step.shiftKey ?? false,
            altKey: step.altKey ?? false, metaKey: step.metaKey ?? false,
          });
        const returned = target.dispatchEvent(dispatched);
        return { bubbled: bubbles.count > before, prevented: dispatched.defaultPrevented, returned };
      });
    });
  }, cases);
}

async function snapshot(page: Page): Promise<{ readonly counts: readonly string[]; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    counts: await page.locator("#case output").allTextContents(),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter event modifier matrix", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly fresh: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-event-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "matrix.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/matrix.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-event-matrix"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `events-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `events-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `events-${mode}`,
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
import { XEventMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
createApp({ render: () => h(XEventMatrix, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XEventMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
createSSRApp({ render: () => h(XEventMatrix, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XEventMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => h(XEventMatrix, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      assert.match(server, /<section[^>]*id="case"/);
      converted.set(mode, { fresh: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("rejects invalid modifier combinations with source-located diagnostics", async () => {
    for (const [name, binding] of [
      ["passive-prevent", "on:click.passive.prevent"],
      ["repeated-stop", "on:click.stop.stop"],
      ["unknown-modifier", "on:click.unknown"],
      ["deferred-lifecycle", "on:connect"],
    ] as const) {
      const entry = `components/${name}.html`;
      await writeFile(join(directory, entry), `<template component="x-${name}" status="early" summary="Invalid event modifier."><defs><handler name="hit"></handler></defs><button ${binding}="hit">Go</button></template>`);
      await assert.rejects(
        () => convertComponents({ mode: "application", target: "vue", entries: [entry], root: directory, outDirectory: join(directory, `invalid-${name}`) }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT010" &&
          error.diagnostic.source?.endsWith(entry) === true,
      );
    }
  });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} matches every supported modifier after mount and hydration`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, vue, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${source}<main><x-event-matrix id="case"></x-event-matrix></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          const output = converted.get(mode)!;
          await vue.addScriptTag({ path: output.fresh });
          await hydrated.setContent(`<main>${output.server}</main>`);
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.counts, serverLive.counts, "server-rendered event counts differ");
          assert.deepEqual(serverHydrated.pixels, serverLive.pixels, "server-rendered event pixels differ");
          await hydrated.addScriptTag({ path: output.hydrate });
          const [initialLive, initialVue, initialHydrated] = await Promise.all([snapshot(live), snapshot(vue), snapshot(hydrated)]);
          assert.deepEqual(initialVue.counts, initialLive.counts);
          assert.deepEqual(initialVue.pixels, initialLive.pixels);
          assert.deepEqual(initialHydrated.counts, initialLive.counts, "hydrated event counts differ");
          assert.deepEqual(initialHydrated.pixels, initialLive.pixels, "hydrated event pixels differ");
          const [liveResults, vueResults, hydratedResults] = await Promise.all([runMatrix(live), runMatrix(vue), runMatrix(hydrated)]);
          assert.deepEqual(vueResults, liveResults, "event dispatch behavior differs");
          assert.deepEqual(hydratedResults, liveResults, "hydrated event dispatch behavior differs");
          for (const [index, scenario] of cases.entries()) {
            for (const [stepIndex, step] of scenario.steps.entries()) {
              const result = liveResults[index]![stepIndex]!;
              assert.equal(result.bubbled, step.bubbled ?? true, `${scenario.id} step ${stepIndex} propagation`);
              assert.equal(result.prevented, step.prevented ?? false, `${scenario.id} step ${stepIndex} cancellation`);
              assert.equal(result.returned, !(step.prevented ?? false), `${scenario.id} step ${stepIndex} dispatch return`);
            }
          }
          const [afterLive, afterVue, afterHydrated] = await Promise.all([snapshot(live), snapshot(vue), snapshot(hydrated)]);
          const expected = cases.map(({ steps }) => String(steps.at(-1)!.count));
          assert.deepEqual(afterLive.counts, expected, "live-runtime modifier baseline changed");
          assert.deepEqual(afterVue.counts, expected, "converted modifier counts differ");
          assert.deepEqual(afterVue.pixels, afterLive.pixels, "converted modifier pixels differ");
          assert.deepEqual(afterHydrated.counts, expected, "hydrated modifier counts differ");
          assert.deepEqual(afterHydrated.pixels, afterLive.pixels, "hydrated modifier pixels differ");
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
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
