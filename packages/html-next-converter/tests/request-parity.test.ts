import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { generateComponent, parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * Requests (https://nextwebwg.org/declarative-components/javascript#requests), the same scenario in
 * the live runtime, compiled Vanilla output and each converted framework: an editor asks, its
 * consumer's controller answers, a page script answers through `respond()` from another bundle, and
 * late responders relay to the requests that went unanswered.
 */
const editor = `<template component="ui-editor" status="early" summary="Asks its consumer." controller="./editor.js"><defs>
  <request name="mention-query" type="object({ query: string })" returns="list(string)">People matching the text after @.</request>
  <request name="image-upload" type="object">
    <prop name="file" type="unknown" required>The file the author dropped.</prop>
    <returns type="object"><prop name="src" type="string" required></prop></returns>
  </request>
  <request name="link-title" type="string" returns="string">A link's title.</request>
  <request name="homepage" returns="url">The author's homepage.</request>
  <request name="extensions" returns="list(string)">Extensions added to the built-in set.</request>
  <request name="theme" returns="string">The color theme.</request>
  <request name="plugins" returns="list(string)">Plugins.</request>
</defs><div class="editor"><span class="inside"></span></div></template>`;
const editorController = `const late = ["extensions", "theme", "plugins"];
export default function controller(host) {
  const id = host.root.id;
  const log = (globalThis.requestLog ??= []);
  const record = (label, promise) => promise.then(
    (answer) => { log.push(id + " " + label + " " + JSON.stringify(answer)); },
    (error) => { log.push(id + " " + label + " " + error.name); });
  // Asked in the synchronous body: a consumer whose controller runs later still answers it.
  record("mention a", host.request("mention-query", { query: "a" }));
  for (const name of late) record(name, host.request(name));
  host.on("responder", (event) => {
    log.push(id + " responder " + event.detail.name);
    if (late.includes(event.detail.name)) record(event.detail.name, host.request(event.detail.name));
  });
  (globalThis.editors ??= {})[id] = { ask: (name, detail, options) => host.request(name, detail, options), record };
}
`;
const notes = `<link rel="component" href="./editor.html">
<template component="x-notes" status="early" summary="Answers its editor." controller="./notes.js"><section><ui-editor id="inner"></ui-editor></section></template>`;
const notesController = `export default function controller(host) {
  host.on("mention-query", (event) => {
    const { query } = event.detail;
    event.signal.addEventListener("abort", () => globalThis.requestLog.push("notes abort " + query));
    // The answer to "ad" is slow, so it arrives after "ada" asked again; it is dropped.
    event.respondWith(new Promise((resolve) => setTimeout(() => resolve(["Ada", "Alan"].filter((name) => name.toLowerCase().startsWith(query))), query === "ad" ? 60 : 10)));
  });
  host.on("link-title", (event) => event.respondWith(42));
  host.on("homepage", (event) => event.respondWith("not a url"));
  globalThis.notes = { late: () => host.on("plugins", (event) => event.respondWith(["late"])) };
}
`;
const files: Readonly<Record<string, string>> = { "editor.html": editor, "editor.js": editorController, "notes.html": notes, "notes.js": notesController };

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "live" | "vanilla" | "vue" | "react" | "svelte";
const frameworks = new Set<Target>(["vue", "react", "svelte"]);

/** The scenario's steps, each returning the log lines it added (sorted where answers race). */
async function run(page: Page, target: Target): Promise<Record<string, readonly string[]>> {
  let first = true;
  const step = async (action: string, settle: string, sorted = false): Promise<readonly string[]> => {
    // The first step reads what the controllers logged while the page loaded.
    const before = first ? 0 : await page.evaluate(() => (globalThis as unknown as { requestLog?: string[] }).requestLog?.length ?? 0);
    first = false;
    await page.evaluate(`(async () => { ${action} })()`);
    await page.waitForFunction(settle);
    const lines = await page.evaluate((from) => (globalThis as unknown as { requestLog: string[] }).requestLog.slice(from), before);
    return sorted ? [...lines].sort() : lines;
  };
  const log = "globalThis.requestLog";
  const results: Record<string, readonly string[]> = {};
  // The editor asked in its controller's body, before its consumer's controller ran.
  results.setup = await step("", `${log}?.length >= 4`, true);
  results.abort = await step(`const editor = editors.inner;
    const first = new AbortController();
    const stale = editor.record("stale ad", editor.ask("mention-query", { query: "ad" }, { signal: first.signal }));
    first.abort();
    await stale;
    await editor.record("fresh ada", editor.ask("mention-query", { query: "ada" }));
    await new Promise((resolve) => setTimeout(resolve, 100));`, "true");
  results.checks = await step(`const editor = editors.inner;
    await editor.record("link-title", editor.ask("link-title", "https://example.test"));
    await editor.record("bad detail", editor.ask("mention-query", { query: 1 }));
    await editor.record("undeclared", editor.ask("missing"));
    await editor.record("homepage", editor.ask("homepage"));`, "true");
  // The nearest responder answers once, while the request is dispatched.
  results.answerOnce = await step(`const editor = editors.inner;
    const capture = (event) => {
      event.respondWith("first");
      try { event.respondWith("second"); } catch (error) { ${log}.push("again " + error.name); }
      setTimeout(() => { try { event.respondWith("late"); } catch (error) { ${log}.push("late " + error.name); } });
    };
    document.addEventListener("link-title", capture, { capture: true });
    await editor.record("captured", editor.ask("link-title", "x"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    document.removeEventListener("link-title", capture, { capture: true });`, "true");
  results.progress = await step(`const editor = editors.inner;
    const file = new Blob(["xyz"]);
    await editor.record("upload unanswered", editor.ask("image-upload", { file }));
    HTMLNextRequests.respond(document, "image-upload", async ({ file }, { progress }) => {
      progress(1, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      progress(2, 2);
      return { src: "blob:" + file.size };
    });
    await editor.record("upload", editor.ask("image-upload", { file }, { progress: (loaded, total) => ${log}.push("progress " + loaded + "/" + total) }));`, "true");
  results.respond = await step(`HTMLNextRequests.respond(document, "extensions", () => ["bold"]);`, `${log}.at(-1) === 'inner extensions ["bold"]'`);
  results.announced = await step(`document.body.addEventListener("theme", (event) => event.respondWith("dark"));
    document.body.dispatchEvent(new CustomEvent("responder", { bubbles: true, detail: { name: "theme" } }));`, `${log}.at(-1) === 'inner theme "dark"'`);
  results.hostOn = await step("notes.late();", `${log}.at(-1) === 'inner plugins ["late"]'`);
  // An announcement that bubbles through the editor's root is not the relay to it.
  results.bubbling = await step(`document.querySelector("#inner .inside").dispatchEvent(new CustomEvent("responder", { bubbles: true, detail: { name: "theme" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));`, "true");
  // Disconnecting the asker aborts its pending request, and the responder's signal with it.
  results.disconnect = await step(`const pending = editors.inner.record("disconnected", editors.inner.ask("mention-query", { query: "ad" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    document.querySelector("#mount").remove();
    await pending;`, "true");
  if (!frameworks.has(target)) return results;
  results.direct = await step("mountDirect();", `${log}.filter((line) => line.startsWith("direct ")).length >= 4`, true);
  const ask = `await editors.direct.record("link", editors.direct.ask("link-title", "u"));`;
  const rendered = "await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));";
  results.prop = await step(`${ask} direct.set({ linkTitle: (url) => "T2 " + url }); ${rendered} ${ask}`, "true");
  results.lateProp = await step(`direct.set({ plugins: () => ["prop plugin"] });`, `${log}.at(-1) === 'direct plugins ["prop plugin"]'`);
  return results;
}

const expected: Record<string, readonly string[]> = {
  setup: ['inner extensions null', 'inner mention a ["Ada","Alan"]', "inner plugins null", "inner theme null"],
  abort: ["notes abort ad", "inner stale ad AbortError", 'inner fresh ada ["Ada"]'],
  checks: ["inner link-title TypeError", "inner bad detail TypeError", "inner undeclared TypeError", "inner homepage TypeError"],
  answerOnce: ["again InvalidStateError", 'inner captured "first"', "late InvalidStateError"],
  progress: ["inner upload unanswered null", "inner responder image-upload", "progress 1/2", "progress 2/2", 'inner upload {"src":"blob:3"}'],
  respond: ["inner responder extensions", 'inner extensions ["bold"]'],
  announced: ["inner responder theme", 'inner theme "dark"'],
  hostOn: ["inner responder plugins", 'inner plugins ["late"]'],
  bubbling: [],
  // Every request's signal follows the asker's connection, so the answered ones abort too.
  disconnect: ["notes abort a", "notes abort ada", "notes abort ad", "inner disconnected AbortError"],
};
const expectedFramework: Record<string, readonly string[]> = {
  ...expected,
  direct: ['direct extensions ["bold"]', 'direct mention a ["event a"]', "direct plugins null", 'direct theme "dark"'],
  prop: ['direct link "T1 u"', 'direct link "T2 u"'],
  lateProp: ["direct responder plugins", 'direct plugins ["prop plugin"]'],
};

/** Each framework mounts the editor directly too, answering through its function prop and event form. */
const directEntries = {
  vue: (editorPath: string) => `import { createApp, h, reactive } from "vue"; import UiEditor from "./${editorPath}";
(globalThis as any).mountDirect = () => {
  const props = reactive<Record<string, unknown>>({ id: "direct", linkTitle: (url: string) => "T1 " + url,
    onMentionQuery: (event: any) => event.respondWith(["event " + event.detail.query]) });
  createApp({ render: () => h(UiEditor as any, props) }).mount(document.querySelector("#direct")!);
  (globalThis as any).direct = { set: (next: Record<string, unknown>) => Object.assign(props, next) };
};\n`,
  react: (editorPath: string) => `import { createRoot } from "react-dom/client"; import UiEditor from "./${editorPath}";
(globalThis as any).mountDirect = () => {
  let props: Record<string, unknown> = { id: "direct", linkTitle: (url: string) => "T1 " + url,
    onMentionQuery: (event: any) => event.respondWith(["event " + event.detail.query]) };
  const root = createRoot(document.querySelector("#direct")!);
  const render = () => root.render(<UiEditor {...(props as any)} />);
  render();
  (globalThis as any).direct = { set: (next: Record<string, unknown>) => { props = { ...props, ...next }; render(); } };
};\n`,
  svelte: (editorPath: string) => `<script>
  import UiEditor from "./${editorPath}";
  let props = $state({ id: "direct", linkTitle: (url) => "T1 " + url,
    "onmention-query": (event) => event.respondWith(["event " + event.detail.query]) });
  globalThis.direct = { set: (next) => Object.assign(props, next) };
</script>
<UiEditor {...props} />\n`,
};

describe.skipIf(!enabled)("requests in the live runtime, compiled output and converted frameworks", () => {
  let directory = "";
  const bundles = new Map<Target, string>();
  let responder = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-requests-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    // A page script's own bundle: respond() shares the document's requests with every other bundle.
    responder = join(directory, "respond.js");
    await build({ stdin: { contents: `export { respond } from ${JSON.stringify(join(htmlNextSource, "requests.ts"))};`, resolveDir: directory, loader: "ts" },
      outfile: responder, bundle: true, format: "iife", globalName: "HTMLNextRequests", platform: "browser", target: ["es2022"] });
    const live = join(directory, "live.js");
    await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);

    // Compiled Vanilla modules beside their sources, so each controller specifier resolves.
    const definitions: ComponentDefinition[] = [];
    for (const name of ["editor.html", "notes.html"]) {
      definitions.push(...parseComponentResource(files[name]!, `file://${join(directory, name)}`).definitions);
    }
    const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
    for (const definition of definitions) {
      const module = generateComponent(definition, { invocations }).find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!;
      await writeFile(join(directory, `${definition.contract.name}.js`), module.content);
    }
    await writeFile(join(directory, "vanilla-entry.js"), `import { createXNotes } from "./XNotes.js";\ndocument.querySelector("#mount").append(createXNotes());\n`);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["notes.html"] });
      const artifact = (tag: string): string => manifest.components.find((component) => component.tag === tag)!.artifact;
      const entry = join(out, "entry.ts");
      const bundle = join(out, "bundle.js");
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(entry, `import { createApp, h } from "vue"; import XNotes from "./${artifact("x-notes")}";
createApp({ render: () => h(XNotes) }).mount(document.querySelector("#mount")!);
${directEntries.vue(artifact("ui-editor"))}`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          nodePaths: [nodeModules], plugins: [vuePlugin] });
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import XNotes from "./${artifact("x-notes")}";
createRoot(document.querySelector("#mount")!).render(<XNotes />);
${directEntries.react(artifact("ui-editor")).replace('import { createRoot } from "react-dom/client"; ', "")}`);
        await build({ entryPoints: [join(out, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      } else {
        await writeFile(join(out, "App.svelte"), `<script>import XNotes from "./${artifact("x-notes")}";</script><XNotes />`);
        await writeFile(join(out, "Direct.svelte"), directEntries.svelte(artifact("ui-editor")));
        await writeFile(entry, `import { mount } from "svelte"; import App from "./App.svelte"; import Direct from "./Direct.svelte";
mount(App, { target: document.querySelector("#mount")! });
(globalThis as any).mountDirect = () => mount(Direct, { target: document.querySelector("#direct")! });\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      }
      bundles.set(target, bundle);
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
      it(`${engine} ${target} asks, answers, aborts, checks, reports progress and relays late responders`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await page.route("https://app.example/**", async (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (Object.hasOwn(files, name)) {
              // The consumer's controller module arrives last, after the editor has already asked.
              if (name === "notes.js") await new Promise((resolve) => setTimeout(resolve, 150));
              return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : "text/html", body: files[name]! });
            }
            return route.fulfill({ contentType: "text/html", body: target === "live"
              ? '<link rel="component" href="/notes.html"><div id="mount"><x-notes></x-notes></div><div id="direct"></div>'
              : '<div id="mount"></div><div id="direct"></div>' });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: responder });
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          }
          const results = await run(page, target).catch(async (error: unknown) => {
            throw new Error(JSON.stringify({ errors, log: await page.evaluate(() => (globalThis as unknown as { requestLog?: string[] }).requestLog),
              html: await page.evaluate(() => document.body.innerHTML) }), { cause: error });
          });
          assert.deepEqual(results, frameworks.has(target) ? expectedFramework : expected);
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
