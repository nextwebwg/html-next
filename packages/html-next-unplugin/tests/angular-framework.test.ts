import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, it } from "vitest";
import { build, createServer } from "vite";
import { chromium, firefox, webkit } from "playwright";
import htmlNext from "../src/vite.js";
import { syncHtmlNext } from "../src/framework.js";
import { installSourcePackage } from "./source-package.js";
import { angularControls, angularController, angularRequestController, angularTypedController, angularSetup } from "../../html-next-converter/tests/fixtures/angular-controls.js";
import { angularStructural } from "../../html-next-converter/tests/fixtures/angular-structural.js";

const roots: string[] = [];
const require = createRequire(import.meta.url);
const run = promisify(execFile);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const projectionStyles = '<template component="ui-projection-styles"><section><ui-branch><span class="owned-marker">Nested marker</span></ui-branch></section><style>.owned-marker { background: rgb(11, 22, 33); }</style></template>';

const nestedPreparation = `<template component="ui-prepared-parent" module="./prepared-parent.js"><defs><prop name="count" type="integer">Prepared count.</prop></defs><div><ui-prepared-child from:count="$count"></ui-prepared-child></div></template><template component="ui-prepared-child" module="./prepared-child.js"><defs><prop name="count" type="integer" default="2">Row count.</prop><prop name="rows" type="list(string)">Prepared rows.</prop><state name="initialCount" type="integer" from="$count"></state></defs><aside><ol><li $each="row of $rows"><ui-branch>{$row}</ui-branch></li></ol></aside></template>`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "html-next-angular-vite-")); roots.push(root);
  await mkdir(join(root, "src")); await mkdir(join(root, "node_modules"));
  await mkdir(join(root, "node_modules/@angular"));
  await mkdir(join(root, "node_modules/@nextwebwg"));
  await symlink(fileURLToPath(new URL("../../html-next/", import.meta.url)), join(root, "node_modules/@nextwebwg/html-next"), "dir");
  for (const name of ["core", "common", "compiler", "compiler-cli", "platform-browser", "platform-server"]) {
    await symlink(fileURLToPath(new URL(`../node_modules/@angular/${name}`, import.meta.url)), join(root, "node_modules/@angular", name), "dir");
  }
  await symlink(fileURLToPath(new URL("../node_modules/rxjs", import.meta.url)), join(root, "node_modules/rxjs"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { "@example/controls": "1.0.0", "@angular/core": "21.2.24", "@angular/compiler-cli": "21.2.24" } }));
  await installSourcePackage(root, { "components/controls.html": '<template component="ui-instant" module="./instant.js"><defs><state name="text" type="string" value=""></state></defs><form><input aria-label="First field"><output>{$text}</output></form></template>' + projectionStyles + nestedPreparation + angularControls + angularStructural.replace('<template component="ui-branch-holder">', '<template component="ui-branch-holder" module="./holder.js">') + '<template component="ui-native-date"><defs><prop name="value" type="string" default="2026-10-30">Date.</prop></defs><input type="date" step="any" from:value="$value" min="" max=""></template><template component="ui-prepared" module="./prepared.js"><defs><prop name="count" type="integer" default="2">Row count.</prop><prop name="rows" type="list(string)">Prepared rows.</prop></defs><section><ol><li $each="row of $rows">{$row}</li></ol></section></template><template component="ui-lookup" module="./lookup.js"><defs><prop name="limit" type="integer">Optional row limit.</prop><prop name="delay" type="integer" default="500">Default delay.</prop><prop name="name" type="string" default="known">Lookup key.</prop><computed name="items" from="{ known: [1, 2] }[$name]"></computed></defs><div from:data-limit="$limit"><span $each="item of $items">{$item}</span></div></template><template component="ui-press" module="./press.js"><defs><event name="pressed" type="string"></event></defs><span role="button" tabindex="0">Press</span></template>', "components/prepared-child.js": `import { bindModule } from '@nextwebwg/html-next/bindings';
      const bindings = new WeakMap();
      function instance(host, source) {
        let binding = bindings.get(host.props);
        if (!binding) {
          binding = bindModule({ props: { rows: { input: (_props, {state}) => state.initialCount, async load(count) { globalThis.preparedLoads = (globalThis.preparedLoads ?? 0) + 1; return Array.from({length: count}, (_, index) => count + ':' + index); } } } }, { browser: { source } });
          bindings.set(host.props, binding);
        }
        return binding;
      }
      export const prepare = (host, options) => instance(host, options.source).prepare(host, options);
      export const adopt = (host, options) => instance(host, options.snapshot.source).adopt(host, options);
      export const connect = (host, options) => instance(host).connect(host, options);`, "components/prepared-parent.js": `import { bindModule } from '@nextwebwg/html-next/bindings';
      const bindings = new WeakMap();
      function instance(host, source) {
        let binding = bindings.get(host.props);
        if (!binding) {
          binding = bindModule({ props: { count: { input: () => 4, async load(count) { await new Promise(resolve => setTimeout(resolve, 10)); return count; } } } }, { browser: { source } });
          bindings.set(host.props, binding);
        }
        return binding;
      }
      export const prepare = (host, options) => instance(host, options.source).prepare(host, options);
      export const adopt = (host, options) => instance(host, options.snapshot.source).adopt(host, options);
      export const connect = (host, options) => instance(host).connect(host, options);`, "components/lookup.js": 'export function connect(host) { host.root.setAttribute("data-caller-default", host.props.delay.inputValue == null ? "absent" : String(host.props.delay.inputValue)); }', "components/prepared.js": `import { bindModule } from '@nextwebwg/html-next/bindings';
      const instances = new WeakMap();
      const instance = (host, source) => { let binding = instances.get(host.props); if (!binding) { binding = bindModule({ props: { rows: { input: props => props.count, async load(count) { globalThis.preparedLoads = (globalThis.preparedLoads ?? 0) + 1; return Array.from({ length: count }, (_, index) => count + ':' + index); } } }, connect() { globalThis.preparedConnected = true; } }, { browser: { source } }); instances.set(host.props, binding); } return binding; };
      export const prepare = (host, options) => instance(host, options.source).prepare(host, options);
      export const adopt = (host, options) => instance(host, options.snapshot.source).adopt(host, options);
      export const connect = (host, options) => instance(host).connect(host, options);`, "components/instant.js": 'export function connect(host) { return host.on("input", event => { host.state.text = event.target.value; }); }', "components/holder.js": 'export function connect(host) { return host.on("click", event => { event.preventDefault(); host.root.setAttribute("data-ref-tag", host.refs.action?.localName ?? "anchor"); }); }', "components/press.js": 'export function connect(host) { return host.on("pointerdown", () => host.dispatch("pressed", "Updated")); }', "components/connected.js": 'import "./connected.css";\n' + angularController, "components/connected.css": '[data-component~="ui-connected"] { --mixed-root: yes; }', "components/ask.js": angularRequestController, "components/typed.ts": angularTypedController, "components/setup.ts": angularSetup, "components/nested/label.html": '<template component="ui-label"><span>Nested</span></template>' });
  await writeFile(join(root, "src/local.html"), '<template component="ui-local"><em>Local</em></template>');
  await syncHtmlNext({ root, target: "angular", entries: ["src/local.html"] });
  const app = `import { Component } from "@angular/core";
    import { UiAction, type UiActionEvents, UiForm, UiRows, UiConnected, UiFeed, UiMarkup, UiAsk, UiScript, UiScoped, UiScopedRowSlot, UiSlotApp, UiSelected, UiBranch, UiBranchHolder, UiPress, UiLookup, UiPrepared, UiPreparedParent, UiNativeDate, UiTyped, UiInstant, UiProjectionStyles } from "@example/controls"; import { UiLocal } from "./local.html";
    @Component({ selector: "app-root", standalone: true, imports: [UiAction, UiLocal, UiForm, UiRows, UiConnected, UiFeed, UiMarkup, UiAsk, UiScript, UiScoped, UiScopedRowSlot, UiSlotApp, UiSelected, UiBranch, UiBranchHolder, UiPress, UiLookup, UiPrepared, UiPreparedParent, UiNativeDate, UiTyped, UiInstant, UiProjectionStyles],
      template: \`<button ui-action [text]="'Send'" (saved)="receive($event)"><strong>Page</strong><em ui-local></em></button><section ui-projection-styles></section><p id="saved">{{saved}}:{{saves}}</p><form ui-form></form><section ui-rows></section><aside ui-connected></aside><div ui-typed></div><div ui-feed></div><div ui-markup></div><div ui-ask [pick]="pick"></div><div ui-script></div><ul ui-scoped><ng-template ui-scoped-row let-item="item" let-index="index"><li>{{item.toUpperCase()}}{{index}}</li></ng-template></ul><nav ui-slot-app></nav><div ui-selected [format]="'number'" [answer]="42"></div><input type="checkbox" aria-label="Disable branch" [checked]="branchDisabled" (change)="branchDisabled = $any($event.target).checked"><input aria-label="Branch label" [value]="branchLabel" (input)="branchLabel = $any($event.target).value"><input type="checkbox" aria-label="Use branch link" [checked]="branchLink" (change)="branchLink = $any($event.target).checked"><input type="checkbox" aria-label="Press branch" [checked]="branchPressed" (change)="branchPressed = $any($event.target).checked"><ng-template #badge><i id="branch-badge">{{branchLabel}}</i></ng-template><ng-template ui-branch id="primary-branch" [hnAttributes]="{ 'aria-pressed': branchPressed }" [href]="branchLink ? '/settings' : ''" [slots]="{ badge: badge }" [disabled]="branchDisabled" (click)="$event.preventDefault()"><b id="branch-label">{{branchLabel}}</b></ng-template><section ui-branch-holder></section><small component="ui-connected" id="native-css-probe">Native</small><ng-template ui-branch id="empty-branch">{{emptyLabel}}</ng-template><input aria-label="Empty label" [value]="emptyLabel" (input)="emptyLabel = $any($event.target).value"><input ui-native-date id="opaque-date"><div ui-lookup [name]="lookupName" [limit]="lookupLimit"></div><input type="number" aria-label="Optional limit" [value]="lookupLimit" (input)="lookupLimit = $any($event.target).value ? $any($event.target).valueAsNumber : undefined"><div ui-prepared-parent></div><ng-template ui-branch id="after-prepared" href="/after">After</ng-template><section ui-prepared [count]="preparedCount"></section><input type="number" aria-label="Prepared count" [value]="preparedCount" (input)="preparedCount = $any($event.target).valueAsNumber"><input aria-label="Lookup key" [value]="lookupName" (input)="lookupName = $any($event.target).value"><span ui-press (pressed)="pressValue = $any($event).detail" (click)="capturePress()"></span><output id="caller-value">{{branchPressed}}</output><output id="press-value">{{pressValue}}</output><output id="press-seen">{{pressSeen}}</output><button (click)="instant = true">Show first field</button>@if (instant) { <form ui-instant></form> }\` }) export class App { instant = false; lookupLimit: number | undefined = 3; emptyLabel = ""; preparedCount = 2; lookupName = "known"; branchPressed = false; pressValue = "Before"; pressSeen = ""; capturePress() { this.pressSeen = globalThis.document.querySelector("#press-value")?.textContent ?? ""; } branchLink = true; branchLabel = "Settings"; branchDisabled = true; saved = 0; saves = 0; receive(event: Event) { this.saved = (event as UiActionEvents["saved"]).detail; this.saves++; } pick = (detail: string): number => detail.length; }`;
  await writeFile(join(root, "src/app.ts"), app);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: "./src/html-next.angular.json", compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
    experimentalDecorators: true, allowArbitraryExtensions: true, baseUrl: root, rootDir: join(root, "src"), outDir: join(root, "src"), types: []
  }, angularCompilerOptions: { strictTemplates: true }, files: ["src/app.ts", "src/html-next.d.ts"] }));
  const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
  try { await run(process.execPath, [ngc, "-p", join(root, "tsconfig.json")], { cwd: root }); }
  catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
  return { root, app, ngc };
}

