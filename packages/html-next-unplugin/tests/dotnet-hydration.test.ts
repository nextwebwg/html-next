import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { build } from "vite";
import { chromium, firefox, webkit } from "playwright";
import { htmlNext, hydrationModule } from "../src/index.js";
import { decodeHydrationValue, encodeHydrationValue } from "../../html-next/src/hydration-value.js";
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
  + '<template component="x-selected"><defs><type name="input-value" from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type><prop name="value" type="input-value">Value.</prop><prop name="mode" type="keyword" values="text, number" required>Mode.</prop></defs><output>{$value}:{$value = 3}</output></template>'
  + '<template component="x-selected-default"><defs><type name="input-value" from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type><prop name="value" type="input-value" default="3">Value.</prop><prop name="mode" type="keyword" values="text, number" default="number">Mode.</prop></defs><output>{$value}:{$value = 3}</output><style>:host([value]){color:red}</style></template>'
  + '<template component="x-native-select"><defs><prop name="disabled" type="boolean" default="false">Disabled.</prop></defs><select from:disabled="$disabled"><option value="a">A</option><option value="b" selected>B</option></select></template>';
const waitingSource = '<template component="x-wait"><defs><prop name="rows" type="list(string)">Rows.</prop><state name="draft" type="list(string)" from="$rows"></state></defs><article><input value="Original"><b>{$rows.length}</b><output>{$draft.length}</output></article></template>'
  + '<template component="x-wait-shell"><defs><prop name="rows" type="list(string)">Rows.</prop></defs><main><x-wait from:rows="$rows"></x-wait></main></template>'
  + '<template component="x-wait-literal"><defs><state name="raw" value="wrong"></state></defs><main><x-wait rows="[&quot;Literal&quot;]" from:rows="$raw"></x-wait></main></template>';
const acceptedSource = '<template component="x-column"><defs><prop name="header" type="string">Header.</prop><slot name="cell"></slot></defs><aside><b>{$header}</b></aside></template>'
 + '<template component="x-list"><defs><prop name="open" type="boolean" default="true">Open.</prop><slot accepts="x-column" as="columns"></slot></defs><section><ul><li $each="column of $columns" $key="$column"><h3>{$column.header}</h3><template $if="$open"><slot of="$column" name="cell"></slot></template></li></ul><div hidden><slot></slot></div></section></template>'
 + '<template component="x-page"><defs><prop name="headers" type="list(string)" default="[\'One\', \'Two\']">Headers.</prop></defs><main><x-list><x-column $each="header of $headers" $key="$header" from:header="$header"><input slot="cell" value="Original"></x-column></x-list></main></template>';
const preparedSource = '<template component="x-prepared" module="./producer.js"><defs><prop name="count" type="integer" default="2">Count.</prop><prop name="filters" type="list(string)" default="[]">Filters.</prop><prop name="rows" type="list(string)">Rows.</prop><state name="draft" type="list(string)" from="$rows"></state></defs><section><ul><li $each="row of $rows" $key="$row"><input value="Original"><b>{$row}</b></li></ul><output>{$draft.length}</output></section></template>';

