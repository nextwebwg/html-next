import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium } from "playwright";

import { generateComponent, parseComponentResource } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/** The actual live loader, native emitter and all three application converters share activation semantics. */
const files: Readonly<Record<string, string>> = {
  "probe.html": `<template component="x-probe" module="./probe.js"><defs><state name="count" type="number" value="0"></state></defs><section class="probe"><output>{$count}</output></section></template>`,
  "probe.js": `import { bindModule } from "@nextwebwg/html-next/bindings";
  if (typeof window === "undefined") throw new Error("Browser module imported during SSR");
  function browserConnect(host, { signal }) {
    host.state.count += 1;
    const index = window.activations.length;
    host.on("probe", () => { window.events += 1; });
    host.on("disconnect", () => { window.disconnectEvents += 1; });
    host.effect(() => { window.effects += 1; return () => { window.effectCleanups += 1; }; });
    return new Promise(resolve => {
      window.activations.push({ signal, finish: () => resolve(() => window.cleanups.push(index)), late: () => host.effect(() => { window.lateEffects += 1; }) });
    });
  }
  export const { connect } = bindModule({ create() { window.factories += 1; return { connect: browserConnect }; } });`,
};
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const bindingAlias = { "@nextwebwg/html-next/bindings": join(htmlNextSource, "bindings.ts") };
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

const entries = {
  vanilla: `import { createXProbe } from "./XProbe.js"; document.querySelector("#mount").append(createXProbe());`,
  vue: (probe: string) => `import { createApp, h } from "vue"; import Probe from "./${probe}"; createApp({ render: () => h(Probe) }).mount(document.querySelector("#mount")!);`,
  react: (probe: string) => `import { createRoot } from "react-dom/client"; import Probe from "./${probe}"; createRoot(document.querySelector("#mount")!).render(<Probe />);`,
  svelte: (probe: string) => `import { mount } from "svelte"; import Probe from "./${probe}"; mount(Probe, { target: document.querySelector("#mount")! });`,
};

