import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { createRequire } from "node:module";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { generateComponent, loadNodeComponents } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { expectedHead, expectedScripts, headFiles, runHeadScenario, runScriptScenario, scriptFiles, scriptSources, authoredHead } from "../../html-next/tests/head-scenario.js";

/**
 * Head declarations (https://nextwebwg.org/declarative-components/components#head-generated) in
 * compiled Vanilla output and converted Vue, React and Svelte components: the scenario the live runtime
 * runs in head-conformance.test.ts, with the vendor components imported from an installed package.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const htmlNextModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
const { JSDOM } = createRequire(join(htmlNextModules, "jsdom", "package.json"))("jsdom") as {
  JSDOM: new (html: string, options: { url: string }) => { readonly window: { readonly document: Document; close(): void } };
};
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "vanilla" | "vue" | "react" | "svelte";
const tags = ["docs-layout", "page-a", "page-b", "img-card", "x-note", "x-product", "vendor-widget", "cdn-badge", "saved-cards", "pay-badge", "checkout-form", "map-view"] as const;
const pascal = (tag: string): string => tag.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");

/** Removing and restoring a root happens outside the framework, which keeps the instance. */
const detach = `const removed = new Map();
const detach = {
  remove(id) { const root = document.getElementById(id); removed.set(id, root); root.remove(); },
  restore(id) { document.querySelector("#mount").prepend(removed.get(id)); },
};
`;

/** What each page does with the components: the scenario's `app` and `scripts`, through the framework's own state. */
const vanillaEntry = `${tags.map((tag) => `import { create${pascal(tag)} } from "./${pascal(tag)}.js";`).join("\n")}
import { componentRegistry } from "@nextwebwg/html-next/generated-runtime";
${detach}const mount = () => document.querySelector("#mount");
let pageA, product, note, cards = [];
globalThis.app = {
  mount() {
    pageA = createPageA({});
    cards = [createImgCard(), createImgCard()];
    product = createXProduct();
    mount().append(createDocsLayout({ children: [pageA] }), ...cards, product, createXProduct(), createVendorWidget(), createCdnBadge());
  },
  section(text) { componentRegistry.update(pageA, { section: text }); },
  note(shown) { if (shown) pageA.append(note = createXNote()); else note.remove(); },
  cards(count) { for (const card of cards.splice(count)) card.remove(); },
  schema(value) { componentRegistry.update(product, { schema: value }); },
  page() { pageA.replaceWith(createPageB()); },
  unmount() { mount().replaceChildren(); },
};
const spacer = () => Object.assign(document.createElement("div"), { style: "height: 6000px" });
globalThis.scripts = {
  mount() {
    mount().append(createSavedCards({ attributes: { id: "a" } }), createSavedCards({ attributes: { id: "b" } }), createPayBadge(), spacer(),
      createCheckoutForm({ attributes: { id: "lazy" } }), createMapView({ attributes: { id: "maps" } }));
  },
  ...detach,
  unmount() { mount().replaceChildren(); },
};
`;
const vueEntry = (artifact: (tag: string) => string): string => `import { createApp, h, nextTick, reactive } from "vue";
${tags.map((tag) => `import ${pascal(tag)} from "./${artifact(tag)}";`).join("\n")}
const s = reactive({ view: "", page: "a", section: "Install", note: false, cards: 2, schema: null as unknown });
createApp({ render: () => s.view === "head" ? [
  h(DocsLayout as any, null, { default: () => s.page === "a" ? h(PageA as any, { section: s.section }, { default: () => s.note ? h(XNote as any) : null }) : h(PageB as any) }),
  ...Array.from({ length: s.cards }, (_, index) => h(ImgCard as any, { key: index })), h(XProduct as any, { schema: s.schema }), h(XProduct as any), h(VendorWidget as any), h(CdnBadge as any),
] : s.view === "scripts" ? [h(SavedCards as any, { id: "a" }), h(SavedCards as any, { id: "b" }), h(PayBadge as any), h("div", { style: "height: 6000px" }),
  h(CheckoutForm as any, { id: "lazy" }), h(MapView as any, { id: "maps" })] : null }).mount("#mount");
const set = (next: Partial<typeof s>) => { Object.assign(s, next); return nextTick(); };
${detach.replace("const detach", "const detach: any").replace("const removed = new Map();", "const removed = new Map<string, any>();")}
(globalThis as any).app = { mount: () => set({ view: "head" }), section: (text: string) => set({ section: text }), note: (shown: boolean) => set({ note: shown }),
  cards: (count: number) => set({ cards: count }), schema: (value: unknown) => set({ schema: value }), page: () => set({ page: "b" }), unmount: () => set({ view: "" }) };
(globalThis as any).scripts = { mount: () => set({ view: "scripts" }), ...detach, unmount: () => set({ view: "" }) };
`;

