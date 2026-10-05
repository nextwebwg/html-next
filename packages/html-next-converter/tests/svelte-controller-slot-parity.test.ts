import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { sveltePlugin } from "./helpers/svelte.js";

const receiver = `<template component="x-slot-host" controller="./slots.js"><defs>
  <state name="item" value="Ada"></state><handler name="rename"><set name="item" value="Grace"></set></handler>
</defs><section><button on:click="rename">Rename</button><slot name="row" from:item="item"></slot><slot name="shown"></slot><slot></slot></section><style>:host { display: block; width: 240px; font: 16px/24px Arial, sans-serif; }</style></template>`;
const owner = `<link rel="component" href="./receiver.html"><template component="x-slot-owner"><defs>
  <state name="label" value="Ready"></state><handler name="change"><set name="label" value="Updated"></set></handler><handler name="clear-null"><set name="label" expr:value="null"></set></handler><handler name="clear-false"><set name="label" expr:value="false"></set></handler>
</defs><main><button on:click="change">Change content</button><button data-clear-null on:click="clear-null">Clear to null</button><button data-clear-false on:click="clear-false">Clear to false</button>
  <x-slot-host id="case" from:constructor="label" from:__proto__="label"><template slot="row"><p from:data-name="item" $value="item"></p></template>
    <span slot="unused" data-original="unused" $value="label"></span><span data-original="default" $value="label"></span><button slot="" data-default-button $value="label"></button>
    <x-detached-projection slot="nested"></x-detached-projection>
    <button slot="shown" $value="label"></button>
  </x-slot-host></main></template><template component="x-detached-projection"><aside>Nested projection</aside></template>`;