describe.skipIf(!enabled)("component module activation across delivery targets", () => {
  let directory = "";
  const bundles = new Map<string, string>();
  const serverHtml = new Map<string, string>();
  let liveProbe = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-module-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    liveProbe = (await build({ entryPoints: [join(directory, "probe.js")], bundle: true, format: "esm", platform: "browser", write: false, alias: bindingAlias })).outputFiles[0]!.text;
    const live = join(directory, "live.js");
    await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);

    const [definition] = parseComponentResource(files["probe.html"]!, `file://${join(directory, "probe.html")}`).definitions;
    const module = generateComponent(definition!).find((artifact) => artifact.path === "vanilla/XProbe.js")!;
    await writeFile(join(directory, "XProbe.js"), module.content);
    await writeFile(join(directory, "vanilla-entry.js"), entries.vanilla);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      define: { "import.meta.url": JSON.stringify("https://app.example/probe.html") },
      alias: { ...bindingAlias, "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["probe.html"] });
      const probe = manifest.components[0]!.artifact;
      const entry = join(out, target === "react" ? "entry.tsx" : "entry.ts");
      const bundle = join(out, "bundle.js");
      let vueServerPath: string | undefined;
      if (target === "vue") {
        const path = join(out, probe);
        const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
        assert.deepEqual(parsed.errors, []);
        await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: "x-probe", inlineTemplate: true }).content);
        const script = compileScript(parsed.descriptor, { id: "x-probe" });
        const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: "x-probe", ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings ?? {} } });
        assert.deepEqual(template.errors, []);
        vueServerPath = probe.replace(/\.vue$/, ".ssr.ts");
        await writeFile(join(out, vueServerPath), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });`);
      }
      await writeFile(entry, entries[target](probe));
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        alias: bindingAlias,
        jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" },
        plugins: target === "vue" ? [vuePlugin] : target === "svelte" ? [sveltePlugin("client")] : [] });
      bundles.set(target, bundle);
      const serverEntry = join(out, target === "react" ? "server.tsx" : "server.ts");
      const serverBundle = join(out, "server.mjs");
      const serverSource = target === "vue"
        ? `import { createSSRApp, h } from "vue"; import { renderToString } from "@vue/server-renderer"; import Probe from "./${vueServerPath}"; export const html = await renderToString(createSSRApp({ render: () => h(Probe) }));`
        : target === "react" ? `import { renderToString } from "react-dom/server"; import Probe from "./${probe}"; export const html = renderToString(<Probe />);`
          : `import { render } from "svelte/server"; import Probe from "./${probe}"; export const html = render(Probe).body;`;
      await writeFile(serverEntry, serverSource);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", alias: bindingAlias, loader: { ".css": "empty" }, plugins: target === "svelte" ? [sveltePlugin("server")] : [] });
      serverHtml.set(target, (await import(pathToFileURL(serverBundle).href) as { html: string }).html);
      if (target === "react") {
        await writeFile(entry, 'import { StrictMode } from "react";\n' + entries.react(probe).replace('<Probe />', '<StrictMode><Probe /></StrictMode>'));
        const strict = join(out, "strict.js");
        await build({ entryPoints: [entry], outfile: strict, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], alias: bindingAlias, loader: { ".css": "empty" } });
        bundles.set("react-strict", strict);
      }
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const target of ["vue", "react", "svelte"] as const) {
    it(`${target} renders its declarative first frame without importing browser behavior`, () => {
      assert.match(serverHtml.get(target)!, /0<\/output>/);
    });
  }

  // Chromium: these cases exercise generated lifecycle ownership, not engine-specific DOM APIs.
  for (const target of ["live", "vanilla", "vue", "react", "react-strict", "svelte"] as const) {
    it(`${target} reconnects retained state, cancels work and owns late subscriptions`, async () => {
      const browser = await launchParityBrowser(chromium);
      const errors: string[] = [];
      try {
        const page = await browser.newPage();
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://app.example/**", route => {
          const name = new URL(route.request().url()).pathname.slice(1);
          return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : "text/html", body: name === "probe.js" ? liveProbe : Object.hasOwn(files, name) ? files[name]! : target === "live"
            ? '<link rel="component" href="/probe.html"><div id="mount"><x-probe></x-probe></div><div id="other"></div>'
            : '<div id="mount"></div><div id="other"></div>' });
        });
        await page.goto("https://app.example/");
        await page.evaluate(() => Object.assign(window, { activations: [], cleanups: [], events: 0, effects: 0, effectCleanups: 0, lateEffects: 0, disconnectEvents: 0, factories: 0 }));
        await page.addScriptTag({ path: bundles.get(target)! });
        if (target === "live") await page.evaluate(() => (window as any).HtmlNextLoader.startBrowserComponents());
        await page.waitForFunction(() => (window as any).activations.length >= 1 && document.querySelector("output")?.textContent === String((window as any).activations.length));
        // React development StrictMode may replay an activation. Each replay must end its own work.
        if (target === "react-strict") await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => (window as any).factories), 1);
        const result = await page.evaluate(async () => {
          const task = window as any;
          const settle = () => new Promise(resolve => setTimeout(resolve, 0));
          const root = document.querySelector(".probe")!;
          const offset = task.activations.length - 1;
          const previous = task.activations.slice(0, offset);
          const initial = { active: task.effects - task.effectCleanups, previousCancelled: previous.every((entry: any) => entry.signal.aborted) };
          for (const entry of previous) { entry.finish(); entry.late(); }
          await settle();
          const cleanups = () => task.cleanups.filter((index: number) => index >= offset).map((index: number) => index - offset);
          const first = task.activations[offset];
          root.dispatchEvent(new Event("probe"));
          // A connected move is one activation, regardless of which host rendered it.
          document.querySelector("#other")!.append(root);
          await settle();
          const moved = task.activations.length - offset;
          root.remove();
          await settle();
          const aborted = first.signal.aborted;
          root.dispatchEvent(new Event("probe"));
          first.late();
          const disconnected = { effects: task.effects - offset, cleanups: task.effectCleanups - offset, events: task.events, late: task.lateEffects, disconnects: task.disconnectEvents - offset };
          document.querySelector("#mount")!.append(root);
          await settle(); await settle();
          root.dispatchEvent(new Event("probe"));
          first.finish();
          await settle();
          const reconnected = { count: String(Number(root.querySelector("output")!.textContent) - offset), activations: task.activations.length - offset, aborted: task.activations[offset + 1].signal.aborted, effects: task.effects - offset, events: task.events, cleanups: cleanups() };
          root.remove();
          await settle();
          task.activations[offset + 1].finish();
          await settle();
          return { initial, moved, aborted, disconnected, reconnected, final: { aborted: task.activations[offset + 1].signal.aborted, effects: task.effectCleanups - offset, cleanups: cleanups(), disconnects: task.disconnectEvents - offset } };
        });
        assert.equal(await page.evaluate(() => (window as any).factories), 1, "reconnect retains passive factory state on a component without props");
        assert.deepEqual(result, {
          initial: { active: 1, previousCancelled: true }, moved: 1, aborted: true,
          disconnected: { effects: 1, cleanups: 1, events: 1, late: 0, disconnects: 1 },
          reconnected: { count: "2", activations: 2, aborted: false, effects: 2, events: 2, cleanups: [0] },
          final: { aborted: true, effects: 2, cleanups: [0, 1], disconnects: 2 },
        });
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
