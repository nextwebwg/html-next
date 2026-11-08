import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "vite";
import { chromium, firefox, webkit } from "playwright";
import { htmlNext, hydrationModule } from "../src/index.js";
import { decodeHydrationValue } from "../../html-next/src/hydration-value.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const execute = promisify(execFile);
const host = fileURLToPath(new URL("../../html-next-dotnet/tests/HtmlNext.FixtureHost/", import.meta.url));
const source = '<template component="x-card"><defs><prop name="title" type="string" default="Default">Title.</prop><state name="draft" type="string" from="$title"></state></defs><article><input value="Original"><b>{$title}</b><output>{$draft}</output></article></template><template component="x-static"><p>StaticOnlyFactoryMarker</p></template>'
  + '<template component="x-flow"><defs><prop name="show" type="boolean" default="true">Show.</prop><prop name="rows" type="list(number)" default="[1, 2]">Rows.</prop><prop name="mode" type="number" default="1">Mode.</prop></defs><div><section $if="$show"><input value="Conditional"></section><ul><li $each="row, index of $rows" $key="$row"><input value="Row"><b>{$row}</b><i>{$index}</i></li></ul><template $each="row of $rows"><em>{$row}</em><small>tail</small></template><aside $with="$mode as current"><output>{$current}</output></aside><template $match><b $when="$mode = 1">First</b><i $else>Second</i></template><x-card title="Nested"></x-card></div></template>'
  + '<template component="x-shell"><defs><prop name="title" type="string" default="Shell">Title.</prop></defs><x-card from:title="$title"></x-card></template>'
  + '<template component="x-slots"><defs><prop name="open" type="boolean" default="false">Open.</prop><slot name="row"><prop name="item" type="string">Item.</prop></slot></defs><article><section $if="$open"><slot name="details"></slot></section><slot name="row" from:item="\'Row\'"></slot><slot>Fallback</slot></article></template>'
  + '<template component="x-project"><defs><prop name="open" type="boolean" default="false">Open.</prop></defs><div><x-slots from:open="$open"><input slot="details" value="Details"><template slot="row"><b>{$item}</b></template>Summary</x-slots></div></template>'
  + '<template component="x-data"><defs><prop name="payload" type="object" open>Payload.</prop><state name="draft" from="{left: $payload.value, right: $payload.value}"></state></defs><output>{$draft.left = $draft.right}:{$draft.left.name}</output></template>'
  + '<template component="x-attrs"><defs><prop name="tone" type="string" default="quiet">Tone.</prop></defs><div><section $attributes from:data-tone="$tone"></section></div></template><template component="x-attribute-source"><x-attrs tone="bright" title="Outside" class="consumer"></x-attrs></template>'
  + '<template component="x-selected"><defs><type name="input-value" from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type><prop name="value" type="input-value">Value.</prop><prop name="mode" type="keyword" values="text, number" required>Mode.</prop></defs><output>{$value}:{$value = 3}</output></template>';

