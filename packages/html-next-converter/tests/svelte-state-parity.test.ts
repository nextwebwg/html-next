import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { stateInitializationFiles as files } from "./fixtures/state-initialization.js";
import { exerciseStateInitialization } from "./helpers/state-initialization.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const checker = createRequire(new URL("../../html-next-unplugin/package.json", import.meta.url)).resolve("svelte-check/bin/svelte-check");

describe.skipIf(!enabled)("Svelte one-time state through the converter", () => {
  let directory = "";
  let bundle: string;
  let render: (props: object) => string;
  let renderCycle: () => string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-state-"));
    const nodeModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    await writeFile(join(directory, "cycle.html"), '<template component="x-cycle"><defs><state name="first" type="string" from="$second"></state><state name="second" type="string" from="$first"></state></defs><output>{$first}</output></template>');
    const out = join(directory, "output");
    const manifest = await convertComponents({ mode: "application", target: "svelte", root: directory, outDirectory: out, entries: ["parent.html", "cycle.html"] });
    const parent = manifest.components.find(component => component.tag === "x-seed")!.artifact;
    const cycle = manifest.components.find(component => component.tag === "x-cycle")!.artifact;
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files: manifest.components.map(component => component.artifact) }));
    try { await promisify(execFile)(process.execPath, [checker, "--tsconfig", join(out, "tsconfig.json")], { cwd: out }); }
    catch (error) { throw new Error((error as { stdout?: string }).stdout || String(error), { cause: error }); }
    const alias = { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) };
    const entry = join(out, "entry.ts");
    await writeFile(entry, `import { mount, hydrate } from "svelte"; import Parent from "./${parent}";
      const hydration = (window as any).seedHydration;
      (hydration ? hydrate : mount)(Parent, { target: document.querySelector("#mount"), props: hydration?.props ?? {} });`);
    bundle = join(out, "client.js");
    await build({ alias, entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: "es2022", conditions: ["browser"], nodePaths: [nodeModules], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
    const server = join(out, "server.ts");
    await writeFile(server, `import { render } from "svelte/server"; import Parent from "./${parent}"; import Cycle from "./${cycle}";
      export const renderComponent = props => render(Parent, { props }).body; export const renderCycle = () => render(Cycle).body;`);
    const serverBundle = join(out, "server.mjs");
    await build({ alias, entryPoints: [server], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
    const serverModule = await import(pathToFileURL(serverBundle).href);
    render = serverModule.renderComponent;
    renderCycle = serverModule.renderCycle;
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("renders waiting and supplied server frames without connection effects", () => {
    const waiting = render({});
    assert.match(waiting, /Waiting\./);
    assert.match(waiting, /Context waiting\./);
    assert.match(waiting, /Child waiting\./);
    const ready = render({ product: { name: "Server" } });
    assert.match(ready, /<h2>Server<\/h2>/);
    for (const name of ["context", "child", "forward"]) assert.match(ready, new RegExp(`class="${name}"[^>]*>Server<`));
    assert.match(ready, /class="local"[^>]*>Local</);
    assert.match(ready, /class="selected"[^>]*>7</);
    assert.doesNotMatch(ready, /waiting\./i);
  });

  it("reports recursive initializer reads with the shared cycle diagnostic", () => {
    assert.throws(renderCycle, /HR006: A reactive computed value depends on itself/);
  });

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) it(`${name} preserves first-value and local-write ownership`, async () => {
    const browser = await launchParityBrowser(engine);
    try { await exerciseStateInitialization(await browser.newPage(), bundle); }
    finally { await browser.close(); }
  });

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) for (const ready of [false, true]) {
    it(`${name} hydrates a ${ready ? "ready" : "waiting"} frame and retains native edits until the model changes`, async () => {
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage(); page.setDefaultTimeout(5_000);
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.text().includes("hydration_mismatch")) errors.push(message.text()); });
        const props = ready ? { product: { name: "Server" } } : {};
        await page.setContent(`<div id="mount">${render(props)}</div>`);
        const control = ready ? "input.draft" : "input.early";
        await page.locator(control).fill("Edited before hydration");
        await page.evaluate(props => { (window as any).seedHydration = { props }; (window as any).originalInput = document.querySelector("input"); }, props);
        await page.addScriptTag({ path: bundle });
        await page.waitForFunction(() => (window as any).source && (window as any).childPort);
        assert.equal(await page.locator(control).inputValue(), "Edited before hydration");
        assert.equal(await page.evaluate(() => document.querySelector("input") === (window as any).originalInput), true);
        if (ready) {
          assert.equal(await page.locator("h2").textContent(), "Server");
          assert.equal(await page.evaluate(() => (window as any).port.read("product").name), "Server");
          await page.locator(control).fill("Edited after hydration");
          await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Edited after hydration");
        } else {
          await page.evaluate(() => (window as any).source.publish({ value: { name: "Client" }, status: { ready: true, pending: false, error: null, stale: false } }));
          await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Client");
          assert.equal(await page.locator(control).inputValue(), "Client");
          await page.locator(control).fill("Edited after hydration");
          await page.evaluate(() => (window as any).source.publish({ value: { name: "Refresh" }, status: { ready: true, pending: false, error: null, stale: false } }));
          assert.equal(await page.locator(control).inputValue(), "Edited after hydration");
        }
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