it("prepares Angular source-package metadata and local component types for the Angular compiler", async () => {
  const { root, app, ngc } = await fixture();
  const declarations = await readFile(join(root, "src/html-next.d.ts"), "utf8");
  assert.match(declarations, /Generated by HTML Next/);
  assert.match(await readFile(join(root, "src/html-next.angular.json"), "utf8"), /@example\/controls/);
  await writeFile(join(root, "src/app.ts"), app.replace("[text]=\"'Send'\"", "[text]=\"42\""));
  await assert.rejects(run(process.execPath, [ngc, "-p", join(root, "tsconfig.json")], { cwd: root }), error =>
    /not assignable to type 'string'/.test((error as { stderr?: string }).stderr ?? ""));
  await writeFile(join(root, "src/app.ts"), app.replace('[answer]="42"', '[answer]="true"'));
  await assert.rejects(run(process.execPath, [ngc, "-p", join(root, "tsconfig.json")], { cwd: root }), error =>
    /not assignable to type 'number/.test((error as { stderr?: string }).stderr ?? ""));
  await writeFile(join(root, "src/app.ts"), app.replace('item.toUpperCase()', 'item.toFixed()'));
  await assert.rejects(run(process.execPath, [ngc, "-p", join(root, "tsconfig.json")], { cwd: root }), error =>
    /does not exist on type 'string'/.test((error as { stderr?: string }).stderr ?? ""));
}, 60_000);

for (const [name, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
  it.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")(`hydrates Angular native hosts and collapsed identities in ${name}`, async () => {
    const { root } = await fixture();
    await writeFile(join(root, "src/server.ts"), `import { renderApplication, provideServerRendering } from "@angular/platform-server";
      import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser";
      import { App } from "./app.js";
      export const render = () => renderApplication(context => bootstrapApplication(App, { providers: [provideServerRendering(), provideClientHydration()] }, context),
        { document: '<html><head><base href="/"></head><body><app-root></app-root></body></html>', url: 'http://localhost/', allowedHosts: ['localhost'] });`);
    await writeFile(join(root, "src/client.ts"), `import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser"; import { App } from "./app.js";
      const afterPrepared = document.querySelector("#after-prepared"); const nestedPrepared = [...document.querySelectorAll("[ui-prepared-child] li")]; const prepared = document.querySelector("[ui-prepared] li"); const before = document.querySelector('button'); const branch = document.querySelector('#primary-branch'); const projected = document.querySelector('#branch-label'); const badge = document.querySelector('#branch-badge'); const markup = document.querySelector('[ui-markup] b'); const range = document.createRange(); range.selectNodeContents(markup!); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); bootstrapApplication(App, { providers: [provideClientHydration()] }).then(() => {
        document.body.dataset.afterPreparedRetained = String(afterPrepared === document.querySelector("#after-prepared")); document.body.dataset.nestedPreparedRetained = String(nestedPrepared.length === 4 && nestedPrepared.every((node, index) => node === document.querySelectorAll("[ui-prepared-child] li")[index])); document.body.dataset.preparedRetained = String(prepared === document.querySelector("[ui-prepared] li")); document.body.dataset.retained = String(before === document.querySelector('button')); document.body.dataset.branchRetained = String(branch === document.querySelector('#primary-branch')); document.body.dataset.projectedRetained = String(projected === document.querySelector('#branch-label')); document.body.dataset.badgeRetained = String(badge === document.querySelector('#branch-badge')); document.body.dataset.markupRetained = String(markup === document.querySelector('[ui-markup] b')); document.body.dataset.selectionRetained = window.getSelection()?.toString();
      });`);
    await writeFile(join(root, "index.html"), '<app-root></app-root><script type="module" src="/src/client.ts"></script>');
    let documentHTML: string | undefined;
    let reads = 0;
    const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target: "angular" }), {
      name: "angular-fixture", transformIndexHtml: { order: "pre", handler: html => documentHTML ?? html }, configureServer(server) { server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/fixture-sdk.js")) { response.setHeader("Content-Type", "application/javascript"); response.end("window.fixtureScript = (window.fixtureScript ?? 0) + 1;"); return; }
        if (!request.url?.startsWith("/api/name")) return next();
        reads++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ name: "Fetched" }));
      }); },
    }], server: { host: "127.0.0.1", port: 0 } });
    let browser: Awaited<ReturnType<typeof browserType.launch>> | undefined;
    try {
      browser = await browserType.launch();
      await server.listen();
      const module = await server.ssrLoadModule("/src/server.ts") as { render(): Promise<string> };
      const rendered = await module.render();
      const ownedMarker = /<span[^>]*class="owned-marker"[^>]*>/.exec(rendered)?.[0];
      assert.ok(ownedMarker, "nested component projects the styled native child");
      assert.match(ownedMarker, /data-slotted="ui-projection-styles"/, "SSR preserves the authoring component's style ownership");
      assert.match(rendered, /<title[^>]*>Count 0<\/title>/);
      assert.match(rendered, /rel="preload"[^>]*href="\/fixture-sdk.js"/);
      assert.equal(reads, 0, "data reads begin in the browser");
      assert.ok(/<!--[^>]*\|html-next-view:/.test(rendered), "native view identities reach the serialized DOM");
      assert.match(rendered, /2:0/);
      assert.match(rendered, /2:1/);
      assert.match(rendered, /4:3/, "child SSR preparation follows its asynchronously prepared parent input");
      const branch = /<a\b[^>]*\bui-branch=""[^>]*>/.exec(rendered)?.[0];
      assert.ok(branch, "structural directives render their native root during SSR");
      assert.doesNotMatch(branch, /\shref=/);
      assert.match(branch, /data-ui-branch-prop-href="\/settings"/);

      assert.match(rendered, /<button[^>]*ui-action[^>]*ui-button|<button[^>]*ui-button[^>]*ui-action/);
      assert.doesNotMatch(rendered, /<ui-action|<ui-button|data-component=/);
      documentHTML = rendered.replace("</body>", '<script type="module" src="/src/client.ts"></script></body>');
      const page = await browser.newPage(); const errors: string[] = [];
      let navigations = 0;
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/instant.js*", async route => { await new Promise(resolve => setTimeout(resolve, 200)); await route.continue(); });
      let startHydration: (() => void) | undefined;
      if (name === "Chromium") {
        const gate = new Promise<void>(resolve => { startHydration = resolve; });
        await page.route("**/src/client.ts", async route => { await gate; await route.continue(); });
        await page.goto(server.resolvedUrls!.local[0]!, { waitUntil: "commit" });
        await page.locator("#opaque-date").fill(""); await page.locator("#opaque-date").press("1");
        assert.equal(await page.locator("#opaque-date").evaluate(input => (input as HTMLInputElement).validity.badInput), true);
        await page.evaluate(() => { (window as any).opaqueDate = document.querySelector("#opaque-date"); });
        startHydration!();
      } else await page.goto(server.resolvedUrls!.local[0]!);
      await page.waitForFunction(() => document.body.dataset.retained === "true", undefined, { timeout: 10_000 }).catch(async error => assert.fail(`${String(error)}\n${JSON.stringify(errors)}\n${await page.locator("body").innerHTML()}`));
      if (name === "Chromium") assert.deepEqual(await page.locator("#opaque-date").evaluate(input => [input === (window as any).opaqueDate, (input as HTMLInputElement).validity.badInput]), [true, true]);
      await page.waitForFunction(() => document.querySelector("[ui-typed]")?.getAttribute("data-side-effect") === "kept");
      assert.equal(await page.locator("body").getAttribute("data-selection-retained"), "Safe");
      assert.equal(await page.locator("body").getAttribute("data-branch-retained"), "true");
      assert.equal(await page.locator("body").getAttribute("data-projected-retained"), "true");
      assert.equal(await page.locator("body").getAttribute("data-badge-retained"), "true");
      assert.equal(await page.locator(".owned-marker").getAttribute("data-slotted"), "ui-projection-styles");
      assert.equal(await page.locator(".owned-marker").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(11, 22, 33)", "projected content keeps its author's CSS after hydration");
      assert.equal(await page.locator("#empty-branch").textContent(), "0");
      await page.getByLabel("Empty label", { exact: true }).fill("Available");
      await page.waitForFunction(() => document.querySelector("#empty-branch")?.textContent === "Available0");
      await page.waitForFunction(() => (window as any).preparedConnected);
      assert.equal(await page.evaluate(() => (window as any).preparedLoads ?? 0), 0, "prepared rows are adopted without a second load");
      assert.equal(await page.locator("body").getAttribute("data-prepared-retained"), "true");
      assert.equal(await page.locator("body").getAttribute("data-nested-prepared-retained"), "true", "nested prepared rows hydrate in place");
      assert.equal(await page.locator("body").getAttribute("data-after-prepared-retained"), "true", "structural hydration follows anchor identity despite async creation order");
      assert.deepEqual(await page.locator("[ui-prepared-child] li").allTextContents(), ["4:00", "4:10", "4:20", "4:30"]);
      await page.getByLabel("Prepared count", { exact: true }).fill("3");
      await page.waitForFunction(() => document.querySelectorAll("[ui-prepared] li").length === 3);
      assert.deepEqual(await page.locator("[ui-prepared] li").allTextContents(), ["3:0", "3:1", "3:2"]);
      assert.equal(await page.locator("[ui-lookup]").getAttribute("data-caller-default"), "absent", "controller inputValue distinguishes a default from a caller value");
      assert.equal(await page.locator("[ui-lookup]").getAttribute("data-limit"), "3");
      await page.getByLabel("Optional limit", { exact: true }).fill("");
      await page.waitForFunction(() => !document.querySelector("[ui-lookup]")?.hasAttribute("data-limit"), undefined, { timeout: 2000 });
      assert.equal(await page.locator("[ui-lookup] span").count(), 2);
      await page.getByLabel("Lookup key", { exact: true }).fill("missing");
      await page.waitForFunction(() => document.querySelectorAll("[ui-lookup] span").length === 0, undefined, { timeout: 2000 });
      assert.equal(await page.locator("#primary-branch").getAttribute("aria-pressed"), "false");
      await page.getByLabel("Press branch").check();
      await page.waitForFunction(() => document.querySelector("#primary-branch")?.getAttribute("aria-pressed") === "true", undefined, { timeout: 2000 });
      await page.getByLabel("Press branch").uncheck();
      await page.waitForFunction(() => document.querySelector("#primary-branch")?.getAttribute("aria-pressed") === "false", undefined, { timeout: 2000 });
      const nested = page.locator("[ui-branch-holder] [ui-slot-bin] > aside > a[ui-branch]");
      assert.equal(await nested.textContent(), "Projected native child0");
      assert.equal(await nested.getAttribute("slot"), "badge");
      assert.equal(await nested.getAttribute("data-hn-owner"), "ui-branch-holder");
      await nested.click();
      assert.equal(await page.locator("[ui-branch-holder]").getAttribute("data-ref-tag"), "a", "a structural child ref exposes its rendered native root");
      await page.getByLabel("Branch label").fill("Updated");
      await page.waitForFunction(() => document.querySelector("#branch-label")?.textContent === "Updated");
      assert.equal(await page.locator("#branch-label").count(), 1);
      assert.equal(await page.locator("#branch-badge").textContent(), "Updated");

      assert.equal(await page.locator("button[ui-action]").textContent(), "Send0ActionPageLocal");
      await page.locator("button[ui-action]").click();
      await page.locator("button[ui-action]").press("ArrowRight");
      await page.waitForFunction(() => document.querySelector("#saved")?.textContent !== "0:0");
      assert.equal(await page.locator("#saved").textContent(), "1:1");
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "2");
      assert.equal(await page.locator("button[ui-action]").evaluate(element => getComputedStyle(element).color), "rgb(1, 2, 3)");
      assert.equal(await page.locator("button strong").evaluate(element => getComputedStyle(element).color), "rgb(4, 5, 6)");
      assert.equal(await page.locator("button[ui-action]").evaluate(element => getComputedStyle(element).fontStyle), "italic");
      for (const label of ["Native flags", "Root flags"]) {
        assert.equal(await page.getByLabel(label).isDisabled(), false);
        assert.equal(await page.getByLabel(label).isEditable(), true);
        assert.equal(await page.getByLabel(label).getAttribute("disabled"), null);
        assert.equal(await page.getByLabel(label).getAttribute("readonly"), null);
        assert.equal(await page.getByLabel(label).getAttribute("required"), null);
        assert.equal(await page.getByLabel(label).getAttribute("aria-expanded"), "false");
      }
      await page.getByLabel("Enabled").check();
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea")).every(control => control.disabled && control.readOnly && control.required && control.getAttribute("aria-expanded") === "true"));
      await page.getByLabel("Enabled").uncheck();
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea")).every(control => !control.disabled && !control.readOnly && !control.required && control.getAttribute("aria-expanded") === "false"));
      assert.equal(await page.getByLabel("Name").inputValue(), "Ada");
      assert.equal(await page.getByLabel("Enabled").isChecked(), false);
      assert.equal(await page.getByLabel("Choice").inputValue(), "b");
      await page.getByLabel("Name").fill("Grace");
      await page.waitForFunction(() => document.querySelector("form output")?.textContent === "Grace");
      await page.locator("form").evaluate(element => (element as HTMLFormElement).reset());
      assert.equal(await page.getByLabel("Name").inputValue(), "Default");
      assert.equal(await page.getByLabel("Enabled").isChecked(), true);
      assert.equal(await page.getByLabel("Choice").inputValue(), "a");
      assert.deepEqual(await page.locator("section[ui-rows] li").allTextContents(), ["Ada", "Bea"]);
      assert.deepEqual(await page.locator("app-root > ul li").allTextContents(), ["ADA0", "BEA1"]);
      assert.deepEqual(await page.locator("nav li").allTextContents(), ["AdaTeam0", "BeaTeam1"]);
      await page.locator("app-root > ul").dblclick();
      assert.deepEqual(await page.locator("app-root > ul li").allTextContents(), ["ADA0", "BEA1"]);
      assert.equal(await page.locator("[ui-selected] output").textContent(), "42");
      assert.equal(await page.locator("#primary-branch").getAttribute("href"), null);
      assert.equal(await page.locator("#primary-branch").getAttribute("data-ui-branch-prop-href"), "/settings");
      await page.getByLabel("Disable branch").uncheck();
      await page.waitForFunction(() => document.querySelector("#primary-branch")?.getAttribute("href") === "/settings");
      await page.getByLabel("Disable branch").check();
      await page.waitForFunction(() => document.querySelector("#primary-branch")?.getAttribute("href") === null);
      assert.equal(await page.locator("#primary-branch").getAttribute("aria-disabled"), "true");
      assert.equal(await page.locator("#primary-branch").getAttribute("data-ui-branch-prop-href"), "/settings");
      await page.getByLabel("Disable branch").uncheck();
      await page.waitForFunction(() => document.querySelector("#primary-branch")?.getAttribute("href") === "/settings");

      assert.equal(await page.locator("h2").textContent(), "People");
      assert.equal(await page.locator("section > strong").textContent(), "Ready");
      assert.equal(await page.locator("b.active").textContent(), "Visible");
      await page.waitForFunction(() => document.querySelector("[ui-connected] span")?.textContent === "Connected");
      for (const selector of ["[ui-connected]", "#native-css-probe"]) assert.equal(await page.locator(selector).evaluate(element => getComputedStyle(element).getPropertyValue("--mixed-root").trim()), "yes");
      await page.locator("[ui-connected]").click();
      await page.waitForFunction(() => document.querySelector("[ui-connected]")?.getAttribute("data-observed") === "1");
      await page.locator("[ui-connected]").evaluate(element => { (window as unknown as { detached: Element }).detached = element; element.remove(); });
      await page.waitForFunction(() => (window as unknown as { detached: HTMLElement }).detached.dataset.disconnected === "true");
      await page.evaluate(() => document.querySelector("app-root")!.append((window as unknown as { detached: Element }).detached));
      await page.waitForFunction(() => document.querySelector("[ui-connected]")?.getAttribute("data-activations") === "2");
      assert.equal(await page.locator("[ui-connected] output").textContent(), "1");
      assert.equal(await page.locator("[ui-connected] small").textContent(), "1");
      await page.waitForFunction(() => document.querySelector("[ui-feed] output")?.textContent === "Fetched");
      assert.equal(navigations, 1);
      assert.equal(reads, 1);
      assert.equal(await page.locator("body").getAttribute("data-markup-retained"), "true");
      assert.equal(await page.locator("[ui-markup] script").count(), 0);
      assert.equal(await page.evaluate(() => (window as unknown as { unsafeMarkup?: boolean }).unsafeMarkup), undefined);
      await page.waitForFunction(() => document.querySelector("[ui-ask] output")?.textContent === "3");
      await page.waitForFunction(() => document.querySelector("[ui-script] output")?.textContent === "1");
      assert.equal(await page.evaluate(() => (window as unknown as { fixtureScript: number }).fixtureScript), 1);
      await page.waitForFunction(() => document.title === "Count 1");
      await page.getByRole("button", { name: "Press", exact: true }).click();
      await page.waitForFunction(() => !!document.querySelector("#press-seen")?.textContent);
      assert.equal(await page.locator("#press-seen").textContent(), "Updated", "native click observes the DOM updated by the preceding controller press event");
      await page.locator("#primary-branch").dispatchEvent("click");
      await page.waitForFunction(() => document.querySelector("#primary-branch output")?.textContent === "1");
      await page.getByLabel("Use branch link").uncheck();
      await page.waitForFunction(() => document.querySelector("button#primary-branch output")?.textContent === "1");
      await page.getByLabel("Branch label").fill("Switched");
      await page.waitForFunction(() => document.querySelector("#branch-label")?.textContent === "Switched");
      assert.equal(await page.locator("#branch-badge").textContent(), "Switched");
      await page.getByLabel("Use branch link").check();
      await page.waitForFunction(() => document.querySelector("a#primary-branch output")?.textContent === "1");
      assert.equal(await page.locator("#branch-label").count(), 1);
      assert.equal(await page.locator("#branch-badge").count(), 1);
      await page.getByRole("button", { name: "Show first field", exact: true }).click();
      await page.getByLabel("First field", { exact: true }).fill("First input");
      await page.waitForFunction(() => document.querySelector("[ui-instant] output")?.textContent === "First input");
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  }, 60_000);
}


it("preserves authored TypeScript side-effect imports in Angular production bundles", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "src/entry.ts"), 'export { UiTyped } from "@example/controls";');
  const result = await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target: "angular" })],
    build: { outDir: "production", minify: false, lib: { entry: "src/entry.ts", formats: ["es"] }, rollupOptions: { external: [/^@angular\//] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => "output" in bundle ? bundle.output : []);
  const entry = outputs.find(chunk => chunk.type === "chunk" && chunk.isEntry);
  assert.ok(entry?.type === "chunk");
  // Import the actual production entry, whether its controller is bundled or split.
  await import("@angular/compiler");
  try {
    await import(pathToFileURL(join(root, "production", entry.fileName)).href);
    assert.equal(Reflect.get(globalThis, "angularSideEffect"), "kept");
  } finally { Reflect.deleteProperty(globalThis, "angularSideEffect"); }
}, 60_000);