describe.skipIf(process.env.HTMLNEXT_DOTNET_TEST !== "1")("native C# instance adoption", () => {
  let directory: string;
  let bundle: string;
  let manifest: unknown;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-dotnet-hydration-"));
    await execute("dotnet", ["restore", host, "--locked-mode"], { timeout: 60_000 });
    await execute("dotnet", ["build", host, "-c", "Release", "--nologo", "--no-restore"], { timeout: 60_000 });
    await writeFile(join(directory, "card.html"), source);
    await writeFile(join(directory, "main.js"), `export { hydrate } from ${JSON.stringify(hydrationModule)}; export { componentRegistry } from "@nextwebwg/html-next/generated-runtime";`);
    await build({ root: directory, configFile: false, logLevel: "silent", plugins: [htmlNext.vite({ entries: ["card.html"], hydrate: true, client: { publicRoots: ["x-card", "x-flow", "x-shell", "x-project", "x-data", "x-attribute-source", "x-selected"] } })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": fileURLToPath(new URL("../../html-next/src/generated-runtime.ts", import.meta.url)) } },
      build: { minify: false, lib: { entry: join(directory, "main.js"), formats: ["iife"], name: "NativeClient", fileName: () => "app.js", cssFileName: "components" } } });
    bundle = await readFile(join(directory, "dist/app.js"), "utf8");
    manifest = JSON.parse(await readFile(join(directory, "dist/html-next.manifest.json"), "utf8"));
  }, 60_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  async function render(tag: string, inputs: object = {}): Promise<string> {
    const request = join(directory, "request.json");
    await writeFile(request, JSON.stringify({ source, tag, inputs, manifest }));
    return (await execute("dotnet", [join(host, "bin/Release/net10.0/HtmlNext.FixtureHost.dll"), request])).stdout;
  }

  it("adopts native output with the compiler-selected client and preserves edits and one-time seeds", async () => {
    const html = await render("x-card", { title: "Server title" });
    const { window } = new JSDOM(html, { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("article")!;
      const output = root.querySelector("output");
      const input = root.querySelector("input")!;
      const record = JSON.parse(root.getAttribute("data-html-next-instance")!);
      assert.equal(record[0], 1);
      assert.deepEqual(decodeHydrationValue(record[1]), { "x-card": {
        explicit: ["title"], inputs: { title: { value: "Server title", source: "value", present: true, provided: true, producer: false } },
        props: { title: "Server title" }, state: { draft: "Server title" }, initialized: ["draft"], attributes: [],
      } });
      input.value = "Early draft";
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("article"), root);
      assert.equal(root.querySelector("output"), output);
      assert.equal(input.value, "Early draft");
      assert.equal(root.querySelector("b")!.textContent, "Server title");
      client.componentRegistry.update(root, { title: "Client title" });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("b")!.textContent, "Client title");
      assert.equal(output!.textContent, "Server title");
      assert.equal(input.value, "Early draft");
      assert.doesNotMatch(bundle, /StaticOnlyFactoryMarker/);
    } finally { window.close(); }
  });

  it("adopts structural ranges and keyed rows without replacing native controls or nested roots", async () => {
    const { window } = new JSDOM(await render("x-flow"), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("div")!;
      const inputs = [...root.querySelectorAll("input")];
      const nested = root.querySelector("article");
      inputs.forEach((input, index) => { input.value = `Edit ${index}`; });
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("div"), root);
      assert.deepEqual([...root.querySelectorAll("input")], inputs);
      assert.equal(root.querySelector("article"), nested);
      client.componentRegistry.update(root, { rows: [2, 1, 3], mode: 2, show: false });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("section"), null);
      assert.deepEqual([...root.querySelectorAll("li input")].map(input => (input as HTMLInputElement).value), ["Edit 2", "Edit 1", "Row"]);
      assert.deepEqual([...root.querySelectorAll("li b")].map(node => node.textContent), ["2", "1", "3"]);
      assert.deepEqual([...root.querySelectorAll("li i")].map(node => node.textContent), ["0", "1", "2"]);
      assert.equal(root.querySelector("aside output")!.textContent, "2");
      assert.equal(root.querySelector("article"), nested);
    } finally { window.close(); }
  });

  it("recovers both owners on a delegated root and keeps nested instance records separate", async () => {
    const { window } = new JSDOM(await render("x-shell", { title: "Shared" }), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("article")!;
      const input = root.querySelector("input")!;
      input.value = "Shared edit";
      const records = decodeHydrationValue(JSON.parse(root.getAttribute("data-html-next-instance")!)[1]) as Record<string, { props: object }>;
      assert.deepEqual(Object.keys(records), ["x-shell", "x-card"]);
      assert.deepEqual(records["x-shell"]!.props, { title: "Shared" });
      assert.deepEqual(records["x-card"]!.props, { title: "Shared" });
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("article"), root);
      assert.equal(input.value, "Shared edit");
      client.componentRegistry.update(root, { title: "Changed" });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("b")!.textContent, "Changed");
      assert.equal(root.querySelector("output")!.textContent, "Shared");
    } finally { window.close(); }
  });

  it("adopts scoped templates and carried plain content before a conditional outlet opens", async () => {
    const { window } = new JSDOM(await render("x-project"), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("div")!;
      const article = root.querySelector("article");
      const scoped = root.querySelector("b");
      const carrier = root.querySelector<HTMLTemplateElement>('template[carrier="x-slots"]')!;
      const input = carrier.content.querySelector("input")!;
      input.value = "Carried edit";
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("div"), root);
      assert.equal(root.querySelector("article"), article);
      assert.equal(root.querySelector("b"), scoped);
      assert.equal(scoped!.textContent, "Row");
      assert.equal(root.querySelector("section"), null);
      client.componentRegistry.update(root, { open: true });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("section input"), input);
      assert.equal(input.value, "Carried edit");
      assert.equal(root.querySelector("template[carrier]"), null);
    } finally { window.close(); }
  });

  it("preserves shared data references and the distinct state draft in the browser decoder", async () => {
    const html = await render("x-data", { payload: { value: { name: "Shared data" } } });
    const { window } = new JSDOM(html, { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("output")!;
      const records = decodeHydrationValue(JSON.parse(root.getAttribute("data-html-next-instance")!)[1]) as Record<string, any>;
      const record = records["x-data"]!;
      assert.equal(record.props.payload, record.inputs.payload.value);
      assert.equal(record.state.draft.left, record.state.draft.right);
      assert.notEqual(record.state.draft.left, record.props.payload.value);
      window.eval(bundle);
      Reflect.get(window, "NativeClient").hydrate();
      assert.equal(window.document.querySelector("output"), root);
      assert.equal(root.textContent, "true:Shared data");
    } finally { window.close(); }
  });

  it("records only the invocation attributes not consumed by props for an explicit forwarding owner", async () => {
    const { window } = new JSDOM(await render("x-attribute-source"), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("div")!;
      const records = decodeHydrationValue(JSON.parse(root.getAttribute("data-html-next-instance")!)[1]) as Record<string, any>;
      assert.deepEqual(records["x-attrs"]!.attributes, [["title", "Outside"], ["class", "consumer"]]);
      const section = root.querySelector("section")!;
      window.eval(bundle);
      Reflect.get(window, "NativeClient").hydrate();
      assert.equal(window.document.querySelector("section"), section);
      assert.equal(section.title, "Outside");
      assert.equal(section.className, "consumer");
      assert.equal(section.getAttribute("tone"), null);
    } finally { window.close(); }
  });

  for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${name} adopts native records, ranges, shared roots and carried slots`, async () => {
      const html = `<main id="card">${await render("x-card", { title: null })}</main><main id="flow">${await render("x-flow")}</main><main id="shell">${await render("x-shell", { title: "Shared" })}</main><main id="project">${await render("x-project")}</main><main id="selected">${await render("x-selected", { mode: "number", value: 3 })}</main><main id="unselected">${await render("x-selected", { mode: null, value: 3 })}</main>`;
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(html);
        await page.evaluate(() => {
          Reflect.set(window, "nativeRoots", [...document.querySelectorAll("[component]")]);
          Reflect.set(window, "nativeInputs", [...document.querySelectorAll("input")]);
          document.querySelectorAll("input").forEach((input, index) => { input.value = `Early ${index}`; });
          const carrier = document.querySelector<HTMLTemplateElement>('#project template[carrier="x-slots"]')!;
          const input = carrier.content.querySelector("input")!;
          input.value = "Carried browser edit";
          Reflect.set(window, "carriedInput", input);
        });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => Reflect.get(window, "NativeClient").hydrate());
        assert.equal(await page.evaluate(() => Reflect.get(window, "nativeRoots").every((root: Element, index: number) => document.querySelectorAll("[component]")[index] === root)
          && Reflect.get(window, "nativeInputs").every((input: HTMLInputElement, index: number) => document.querySelectorAll("input")[index] === input && input.value === `Early ${index}`)), true);
        assert.equal(await page.locator("#card b").textContent(), "Default");
        assert.equal(await page.locator("#selected output").textContent(), "3:true");
        assert.equal(await page.locator("#unselected output").textContent(), ":false");
        await page.evaluate(() => {
          const registry = Reflect.get(window, "NativeClient").componentRegistry;
          registry.update(document.querySelector("#card article"), { title: "Client" });
          registry.update(document.querySelector("#flow div"), { rows: [2, 1, 3], mode: 2, show: false });
          registry.update(document.querySelector("#shell article"), { title: "Changed" });
          registry.update(document.querySelector("#project div"), { open: true });
          registry.update(document.querySelector("#selected output"), { mode: "text", value: "3" });
          registry.update(document.querySelector("#unselected output"), { mode: "number", value: 3 });
        });
        await page.waitForFunction(() => document.querySelector("#flow aside output")?.textContent === "2" && document.querySelector("#project section input") !== null);
        assert.equal(await page.locator("#card b").textContent(), "Client");
        assert.equal(await page.locator("#card output").textContent(), "Default");
        assert.deepEqual(await page.locator("#flow li input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), ["Early 3", "Early 2", "Row"]);
        assert.equal(await page.locator("#shell b").textContent(), "Changed");
        assert.equal(await page.locator("#shell output").textContent(), "Shared");
        assert.equal(await page.locator("#selected output").textContent(), "3:false");
        assert.equal(await page.locator("#unselected output").textContent(), "3:true");
        assert.equal(await page.evaluate(() => document.querySelector("#project section input") === Reflect.get(window, "carriedInput")), true);
        assert.equal(await page.locator("#project section input").inputValue(), "Carried browser edit");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