const reactEntry = (artifact: (tag: string) => string): string => `import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
${tags.map((tag) => `import ${pascal(tag)} from "./${artifact(tag)}";`).join("\n")}
const C = { ${tags.map((tag) => pascal(tag)).join(", ")} } as Record<string, any>;
let s = { view: "", page: "a", section: "Install", note: false, cards: 2, schema: null as unknown };
const root = createRoot(document.querySelector("#mount")!);
function App(props: typeof s) {
  if (props.view === "head") return <>
    <C.DocsLayout>{props.page === "a" ? <C.PageA section={props.section}>{props.note ? <C.XNote /> : null}</C.PageA> : <C.PageB />}</C.DocsLayout>
    {Array.from({ length: props.cards }, (_, index) => <C.ImgCard key={index} />)}<C.XProduct schema={props.schema} /><C.XProduct /><C.VendorWidget /><C.CdnBadge />
  </>;
  if (props.view === "scripts") return <><C.SavedCards id="a" /><C.SavedCards id="b" /><C.PayBadge /><div style={{ height: "6000px" }} /><C.CheckoutForm id="lazy" /><C.MapView id="maps" /></>;
  return null;
}
const set = (next: Partial<typeof s>) => { s = { ...s, ...next }; flushSync(() => root.render(<App {...s} />)); };
set({});
${detach.replace("const detach", "const detach: any").replace("const removed = new Map();", "const removed = new Map<string, any>();")}
(globalThis as any).app = { mount: () => set({ view: "head" }), section: (text: string) => set({ section: text }), note: (shown: boolean) => set({ note: shown }),
  cards: (count: number) => set({ cards: count }), schema: (value: unknown) => set({ schema: value }), page: () => set({ page: "b" }), unmount: () => set({ view: "" }) };
(globalThis as any).scripts = { mount: () => set({ view: "scripts" }), ...detach, unmount: () => set({ view: "" }) };
`;

const svelteApp = (artifact: (tag: string) => string): string => `<script>
${tags.map((tag) => `  import ${pascal(tag)} from "./${artifact(tag)}";`).join("\n")}
  import { s } from "./state.svelte.js";
</script>
{#if s.view === "head"}
  <DocsLayout>{#if s.page === "a"}<PageA section={s.section}>{#if s.note}<XNote />{/if}</PageA>{:else}<PageB />{/if}</DocsLayout>
  {#each Array.from({ length: s.cards }) as _, index (index)}<ImgCard />{/each}<XProduct schema={s.schema} /><XProduct /><VendorWidget /><CdnBadge />
{:else if s.view === "scripts"}
  <SavedCards id="a" /><SavedCards id="b" /><PayBadge /><div style="height: 6000px"></div><CheckoutForm id="lazy" /><MapView id="maps" />
{/if}
`;
const svelteEntry = `import { flushSync, mount } from "svelte";
import App from "./App.svelte";
import { s } from "./state.svelte.js";
mount(App, { target: document.querySelector("#mount")! });
const set = (next: Partial<typeof s>) => { Object.assign(s, next); flushSync(); };
${detach.replace("const detach", "const detach: any").replace("const removed = new Map();", "const removed = new Map<string, any>();")}
(globalThis as any).app = { mount: () => set({ view: "head" }), section: (text: string) => set({ section: text }), note: (shown: boolean) => set({ note: shown }),
  cards: (count: number) => set({ cards: count }), schema: (value: unknown) => set({ schema: value }), page: () => set({ page: "b" }), unmount: () => set({ view: "" }) };
(globalThis as any).scripts = { mount: () => set({ view: "scripts" }), ...detach, unmount: () => set({ view: "" }) };
`;

/**
 * Server rendering then hydration: a layout, its page and an eager script. Each framework renders on
 * the server into the head helper's collector, which writes the head into the application's own; the
 * client hydrates the same tree.
 */