describe.skipIf(process.env.HTMLNEXT_DOTNET_TEST !== "1")("native C# instance adoption", () => {
  let directory: string;
  let bundle: string;
  let manifest: unknown;
  let preparedBundle: string;
  let preparedManifest: unknown;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-dotnet-hydration-"));
    await execute("dotnet", ["restore", host, "--locked-mode"], { timeout: 60_000 });
    await execute("dotnet", ["build", host, "-c", "Release", "--nologo", "--no-restore"], { timeout: 60_000 });
    await writeFile(join(directory, "card.html"), source + acceptedSource + waitingSource);
    await writeFile(join(directory, "prepared.html"), preparedSource);
    await writeFile(join(directory, "producer.js"), `import { bindModule } from "@nextwebwg/html-next/bindings";
      const instances = new WeakMap();
      function binding(host, source) {
        let value = instances.get(host.props);
        if (!value) {
          value = bindModule({ props: { rows: { input: props => ({ count: props.count, filters: props.filters }),
            load({ count, filters }) { window.preparedReads = (window.preparedReads ?? 0) + 1; return Array.from({length: count}, (_, index) => count + ":" + index + ":" + filters.length); }
          } }, connect(host) { host.root.setAttribute("data-connected", "true"); } }, { browser: { source } });
          instances.set(host.props, value);
        }
        return value;
      }
      export const prepare = (host, options) => binding(host, options.source).prepare(host, options);
      export const adopt = (host, options) => binding(host, options.snapshot.source).adopt(host, options);
      export const connect = (host, options) => binding(host).connect(host, options);`);
    await writeFile(join(directory, "main.js"), `export { hydrate } from ${JSON.stringify(hydrationModule)}; export { componentRegistry } from "@nextwebwg/html-next/generated-runtime";`);
    await build({ root: directory, configFile: false, logLevel: "silent", plugins: [htmlNext.vite({ entries: ["card.html"], hydrate: true, client: { publicRoots: ["x-card", "x-flow", "x-shell", "x-project", "x-data", "x-attribute-source", "x-selected", "x-selected-default", "x-native-select", "x-page", "x-list", "x-column", "x-wait", "x-wait-shell", "x-wait-literal"] } })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": fileURLToPath(new URL("../../html-next/src/generated-runtime.ts", import.meta.url)),
        "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) } },
      build: { minify: false, lib: { entry: join(directory, "main.js"), formats: ["iife"], name: "NativeClient", fileName: () => "app.js", cssFileName: "components" } } });
    bundle = await readFile(join(directory, "dist/app.js"), "utf8");
    manifest = JSON.parse(await readFile(join(directory, "dist/html-next.manifest.json"), "utf8"));
    await build({ root: directory, configFile: false, logLevel: "silent", plugins: [htmlNext.vite({ entries: ["prepared.html"], hydrate: true, client: { publicRoots: ["x-prepared"] } })],
      resolve: { alias: { "@nextwebwg/html-next/generated-runtime": fileURLToPath(new URL("../../html-next/src/generated-runtime.ts", import.meta.url)),
        "@nextwebwg/html-next/bindings": fileURLToPath(new URL("../../html-next/src/bindings.ts", import.meta.url)) } },
      build: { outDir: "prepared", minify: false, lib: { entry: join(directory, "main.js"), formats: ["iife"], name: "NativeClient", fileName: () => "app.js", cssFileName: "components" } } });
    preparedBundle = await readFile(join(directory, "prepared/app.js"), "utf8");
    preparedManifest = JSON.parse(await readFile(join(directory, "prepared/html-next.manifest.json"), "utf8"));
  }, 60_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  async function render(tag: string, inputs: object = {}, prepared?: object, assets = manifest, definitions = source + acceptedSource + waitingSource): Promise<string> {
    const request = join(directory, "request.json");
    await writeFile(request, JSON.stringify({ source: definitions, tag, inputs, manifest: assets, prepared }));
    return (await execute("dotnet", [join(host, "bin/Release/net10.0/HtmlNext.FixtureHost.dll"), request])).stdout;
  }

  async function prepared(): Promise<string> {
    const source = (preparedManifest as { server: { preparedModules: { tag: string; source: string }[] } }).server.preparedModules.find(item => item.tag === "x-prepared")!.source;
    return render("x-prepared", {}, { "x-prepared": { source, reads: { rows: { input: { count: 2, filters: [] }, value: ["2:0:0", "2:1:0"] } } } }, preparedManifest, preparedSource);
  }

  it("adopts a valid literal fallback after refusing a bound value", async () => {
    const { window } = new JSDOM(await render("x-wait-literal"), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("article")!;
      const output = root.querySelector("output")!;
      assert.equal(output.textContent, "1");
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("article"), root);
      assert.equal(root.querySelector("output"), output);
      assert.equal(output.textContent, "1");
      client.componentRegistry.update(root, { rows: ["One", "Two"] });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("b")!.textContent, "2");
      assert.equal(output.textContent, "1");
    } finally { window.close(); }
  });

  it.each(["x-wait", "x-wait-shell"])("keeps an omitted prop's state seed waiting until its first caller value arrives (%s)", async tag => {
    const { window } = new JSDOM(await render(tag), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("article")!;
      const owner = tag === "x-wait-shell" ? window.document.querySelector("main")! : root;
      const input = root.querySelector("input")!;
      input.value = "Early waiting";
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("article"), root);
      assert.equal(root.querySelector("output")!.textContent, "");
      client.componentRegistry.update(owner, { rows: ["One", "Two"] });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("b")!.textContent, "2");
      assert.equal(root.querySelector("output")!.textContent, "2");
      client.componentRegistry.update(owner, { rows: ["Later"] });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelector("b")!.textContent, "1");
      assert.equal(root.querySelector("output")!.textContent, "2");
      assert.equal(root.querySelector("input"), input);
      assert.equal(input.value, "Early waiting");
    } finally { window.close(); }
  });

  it("reclaims native borrowed controls after reopening and reorders their accepted entries", async () => {
    const { window } = new JSDOM(await render("x-page"), { runScripts: "dangerously" });
    try {
      const root = window.document.querySelector("main")!;
      const list = root.querySelector("section")!;
      const rows = [...root.querySelectorAll("li")];
      const controls = [...root.querySelectorAll("input")];
      controls.forEach((input, index) => { input.value = `Early ${index}`; });
      window.eval(bundle);
      const client = Reflect.get(window, "NativeClient");
      client.hydrate();
      assert.equal(window.document.querySelector("main"), root);
      assert.deepEqual([...root.querySelectorAll("li")], rows);
      assert.deepEqual([...root.querySelectorAll("input")], controls);
      client.componentRegistry.update(list, { open: false });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(root.querySelectorAll("input").length, 0);
      client.componentRegistry.update(list, { open: true });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.deepEqual([...root.querySelectorAll("input")], controls);
      assert.deepEqual(controls.map(input => input.value), ["Early 0", "Early 1"]);
      client.componentRegistry.update(root, { headers: ["Two", "One", "Three"] });
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.deepEqual([...root.querySelectorAll("h3")].map(element => element.textContent), ["Two", "One", "Three"]);
      assert.equal(root.querySelectorAll("li")[0]!.querySelector("input"), controls[1]);
      assert.equal(root.querySelectorAll("li")[1]!.querySelector("input"), controls[0]);
      assert.equal(root.querySelectorAll("input").length, 3);
    } finally { window.close(); }
  });

  it("adopts native module completion keys without repeating the initial read", async () => {
    const { window } = new JSDOM(await prepared(), { runScripts: "dangerously" });
    Object.assign(window, { fetch: globalThis.fetch, structuredClone: globalThis.structuredClone });
    try {
      const root = window.document.querySelector("section")!;
      const rows = [...root.querySelectorAll("li")];
      const input = rows[0]!.querySelector("input")!;
      assert.deepEqual(rows.map(row => row.textContent), ["2:0:0", "2:1:0"]);
      const frame = JSON.parse(root.getAttribute("data-html-next-bindings")!)["x-prepared"];
      const transfer = decodeHydrationValue(frame[2]) as { snapshot: { source: string; reads: Record<string, unknown> }; inputs: Record<string, unknown> };
      const key = JSON.stringify(encodeHydrationValue({ count: 2, filters: [] }));
      assert.equal(transfer.snapshot.source, frame[1]);
      assert.deepEqual(transfer.snapshot.reads.rows, { input: key, value: key, revision: 0 });
      assert.deepEqual(transfer.inputs.rows, { value: ["2:0:0", "2:1:0"], status: { ready: true, pending: false, error: null, stale: false } });
      input.value = "Early prepared";
      window.eval(preparedBundle);
      Reflect.get(window, "NativeClient").hydrate();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      assert.equal(window.document.querySelector("section"), root);
      assert.equal(root.querySelector("li"), rows[0]);
      assert.equal(root.querySelector("input"), input);
      assert.equal(input.value, "Early prepared");
      assert.equal(root.getAttribute("data-connected"), "true");
      assert.equal(root.hasAttribute("data-html-next-bindings"), false);
      assert.equal(Reflect.get(window, "preparedReads") ?? 0, 0);
      Reflect.get(window, "NativeClient").componentRegistry.update(root, { count: 3 });
      await vi.waitFor(() => assert.deepEqual([...root.querySelectorAll("b")].map(row => row.textContent), ["3:0:0", "3:1:0", "3:2:0"]), { timeout: 1000, interval: 10 });
      assert.equal(Reflect.get(window, "preparedReads"), 1);
      assert.equal(root.querySelector("output")!.textContent, "2");
    } finally { window.close(); }
  });

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
    it.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${name} adopts native select options and preserves an early selection`, async () => {
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(await render("x-native-select"));
        assert.equal(await page.locator("select").inputValue(), "b");
        await page.evaluate(() => {
          const select = document.querySelector("select")!;
          Reflect.set(window, "selectNodes", [select, ...select.options]);
          select.value = "a";
        });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => Reflect.get(window, "NativeClient").hydrate());
        assert.equal(await page.locator("select").inputValue(), "a");
        for (const disabled of [true, false]) {
          await page.evaluate(disabled => Reflect.get(window, "NativeClient").componentRegistry.update(document.querySelector("select"), { disabled }), disabled);
          await page.waitForFunction(disabled => document.querySelector("select")!.disabled === disabled, disabled);
          assert.equal(await page.locator("select").inputValue(), "a");
        }
        assert.equal(await page.evaluate(() => {
          const select = document.querySelector("select")!;
          return [select, ...select.options].every((node, index) => node === Reflect.get(window, "selectNodes")[index]);
        }), true);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    it.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${name} initializes waiting native state from the first later caller value`, async () => {
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(`<section id="direct">${await render("x-wait")}</section><section id="nested">${await render("x-wait-shell")}</section>`);
        await page.evaluate(() => {
          Reflect.set(window, "waitingRoots", [...document.querySelectorAll("article")]);
          Reflect.set(window, "waitingControls", [...document.querySelectorAll("input")]);
          document.querySelectorAll("input").forEach((input, index) => { input.value = `Early ${index}`; });
        });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => Reflect.get(window, "NativeClient").hydrate());
        assert.deepEqual(await page.locator("output").allTextContents(), ["", ""]);
        await page.evaluate(() => {
          const registry = Reflect.get(window, "NativeClient").componentRegistry;
          registry.update(document.querySelector("#direct article"), { rows: ["One", "Two"] });
          registry.update(document.querySelector("#nested main"), { rows: ["One", "Two"] });
        });
        await page.waitForFunction(() => [...document.querySelectorAll("output")].every(output => output.textContent === "2"));
        await page.evaluate(() => {
          const registry = Reflect.get(window, "NativeClient").componentRegistry;
          registry.update(document.querySelector("#direct article"), { rows: ["Later"] });
          registry.update(document.querySelector("#nested main"), { rows: ["Later"] });
        });
        await page.waitForFunction(() => [...document.querySelectorAll("article b")].every(output => output.textContent === "1"));
        assert.deepEqual(await page.locator("output").allTextContents(), ["2", "2"]);
        assert.equal(await page.evaluate(() => Reflect.get(window, "waitingRoots").every((root: Element, index: number) => document.querySelectorAll("article")[index] === root)
          && Reflect.get(window, "waitingControls").every((input: HTMLInputElement, index: number) => document.querySelectorAll("input")[index] === input && input.value === `Early ${index}`)), true);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    it.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${name} reclaims and reorders native borrowed controls`, async () => {
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(await render("x-page"));
        await page.evaluate(() => {
          Object.assign(window, { borrowedRoot: document.querySelector("main"), borrowedRows: [...document.querySelectorAll("li")], borrowedControls: [...document.querySelectorAll("input")] });
          document.querySelectorAll("input").forEach((input, index) => { input.value = `Early ${index}`; });
        });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => Reflect.get(window, "NativeClient").hydrate());
        assert.equal(await page.evaluate(() => document.querySelector("main") === Reflect.get(window, "borrowedRoot")
          && Reflect.get(window, "borrowedRows").every((row: Element, index: number) => document.querySelectorAll("li")[index] === row)
          && Reflect.get(window, "borrowedControls").every((input: HTMLInputElement, index: number) => document.querySelectorAll("input")[index] === input)), true);
        await page.evaluate(() => Reflect.get(window, "NativeClient").componentRegistry.update(document.querySelector("section"), { open: false }));
        await page.waitForFunction(() => document.querySelectorAll("input").length === 0);
        await page.evaluate(() => Reflect.get(window, "NativeClient").componentRegistry.update(document.querySelector("section"), { open: true }));
        await page.waitForFunction(() => document.querySelectorAll("input").length === 2);
        assert.equal(await page.evaluate(() => Reflect.get(window, "borrowedControls").every((input: HTMLInputElement, index: number) => document.querySelectorAll("input")[index] === input && input.value === `Early ${index}`)), true);
        await page.evaluate(() => Reflect.get(window, "NativeClient").componentRegistry.update(document.querySelector("main"), { headers: ["Two", "One", "Three"] }));
        await page.waitForFunction(() => document.querySelectorAll("li").length === 3);
        assert.deepEqual(await page.locator("h3").allTextContents(), ["Two", "One", "Three"]);
        assert.equal(await page.evaluate(() => document.querySelectorAll("li")[0]!.querySelector("input") === Reflect.get(window, "borrowedControls")[1]
          && document.querySelectorAll("li")[1]!.querySelector("input") === Reflect.get(window, "borrowedControls")[0]), true);
        assert.equal(await page.locator("input").count(), 3);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    it.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${name} adopts native prepared reads and refreshes from later caller inputs`, async () => {
      const html = await prepared();
      const browser = await launchParityBrowser(engine);
      try {
        const page = await browser.newPage();
        await page.setContent(html);
        await page.evaluate(() => {
          Object.assign(window, { earlyPreparedRoot: document.querySelector("section"), earlyPreparedRow: document.querySelector("li"), earlyPreparedInput: document.querySelector("input") });
        });
        await page.locator("input").first().fill("Early prepared");
        await page.addScriptTag({ content: preparedBundle });
        await page.evaluate(() => Reflect.get(window, "NativeClient").hydrate());
        await page.waitForFunction(() => document.querySelector("section")?.getAttribute("data-connected") === "true");
        assert.equal(await page.evaluate(() => document.querySelector("section") === Reflect.get(window, "earlyPreparedRoot")
          && document.querySelector("li") === Reflect.get(window, "earlyPreparedRow") && document.querySelector("input") === Reflect.get(window, "earlyPreparedInput")), true);
        assert.equal(await page.locator("input").first().inputValue(), "Early prepared");
        assert.equal(await page.evaluate(() => Reflect.get(window, "preparedReads") ?? 0), 0);
        assert.equal(await page.locator("section").getAttribute("data-html-next-bindings"), null);
        await page.evaluate(() => Reflect.get(window, "NativeClient").componentRegistry.update(document.querySelector("section"), { count: 3 }));
        await page.waitForFunction(() => document.querySelector("b")?.textContent === "3:0:0");
        assert.deepEqual(await page.locator("b").allTextContents(), ["3:0:0", "3:1:0", "3:2:0"]);
        assert.equal(await page.evaluate(() => Reflect.get(window, "preparedReads")), 1);
        assert.equal(await page.locator("output").textContent(), "2");
      } finally { await browser.close(); }
    });

    it.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${name} adopts native records, ranges, shared roots and carried slots`, async () => {
      const html = `<main id="card">${await render("x-card", { title: null })}</main><main id="flow">${await render("x-flow")}</main><main id="shell">${await render("x-shell", { title: "Shared" })}</main><main id="project">${await render("x-project")}</main><main id="selected">${await render("x-selected", { mode: "number", value: 3 })}</main><main id="unselected">${await render("x-selected", { mode: null, value: 3 })}</main><main id="selected-default">${await render("x-selected-default", { mode: "text" })}</main>`;
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
        assert.equal(await page.locator("#selected-default output").textContent(), ":");
        assert.equal(await page.locator("#selected-default output").getAttribute("data-x-selected-default-state"), "value value=3");
        await page.evaluate(() => {
          const registry = Reflect.get(window, "NativeClient").componentRegistry;
          registry.update(document.querySelector("#card article"), { title: "Client" });
          registry.update(document.querySelector("#flow div"), { rows: [2, 1, 3], mode: 2, show: false });
          registry.update(document.querySelector("#shell article"), { title: "Changed" });
          registry.update(document.querySelector("#project div"), { open: true });
          registry.update(document.querySelector("#selected output"), { mode: "text", value: "3" });
          registry.update(document.querySelector("#unselected output"), { mode: "number", value: 3 });
          registry.update(document.querySelector("#selected-default output"), { mode: "number" });
        });
        await page.waitForFunction(() => document.querySelector("#flow aside output")?.textContent === "2" && document.querySelector("#project section input") !== null);
        assert.equal(await page.locator("#card b").textContent(), "Client");
        assert.equal(await page.locator("#card output").textContent(), "Default");
        assert.deepEqual(await page.locator("#flow li input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), ["Early 3", "Early 2", "Row"]);
        assert.equal(await page.locator("#shell b").textContent(), "Changed");
        assert.equal(await page.locator("#shell output").textContent(), "Shared");
        assert.equal(await page.locator("#selected output").textContent(), "3:false");
        assert.equal(await page.locator("#unselected output").textContent(), "3:true");
        assert.equal(await page.locator("#selected-default output").textContent(), "3:true");
        assert.equal(await page.locator("#selected-default output").getAttribute("data-x-selected-default-state"), "value value=3");
        assert.equal(await page.evaluate(() => document.querySelector("#project section input") === Reflect.get(window, "carriedInput")), true);
        assert.equal(await page.locator("#project section input").inputValue(), "Carried browser edit");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
