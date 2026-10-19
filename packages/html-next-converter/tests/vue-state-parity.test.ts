import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { afterAll, beforeAll, describe, it } from "vitest";
import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { stateInitializationFiles as files } from "./fixtures/state-initialization.js";
import { exerciseStateInitialization } from "./helpers/state-initialization.js";

describe.skipIf(!enabled)("Vue one-time state through the converter", () => {
  let directory = "";
  let bundle: string;
  let render: (props: object) => Promise<string>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-state-"));
    const nodeModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    const out = join(directory, "output");
    const manifest = await convertComponents({ mode: "application", target: "vue", root: directory, outDirectory: out, entries: ["parent.html"] });
    const parent = manifest.components.find(component => component.tag === "x-seed")!.artifact;
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files: manifest.components.map(component => component.artifact) }));
    try { await promisify(execFile)(fileURLToPath(new URL("../node_modules/.bin/vue-tsc", import.meta.url)), ["-p", join(out, "tsconfig.json")], { cwd: out }); }
    catch (error) { throw new Error((error as { stdout?: string }).stdout || String(error), { cause: error }); }
    for (const component of manifest.components) {
      const path = join(out, component.artifact);
      const parsed = parse(await readFile(path, "utf8"), { filename: path });
      assert.deepEqual(parsed.errors, []);
      await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
      const script = compileScript(parsed.descriptor, { id: component.tag });
      const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: component.tag, ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings ?? {} } });
      assert.deepEqual(template.errors, []);
      await writeFile(path.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });`);
    }
    const plugin = (server: boolean): Plugin => ({ name: "vue-compiled", setup(build) {
      build.onResolve({ filter: /\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, server ? ".ssr.ts" : ".ts")) }));
    } });
    const alias = { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) };
    const entry = join(out, "entry.ts");
    await writeFile(entry, `import { createApp, h } from "vue"; import Parent from "./${parent}"; createApp({render: () => h(Parent)}).mount(document.querySelector("#mount"));`);
    bundle = join(out, "client.js");
    await build({ alias, entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: "es2022", nodePaths: [nodeModules], loader: { ".css": "empty" }, plugins: [plugin(false)] });
    const server = join(out, "server.ts");
    await writeFile(server, `import { createSSRApp, h } from "vue"; import { renderToString } from "@vue/server-renderer"; import Parent from "./${parent}"; export const render = props => renderToString(createSSRApp({ render: () => h(Parent, props) }));`);
    const serverBundle = join(out, "server.mjs");
    await build({ alias, entryPoints: [server], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" }, plugins: [plugin(true)] });
    render = (await import(pathToFileURL(serverBundle).href)).render;
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("renders a waiting server frame and seeds a supplied first frame without connection effects", async () => {
    const waiting = await render({});
    assert.match(waiting, /Waiting\./);
    assert.match(waiting, /Context waiting\./);
    assert.match(waiting, /Child waiting\./);
    const ready = await render({ product: { name: "Server" } });
    assert.match(ready, /<h2>Server<\/h2>/);
    assert.match(ready, /class="context"[^>]*>Server</);
    assert.match(ready, /class="child"[^>]*>Server</);
    assert.match(ready, /class="forward"[^>]*>Server</);
    assert.match(ready, /class="local"[^>]*>Local</);
    assert.match(ready, /class="selected"[^>]*>7</);
    assert.doesNotMatch(ready, /waiting\./i);
  });

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) it(`${name} waits, claims early edits and copies drafts before immediate nested writes`, async () => {
    const browser = await launchParityBrowser(engine);
    try {
      await exerciseStateInitialization(await browser.newPage(), bundle);
    } finally { await browser.close(); }
  });
});
