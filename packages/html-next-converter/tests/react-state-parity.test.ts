import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { stateInitializationFiles as files } from "./fixtures/state-initialization.js";
import { exerciseStateInitialization } from "./helpers/state-initialization.js";

describe.skipIf(!enabled)("React one-time state through the converter", () => {
  let directory = "";
  let bundle: string;
  let concurrentBundle: string;
  let render: (props: object) => string;
  let renderCycle: () => string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-state-"));
    const nodeModules = fileURLToPath(new URL("../../html-next/node_modules", import.meta.url));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    await writeFile(join(directory, "concurrent.html"), `<link rel="component" href="./reader.html"><template component="x-concurrent" module="./concurrent.js"><defs>
      <prop name="seed" type="string">Seed.</prop><prop name="model" type="object({ name: string })">Model.</prop><prop name="saved" type="string">Saved.</prop><prop name="earlySaved" type="string">Early saved.</prop><prop name="items" type="list(string)">Items.</prop><prop name="choice">Choice.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
      <state name="draft" type="string" from="$seed"></state><state name="ordinary" type="string" value="Before"></state><state name="ordinaryRecord" type="object({ name: string })" value='{"name":"Before"}'></state><state name="modelDraft" type="object({ name: string })" from="$model"></state><state name="early" type="string" from="$seed"></state><state name="typed" type="number" from="$seed != 'Retry' ? $seed : 9"></state><state name="list" type="list(string)" from="$items"></state><state name="mode" type="keyword" values="text, number" from="$seed != 'Abandoned' ? 'number' : 'text'"></state><computed name="label" type="string" from="$draft"></computed>
      </defs><section><b $await="$draft">{$draft}</b><i $else>Waiting.</i><output>{$saved}</output><x-concurrent-reader></x-concurrent-reader><slot></slot></section></template>`);
    await writeFile(join(directory, "concurrent.js"), `import { bindModule } from "@nextwebwg/html-next/bindings";
      export const { connect } = bindModule({ props: { earlySaved: { input: (_props, {state}) => state.early, load: value => { (window.earlyReads ||= []).push(value); return value; } }, saved: { input: (_props, {state}) => state.label, load: value => { (window.seedReads ||= []).push(value); return value; } } },
        connect(host) { window.seedHost = host; window.seedPort = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1")); window.seedSource = window.seedPort.source("seed"); window.itemsSource = window.seedPort.source("items"); window.choiceSource = window.seedPort.source("choice"); window.modelSource = window.seedPort.source("model"); } });`);
    await writeFile(join(directory, "reader.html"), `<template component="x-concurrent-reader" module="./reader.js"><defs>
      <context name="draft" from="x-concurrent" as="inherited"></context><context name="modelDraft" from="x-concurrent" as="inheritedModel"></context><context name="ordinaryRecord" from="x-concurrent"></context><prop name="seenModel" type="string">Seen model.</prop><prop name="ordinarySeen" type="string">Ordinary seen.</prop><state name="local" type="string" from="$inherited"></state><prop name="seen" type="string">Seen.</prop>
      </defs><aside>{$seen}</aside></template>`);
    await writeFile(join(directory, "reader.js"), `import { bindModule } from "@nextwebwg/html-next/bindings";
      export const { connect } = bindModule({ props: { ordinarySeen: { input: (_props, {state}) => state.ordinaryRecord.name, load: value => { (window.ordinaryContextReads ||= []).push(value); return value; } }, seenModel: { input: (_props, {state}) => state.inheritedModel.name, load: value => { (window.modelContextReads ||= []).push(value); return value; } }, seen: { input: (_props, {state}) => state.inherited, load: value => { (window.contextReads ||= []).push(value); return value; } } }, connect(host) { window.readerHost = host; } });`);
    await writeFile(join(directory, "cycle.html"), '<template component="x-cycle"><defs><state name="first" type="string" from="$second"></state><state name="second" type="string" from="$first"></state></defs><output>{$first}</output></template>');
    const out = join(directory, "output");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory: out, entries: ["parent.html", "concurrent.html", "cycle.html"] });
    const cycle = manifest.components.find(component => component.tag === "x-cycle")!.artifact;
    const parent = manifest.components.find(component => component.tag === "x-seed")!.artifact;
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, noEmit: true, jsx: "react-jsx", allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files: manifest.components.map(component => component.artifact) }));
    try { await promisify(execFile)(fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)), ["-p", join(out, "tsconfig.json")], { cwd: out }); }
    catch (error) { throw new Error((error as { stdout?: string }).stdout || String(error), { cause: error }); }
    const alias = { "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) };
    const entry = join(out, "entry.tsx");
    await writeFile(entry, `import React from "react"; import { createRoot, hydrateRoot } from "react-dom/client"; import Parent from "./${parent}"; const mount = document.querySelector("#mount"); if (window.seedHydration) hydrateRoot(mount, <Parent {...window.seedHydration}/>, { onRecoverableError: error => (window.hydrationErrors ||= []).push(error.message) }); else createRoot(mount).render(<React.StrictMode><Parent/></React.StrictMode>);`);
    bundle = join(out, "client.js");
    await build({ alias, entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: "es2022", nodePaths: [nodeModules], loader: { ".css": "empty" }, jsx: "automatic" });
    const concurrent = manifest.components.find(component => component.tag === "x-concurrent")!.artifact;
    const concurrentEntry = join(out, "concurrent-entry.tsx");
    await writeFile(concurrentEntry, `import React from "react"; import { createRoot } from "react-dom/client"; import Draft from "./${concurrent}";
      let blocked = false, release; const suspended = new Promise(resolve => { release = resolve; });
      function Pause() { if (blocked) { window.didSuspend = true; throw suspended; } return null; }
      function Child({edit}) { React.useLayoutEffect(() => { if (edit) { window.seedHost.state.draft = "Child edit"; window.seedHost.state.ordinary = "Child ordinary"; } }); return null; }
      function App() { const [props,set] = React.useState({}); React.useLayoutEffect(() => { window.parentLayoutValue = window.seedHost?.state.ordinary; }); window.change = value => React.startTransition(() => set(value));
        window.pause = () => { blocked = true; }; window.resume = () => { blocked = false; release(); };
        return <React.Suspense fallback={<em>Suspended</em>}><Draft seed={props.seed}><Child edit={props.edit}/><Pause/></Draft></React.Suspense>; }
      createRoot(document.querySelector("#mount")).render(<React.StrictMode><App/></React.StrictMode>);`);
    concurrentBundle = join(out, "concurrent-client.js");
    await build({ alias, entryPoints: [concurrentEntry], outfile: concurrentBundle, bundle: true, format: "iife", platform: "browser", target: "es2022", nodePaths: [nodeModules], loader: { ".css": "empty" }, jsx: "automatic" });
    const server = join(out, "server.tsx");
    await writeFile(server, `import React from "react"; import { renderToString } from "react-dom/server"; import Parent from "./${parent}"; import Cycle from "./${cycle}"; export const render = props => renderToString(<Parent {...props}/>); export const renderCycle = () => renderToString(<Cycle/>);`);
    const serverBundle = join(out, "server.mjs");
    await build({ alias, entryPoints: [server], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" }, jsx: "automatic" });
    const serverModule = await import(pathToFileURL(serverBundle).href);
    render = serverModule.render; renderCycle = serverModule.renderCycle;
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

  it("diagnoses actual initializer cycles rather than rejecting the declaration", () => {
    assert.throws(renderCycle, /HR006: A reactive computed value depends on itself/);
  });

  it("isolates abandoned seeds, notifies providers while Suspense blocks commits and preserves child layout writes", async () => {
    const browser = await launchParityBrowser(chromium);
    const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(5_000);
    try {
      await page.setContent('<div id="mount"></div>'); await page.addScriptTag({ path: concurrentBundle });
      await page.waitForFunction(() => (window as any).seedSource && (window as any).readerHost && document.querySelector("i")?.textContent === "Waiting.");
      await page.evaluate(() => { (window as any).pause(); (window as any).change({seed: "Abandoned"}); });
      await page.waitForFunction(() => (window as any).didSuspend);
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.draft), undefined);
      await page.evaluate(() => { (window as any).seedHost.state.early = undefined; });
      await page.waitForFunction(() => (window as any).earlyReads?.includes(null));
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.early), null, "an equal early write wakes its provider without a commit");
      await page.evaluate(() => {
        (window as any).seedHost.state.ordinaryRecord.name = "Ordinary edited";
        (window as any).modelSource.publish({value: {name: "Original"}, status: { ready: true, pending: false, error: null, stale: false }});
        (window as any).seedHost.state.modelDraft.name = "Model edited";
      });
      await page.waitForFunction(() => (window as any).ordinaryContextReads?.includes("Ordinary edited") && (window as any).modelContextReads?.includes("Model edited"));
      await page.evaluate(() => { (window as any).seedHost.state.modelDraft.name = "Second edit"; });
      await page.waitForFunction(() => (window as any).modelContextReads?.includes("Second edit"));
      await page.evaluate(() => (window as any).seedSource.publish({value: "Source", status: { ready: true, pending: false, stale: false, error: null }}));
      // No imperative state read or React commit is needed to wake this dependent provider.
      await page.waitForFunction(() => (window as any).seedReads?.includes("Source") && (window as any).contextReads?.includes("Source"));
      assert.equal(await page.evaluate(() => (window as any).readerHost.state.local), "Source", "a context seed claims the first canonical value while commits remain blocked");
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.draft), "Source");
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.typed), undefined, "a wrong-typed initializer cannot claim ownership");
      assert.equal(await page.evaluate(() => (window as any).choiceSource.publish({value: 7, status: { ready: true, pending: false, stale: false, error: null }})), true);
      assert.equal(await page.evaluate(() => (window as any).seedPort.read("choice")), 7, "source validation uses canonical number mode, never speculative text mode");
      assert.equal(await page.evaluate(() => { (window as any).itemsSource.publish({value: ["Original"], status: { ready: true, pending: false, stale: false, error: null }}); (window as any).seedHost.state.list[0] = "Edited"; return (window as any).seedPort.read("items")[0]; }), "Original");
      await page.evaluate(() => { (window as any).seedHost.state.draft = null; (window as any).resume(); (window as any).change({seed: "Retry"}); });
      await page.waitForFunction(() => !document.querySelector("em") && document.querySelector("b")?.textContent === "");
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.draft), null);
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.typed), 9);
      await page.evaluate(() => (window as any).change({seed: "Next", edit: true}));
      await page.waitForFunction(() => document.querySelector("b")?.textContent === "Child edit");
      assert.equal(await page.evaluate(() => (window as any).seedHost.state.draft), "Child edit");
      assert.equal(await page.evaluate(() => (window as any).parentLayoutValue), "Child ordinary", "a later parent layout observes the child write before any correction render");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) for (const ready of [false, true]) it(`${name} hydrates a ${ready ? "ready" : "waiting"} server seed and preserves local edits`, async () => {
    const browser = await launchParityBrowser(engine); const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(5_000);
    try {
      const props = ready ? { product: { name: "Server" } } : {};
      await page.setContent('<div id="mount">' + render(props) + '</div>');
      await page.evaluate(props => { (window as any).seedHydration = props; }, props);
      const field = ready ? "input.draft" : "input.early";
      await page.locator(field).fill("Typed before hydration");
      await page.addScriptTag({ path: bundle }); await page.waitForFunction(() => (window as any).source && (window as any).childPort);
      assert.equal(await page.locator(field).inputValue(), "Typed before hydration");
      if (!ready) {
        assert.equal(await page.evaluate(() => (window as any).port.status("draft").ready), false);
        await page.evaluate(() => (window as any).source.publish({value: { name: "Server" }, status: { ready: true, pending: false, error: null, stale: false }}));
      }
      assert.equal(await page.evaluate(() => (window as any).host.state.draft.name), "Server");
      assert.equal(await page.evaluate(() => { (window as any).host.state.draft.name = "Edited"; return (window as any).port.read("product").name; }), "Server");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Edited"); assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => (window as any).hydrationErrors || []), []);
    } finally { await browser.close(); }
  });

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) it(`${name} waits, claims early edits and copies drafts before immediate nested writes`, async () => {
    const browser = await launchParityBrowser(engine);
    try {
      await exerciseStateInitialization(await browser.newPage(), bundle);
    } finally { await browser.close(); }
  });
});