type Framework = Exclude<Target, "vanilla">;
const ssrSources = {
  vue: (artifact: (tag: string) => string, ssr: boolean) => `import { createSSRApp, h, nextTick, reactive } from "vue";
${["docs-layout", "page-a", "page-b", "x-note", "x-product", "saved-cards"].map((tag) => `import ${pascal(tag)} from "./${artifact(tag).replace(/\.vue$/, ssr ? ".ssr" : ".vue")}";`).join("\n")}
const s = reactive({ page: "a", note: false, schema: { name: "Install" } as unknown, shown: true });
const app = createSSRApp({ render: () => s.shown ? [h(DocsLayout as any, null, { default: () => s.page === "a" ? h(PageA as any, null, { default: () => s.note ? h(XNote as any) : null }) : h(PageB as any) }),
  h(XProduct as any, { schema: s.schema }), h(XProduct as any, { schema: { name: "Install" } }), h(SavedCards as any, { id: "a" })] : null });
${ssr ? `import { renderToString } from "@vue/server-renderer";
import { createHeadCollector, writeCollectedHead, HEAD_CONTEXT } from "./vue/head";
export async function render() { const collector = createHeadCollector(); const html = await renderToString(app, { [HEAD_CONTEXT]: collector }); return { html, write: (document: Document) => writeCollectedHead(document, collector) }; }`
  : `app.mount("#mount");
const set = (next: Partial<typeof s>) => { Object.assign(s, next); return nextTick(); };
(globalThis as any).ssr = { set, unmount: () => set({ shown: false }) };`}
`,
  react: (artifact: (tag: string) => string, ssr: boolean) => `import React from "react";
${["docs-layout", "page-a", "page-b", "x-note", "x-product", "saved-cards"].map((tag) => `import ${pascal(tag)} from "./${artifact(tag)}";`).join("\n")}
let s = { page: "a", note: false, schema: { name: "Install" } as unknown, shown: true };
const App = (props: typeof s) => props.shown ? <><DocsLayout>{props.page === "a" ? <PageA>{props.note ? <XNote /> : null}</PageA> : <PageB />}</DocsLayout>
  <XProduct schema={props.schema} /><XProduct schema={{ name: "Install" }} /><SavedCards id="a" /></> : null;
${ssr ? `import { renderToString } from "react-dom/server";
import { collectHead, createHeadCollector, writeCollectedHead } from "./react/head";
export async function render() { const collector = createHeadCollector(); const html = collectHead(collector, () => renderToString(<App {...s} />)); return { html, write: (document: Document) => writeCollectedHead(document, collector) }; }`
  : `import { hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
const root = hydrateRoot(document.querySelector("#mount")!, <App {...s} />);
const set = (next: Partial<typeof s>) => { s = { ...s, ...next }; flushSync(() => root.render(<App {...s} />)); };
(globalThis as any).ssr = { set, unmount: () => set({ shown: false }) };`}
`,
  svelte: (_artifact: (tag: string) => string, ssr: boolean) => ssr ? `import { render as renderSvelte } from "svelte/server";
import App from "./Ssr.svelte";
import { createHeadCollector, writeCollectedHead, HEAD_CONTEXT } from "./svelte/head.svelte";
export async function render() { const collector = createHeadCollector(); const html = renderSvelte(App, { context: new Map([[HEAD_CONTEXT, collector]]) }).body; return { html, write: (document: Document) => writeCollectedHead(document, collector) }; }
` : `import { hydrate, flushSync } from "svelte";
import App from "./Ssr.svelte";
import { ssrState } from "./ssr-state.svelte.js";
hydrate(App, { target: document.querySelector("#mount")! });
const set = (next: Partial<typeof ssrState>) => { Object.assign(ssrState, next); flushSync(); };
(globalThis as any).ssr = { set, unmount: () => set({ shown: false }) };
`,
} as const satisfies Record<Framework, (artifact: (tag: string) => string, ssr: boolean) => string>;

describe.skipIf(!enabled)("head declarations in compiled output and converted frameworks", () => {
  let directory = "";
  const bundles = new Map<Target, string>();
  /** Each framework's server-rendered page and its hydrating bundle. */
  const rendered = new Map<Framework, { page: string; bundle: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-head-targets-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    // The vendor components come from an installed package, through a bare specifier: imported components.
    const vendor = join(app, "node_modules", "@vendor", "ui");
    await mkdir(vendor, { recursive: true });
    await writeFile(join(vendor, "package.json"), JSON.stringify({ name: "@vendor/ui", exports: { "./*.html": "./*.html" } }));
    await writeFile(join(vendor, "widget.html"), headFiles["widget.html"]!);
    await writeFile(join(vendor, "badge.html"), headFiles["badge.html"]!);
    await writeFile(join(app, "app.html"), headFiles["app.html"]!);
    await writeFile(join(app, "scripts.html"), scriptFiles["scripts.html"]!);
    await writeFile(join(app, "maps.js"), scriptFiles["maps.js"]!);
    await writeFile(join(app, "vendor.html"), '<link rel="component" href="@vendor/ui/widget.html"><link rel="component" href="@vendor/ui/badge.html"><template component="x-vendors"><i></i></template>');
    const entries = ["app.html", "scripts.html", "vendor.html"];

    // Compiled Vanilla modules beside their sources, so the map view's controller specifier resolves.
    const graph = await loadNodeComponents(entries.map((entry) => pathToFileURL(join(app, entry)).href));
    for (const node of graph.nodes.values()) {
      const module = generateComponent(node.definition).find((artifact) => artifact.path === `vanilla/${node.definition.contract.name}.js`)!;
      await writeFile(join(app, `${node.definition.contract.name}.js`), module.content);
    }
    await writeFile(join(app, "vanilla-entry.js"), vanillaEntry);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(app, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(app, target);
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries });
      const artifact = (tag: string): string => manifest.components.find((component) => component.tag === tag)!.artifact;
      const bundle = join(directory, `${target}.js`);
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(join(out, "entry.ts"), vueEntry(artifact));
        await build({ entryPoints: [join(out, "entry.ts")], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          nodePaths: [nodeModules], plugins: [vuePlugin] });
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), reactEntry(artifact));
        await build({ entryPoints: [join(out, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      } else {
        await writeFile(join(out, "state.svelte.ts"), 'export const s = $state({ view: "", page: "a", section: "Install", note: false, cards: 2, schema: null as unknown });\n');
        await writeFile(join(out, "App.svelte"), svelteApp(artifact));
        await writeFile(join(out, "entry.ts"), svelteEntry);
        await build({ entryPoints: [join(out, "entry.ts")], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      }
      bundles.set(target, bundle);

      if (target === "vue") {
        // Vue renders on the server through each component's SSR render function.
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          const serverScript = compileScript(parsed.descriptor, { id: component.tag });
          const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: component.tag, ssr: true, ssrCssVars: [],
            compilerOptions: { bindingMetadata: serverScript.bindings ?? {} } });
          await writeFile(path.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });\n`);
        }
      }
      if (target === "svelte") {
        await writeFile(join(out, "ssr-state.svelte.ts"), 'export const ssrState = $state({ page: "a", note: false, schema: { name: "Install" } as unknown, shown: true });\n');
        await writeFile(join(out, "Ssr.svelte"), `<script>${["docs-layout", "page-a", "page-b", "x-note", "x-product", "saved-cards"].map((tag) => `import ${pascal(tag)} from "./${artifact(tag)}";`).join(" ")}
import { ssrState as s } from "./ssr-state.svelte.js";</script>
{#if s.shown}<DocsLayout>{#if s.page === "a"}<PageA>{#if s.note}<XNote />{/if}</PageA>{:else}<PageB />{/if}</DocsLayout><XProduct schema={s.schema} /><XProduct schema={{ name: "Install" }} /><SavedCards id="a" />{/if}`);
      }
      const extension = target === "react" ? "tsx" : "ts";
      await writeFile(join(out, `ssr-server.${extension}`), ssrSources[target](artifact, true));
      await writeFile(join(out, `ssr-client.${extension}`), `${ssrSources[target](artifact, false)}\n${detach.replace("const detach", "const detach: any").replace("const removed = new Map();", "const removed = new Map<string, any>();")}(globalThis as any).scripts = detach;\n`);
      const server = join(directory, `${target}-server.mjs`);
      const ssrPlugins = target === "vue" ? [{ name: "vue-ssr", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
        pluginBuild.onResolve({ filter: /\.ssr$/ }, (args) => ({ path: resolve(args.resolveDir, `${args.path}.ts`) }));
        pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
      } }] : target === "svelte" ? [sveltePlugin("server")] : [];
      await build({ entryPoints: [join(out, `ssr-server.${extension}`)], outfile: server, bundle: true, format: "esm", platform: "node", target: ["node22"],
        jsx: "automatic", nodePaths: [nodeModules, htmlNextModules], loader: { ".css": "empty" }, plugins: ssrPlugins });
      const client = join(directory, `${target}-client.js`);
      await build({ entryPoints: [join(out, `ssr-client.${extension}`)], outfile: client, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" }, plugins: target === "vue" ? [vuePlugin] : target === "svelte" ? [sveltePlugin("client")] : [] });
      const { html, write } = await (await import(pathToFileURL(server).href) as { render(): Promise<{ html: string; write(document: Document): void }> }).render();
      const dom = new JSDOM('<!doctype html><head><meta charset="utf-8"><title>Acme</title></head><body></body>', { url: "https://app.example/" });
      write(dom.window.document);
      rendered.set(target, { page: `<!doctype html><head>${dom.window.document.head.innerHTML}</head><body><div id="mount">${html}</div></body>`, bundle: client });
      dom.window.close();
    }
  }, 300_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  const open = async (browserType: BrowserType, target: Target, errors: string[]): Promise<{ page: Page; requested: string[]; close: () => Promise<void> }> => {
    const browser = await browserType.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to preconnect")) errors.push(message.text()); });
    const requested: string[] = [];
    await page.route(/^https:\/\/(?:app|js)\.example\//, async (route) => {
      const url = new URL(route.request().url());
      const name = url.pathname.split("/").at(-1)!;
      const headers = { "access-control-allow-origin": "*" };
      if (url.hostname === "js.example") {
        requested.push(name);
        if (name === "sdk.js") await new Promise((done) => setTimeout(done, 400));
        return route.fulfill({ contentType: "text/javascript", body: scriptSources[name]!, headers });
      }
      return route.fulfill({ contentType: "text/html", headers, body: `<!doctype html><head>${authoredHead(false)}</head><body><div id="mount"></div></body>` });
    });
    await page.goto("https://app.example/");
    await page.addScriptTag({ path: bundles.get(target)! });
    return { page, requested, close: () => browser.close() };
  };

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["vue", "react", "svelte"] as const) {
      it(`${engine} ${target} hydrates server output: adopts its head, runs the eager script once, and restores the set-aside title`, async () => {
        const { page: html, bundle } = rendered.get(target)!;
        // The server wrote the reconciled head, the authored title in its set-aside template, and a preload, never a script.
        assert.match(html, /<title data-component-head="">Install · Docs<\/title><template data-component-head="set-aside"><title>Acme<\/title><\/template>/);
        assert.match(html, /<link rel="preload" as="script" href="https:\/\/js\.example\/sdk\.js" crossorigin="anonymous" data-component-head="">/);
        // Two instances with identical JSON-LD write two blocks each; JSON-LD blocks only, never an executing script.
        assert.equal(html.match(/<script type="application\/ld\+json" data-component-head="">\{"name":"Install"\}<\/script>/g)?.length, 2);
        assert.doesNotMatch(html.replaceAll(/<script type="application\/ld\+json"[^>]*>[^<]*<\/script>/g, ""), /<script/);
        const browser = await browserType.launch({ headless: true });
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to preconnect")) errors.push(message.text()); });
          const requested: string[] = [];
          await page.route(/^https:\/\/(?:app|js)\.example\//, async (route) => {
            const url = new URL(route.request().url());
            const headers = { "access-control-allow-origin": "*" };
            if (url.hostname === "js.example") {
              requested.push(url.pathname);
              return route.fulfill({ contentType: "text/javascript", body: scriptSources["sdk.js"]!, headers });
            }
            return route.fulfill({ contentType: "text/html", headers, body: html });
          });
          await page.goto("https://app.example/");
          await page.evaluate(() => {
            const kept = globalThis as unknown as Record<string, unknown>;
            kept.serverTitle = document.querySelector("title");
            kept.serverDescription = document.querySelector('meta[name="description"]');
            kept.serverJson = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            kept.authoredTitle = document.querySelector<HTMLTemplateElement>("template[data-component-head]")?.content.firstElementChild;
          });
          await page.addScriptTag({ path: bundle });
          await page.waitForFunction(() => document.getElementById("a")?.getAttribute("data-loads") === "1");
          const read = () => page.evaluate(() => {
            const kept = globalThis as unknown as Record<string, unknown>;
            return { sameTitle: kept.serverTitle === document.querySelector("title"), sameDescription: kept.serverDescription === document.querySelector('meta[name="description"]'),
              title: document.title, templates: document.querySelectorAll("template[data-component-head]").length,
              preloads: document.querySelectorAll('link[rel="preload"][data-component-head]').length, scripts: document.querySelectorAll('script[src="https://js.example/sdk.js"]').length,
              runs: (globalThis as unknown as { runs?: Record<string, number> }).runs?.sdk ?? 0, loads: document.getElementById("a")?.getAttribute("data-loads") ?? null };
          });
          assert.deepEqual(await read(), { sameTitle: true, sameDescription: true, title: "Install · Docs", templates: 0, preloads: 1, scripts: 1, runs: 1, loads: "1" });
          // A new connection runs on:load again without inserting or running the script again.
          await page.evaluate(async () => {
            scripts.remove("a");
            await new Promise((done) => setTimeout(done, 20));
            scripts.restore("a");
            await new Promise((done) => setTimeout(done, 20));
          });
          assert.deepEqual(await read(), { sameTitle: true, sameDescription: true, title: "Install · Docs", templates: 0, preloads: 1, scripts: 1, runs: 1, loads: "2" });
          // After hydration: a deeper component takes the title and gives it back, a bound JSON-LD value
          // changes its own block in place, and a page change is one reconciliation.
          const after = await page.evaluate(async () => {
            const { set } = (globalThis as unknown as { ssr: { set(next: object): Promise<void> | void } }).ssr;
            const settle = () => new Promise((done) => setTimeout(done, 20));
            const serverJson = (globalThis as unknown as { serverJson: Element[] }).serverJson;
            const sameJson = () => Array.from(document.querySelectorAll('script[type="application/ld+json"]')).every((block, index) => block === serverJson[index]);
            const adoptedJson = sameJson();
            await set({ note: true }); await settle();
            const deeper = document.title;
            await set({ note: false }); await settle();
            const back = document.title;
            await set({ schema: { name: "Upgrade" } }); await settle();
            const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'), (block) => block.textContent);
            const seen: string[] = [];
            const removed: Node[] = [];
            const preconnect = document.querySelector('link[href="https://search.acme.example"]');
            const observer = new MutationObserver((records) => { seen.push(document.title); for (const record of records) removed.push(...record.removedNodes); });
            observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
            await set({ page: "b" }); await settle();
            observer.disconnect();
            return { adoptedJson, deeper, back, blocks, sameJson: blocks.length === serverJson.length && sameJson(), seen: [...new Set(seen)], kept: preconnect === document.querySelector('link[href="https://search.acme.example"]') && !removed.includes(preconnect!) };
          });
          assert.deepEqual(after, { adoptedJson: true, deeper: "Note", back: "Install · Docs", blocks: ['{"@type": "Organization", "name": "{Acme}"}', '{"name":"Upgrade"}', '{"@type": "Organization", "name": "{Acme}"}', '{"name":"Install"}'],
            sameJson: true, seen: ["Configure · Docs"], kept: true });
          // With no component setting a title, the authored node returns: the same object.
          const restored = await page.evaluate(async () => {
            (globalThis as unknown as { ssr: { unmount(): void } }).ssr.unmount();
            await new Promise((done) => setTimeout(done, 20));
            const kept = globalThis as unknown as Record<string, unknown>;
            return { same: kept.authoredTitle === document.querySelector("title"), title: document.title, managed: document.querySelectorAll("[data-component-head]:not(link, script)").length };
          });
          assert.deepEqual(restored, { same: true, title: "Acme", managed: 0 });
          assert.deepEqual(requested, ["/sdk.js"]);
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    }
    for (const target of ["vanilla", "vue", "react", "svelte"] as const) {
      it(`${engine} ${target} reconciles the head as the live runtime does`, async () => {
        const errors: string[] = [];
        const { page, close } = await open(browserType, target, errors);
        try {
          assert.deepEqual(await runHeadScenario(page), expectedHead(false));
          assert.deepEqual(errors, []);
        } finally { await close(); }
      });

      it(`${engine} ${target} shares declared scripts and runs on:load once per connection`, async () => {
        const errors: string[] = [];
        const { page, requested, close } = await open(browserType, target, errors);
        try {
          const steps = await runScriptScenario(page).catch(async (error: unknown) => {
            throw new Error(JSON.stringify({ errors, head: await page.evaluate(() => document.head.innerHTML), body: await page.evaluate(() => document.body.innerHTML.slice(0, 2000)) }), { cause: error });
          });
          assert.deepEqual(steps, expectedScripts);
          assert.deepEqual(requested, ["sdk.js", "lazy.js", "maps.js"]);
          assert.deepEqual(errors, []);
        } finally { await close(); }
      });
    }
  }
});