const controller = `function connect(host) {
  window.slotHost = host;
  const trace = window.slotTrace ??= { connects: 0, disconnects: 0, clicks: 0 };
  trace.connects++;
  window.slotGroups = { default: host.slots.default.map(node => node.tagName),
    empty: host.slots[''].map(node => node.tagName), hasDefault: 'default' in host.slots, hasEmpty: '' in host.slots };
  const buttons = [host.slots.shown[0], host.slots[''].find(node => node.hasAttribute('data-default-button'))];
  const click = () => { trace.clicks++; host.state.item = 'Clicked'; };
  for (const button of buttons) button.addEventListener('click', click);
  host.root.setAttribute('data-controller-ready', '');
  return () => { for (const button of buttons) button.removeEventListener('click', click); trace.disconnects++; };
}
export default function initialize(host) { host.on("connect", () => connect(host)); }
`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.evaluate(() => ({
      text: document.querySelector('#case')?.textContent,
      attributes: ['constructor', '__proto__'].map(name => document.querySelector('#case')?.getAttribute(name)),
      trace: { ...(window as unknown as { slotTrace: Record<string, number> }).slotTrace },
      groups: (window as unknown as { slotGroups: unknown }).slotGroups,
    })),
    pixels: await page.locator('#case').screenshot({ animations: 'disabled' }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte controller projected content behavior", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-slot-handles-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/receiver.html"), receiver);
    await writeFile(join(directory, "components/owner.html"), owner);
    await writeFile(join(directory, "components/slots.js"), controller);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["components/owner.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter(artifact => artifact.kind === 'style')
        .map(artifact => readFile(join(outDirectory, artifact.path), 'utf8')))).join('\n');
      const artifact = manifest.components.find((entry) => entry.tag === "x-slot-owner")!.artifact;
      await writeFile(join(outDirectory, "App.svelte"), `<script>import Owner from './${artifact}';</script><Owner />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate, unmount } from 'svelte'; import App from './App.svelte';
        const target = document.querySelector('#mount')!;
        const instance = target.hasChildNodes() ? hydrate(App, { target }) : mount(App, { target });
        (window as any).disposeSlots = () => unmount(instance);`);
      const bundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], plugins: [sveltePlugin("client")] });
      const server = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(server, `import { render } from 'svelte/server'; import App from './App.svelte'; export const html = render(App).body;`);
      await build({ entryPoints: [server], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      outputs.set(mode, { bundle, markup, css });
    }
  });
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });
  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} matches projected clicks, updates and connect/disconnect on mount and hydration`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          for (const hydrate of [false, true]) {
            const native = await browser.newPage();
            const converted = await browser.newPage();
            try {
              for (const page of [native, converted]) {
                await page.route("https://app.example/**", (route) => {
                  const path = new URL(route.request().url()).pathname;
                  return route.fulfill({ contentType: path.endsWith("slots.js") ? "text/javascript" : "text/html",
                    body: path.endsWith("slots.js") ? controller : path.endsWith("receiver.html") ? receiver : path.endsWith("owner.html") ? owner : page === native
                      ? `<link rel="component" href="/components/owner.html"><div id="mount"><x-slot-owner></x-slot-owner></div>`
                      : `<style>${outputs.get(mode)!.css}</style><div id="mount">${hydrate ? outputs.get(mode)!.markup : ""}</div>` });
                });
                await page.goto("https://app.example/");
              }
              await native.addScriptTag({ path: liveBundle });
              await native.evaluate(() => (window as unknown as { HtmlRuntime: { startBrowserComponents(): void } }).HtmlRuntime.startBrowserComponents());
              await converted.addScriptTag({ path: outputs.get(mode)!.bundle });
              await Promise.all([native, converted].map((page) => page.waitForFunction(() => "slotHost" in window, undefined, { timeout: 5_000 })));
              await Promise.all([native, converted].map(page => page.locator('#case[data-controller-ready]').waitFor({ timeout: 5_000 })));
              const compare = async () => {
                const [expected, actual] = await Promise.all([snapshot(native), snapshot(converted)]);
                assert.deepEqual(actual.behavior, expected.behavior);
                await assertPixelsEqual(converted, actual.pixels, expected.pixels, 'Svelte projected controller pixels differ', native);
              };
              await compare();
              await Promise.all([native, converted].map(page => page.locator('#case > button').first().click()));
              await Promise.all([native, converted].map(page => page.waitForFunction(() => document.querySelector('#case p')?.textContent === 'Grace')));
              await compare();
              await Promise.all([native, converted].map(page => page.locator('#mount main > button').first().click()));
              await Promise.all([native, converted].map(page => page.waitForFunction(() => document.querySelector('#case [slot="shown"]')?.textContent === 'Updated')));
              await compare();
              await Promise.all([native, converted].map(page => page.locator('#case [data-default-button]').click()));
              await Promise.all([native, converted].map(page => page.locator('#case [slot="shown"]').click()));
              await Promise.all([native, converted].map(page => page.waitForFunction(() => document.querySelector('#case p')?.textContent === 'Clicked')));
              await compare();
              await Promise.all([native, converted].map(page => page.evaluate(() => {
                const globals = window as unknown as { detachedSlotsRoot: Element };
                globals.detachedSlotsRoot = document.querySelector('#case')!;
                globals.detachedSlotsRoot.remove();
              })));
              await Promise.all([native, converted].map(page => page.waitForFunction(() =>
                (window as unknown as { slotTrace: Record<string, number> }).slotTrace.disconnects === 1)));
              for (const page of [native, converted]) {
                const trace = await page.evaluate(() => {
                  const globals = window as unknown as { detachedSlotsRoot: Element; slotTrace: Record<string, number> };
                  globals.detachedSlotsRoot.querySelector<HTMLButtonElement>('[slot="shown"]')!.click();
                  return { ...globals.slotTrace };
                });
                assert.deepEqual(trace, { connects: 1, disconnects: 1, clicks: 2 }, 'disconnect removes controller listeners');
              }
              await Promise.all([native, converted].map(page => page.evaluate(() => {
                document.querySelector('#mount main')!.append((window as unknown as { detachedSlotsRoot: Element }).detachedSlotsRoot);
              })));
              await Promise.all([native, converted].map(page => page.waitForFunction(() =>
                (window as unknown as { slotTrace: Record<string, number> }).slotTrace.connects === 2)));
              await Promise.all([native, converted].map(page => page.locator('#case [slot="shown"]').click()));
              await compare();
              for (const page of [native, converted]) assert.deepEqual(await page.evaluate(() =>
                ({ ...(window as unknown as { slotTrace: Record<string, number> }).slotTrace })),
              { connects: 2, disconnects: 1, clicks: 3 }, 'reconnect installs exactly one controller listener');
              for (const selector of ['[data-clear-null]', '[data-clear-false]']) {
                await Promise.all([native, converted].map(page => page.locator(selector).click()));
                await compare();
              }
              await Promise.all([native, converted].map(page => page.locator('#mount main > button').first().click()));
              await compare();
              await Promise.all([
                native.evaluate(() => document.querySelector('#case')!.remove()),
                converted.evaluate(() => (window as unknown as { disposeSlots(): Promise<void> }).disposeSlots()),
              ]);
              await Promise.all([native, converted].map(page => page.waitForFunction(() =>
                (window as unknown as { slotTrace: Record<string, number> }).slotTrace.disconnects === 2)));

            } finally { await native.close(); await converted.close(); }
          }
        } finally { await browser.close(); }
      });
    }
  }
});
