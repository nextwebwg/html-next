import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

import { renderComponents } from "../src/server.js";
import { parseComponent } from "../src/source-parser.js";

import { formattingSource } from "./formatting-fixture.js";

const definitions = [
  formattingSource,
  `<template component="ssr-inline"><defs>
    <state name="count" type="number" value="0"></state>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
    </defs><section><button type="button" on:click="increment">Next</button><p>Total: {$count} due today <b>Kept</b>!</p></section></template>`,
  `<template component="ssr-counter"><defs>
    <prop name="label" type="string" default="Visits">Label.</prop>
    <state name="count" type="number" value="0"></state>
    <state name="open" type="boolean" value="false"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set><set name="open" expr:value="true"></set></handler>
    </defs><section from:data-label="label"><button type="button" on:click="increment"><span $value="count"></span></button>
    <header><slot name="title">Untitled</slot></header><p>Hello <slot></slot>!</p>
    <aside $if="open"><slot name="extra">Fallback</slot></aside></section></template>`,
  `<template component="ssr-list"><defs>
    <state name="rows" type="list(string)" value="['Ada']"></state>
    <handler name="change"><set name="rows" expr:value="['Bea', 'Ada', 'Cy']"></set></handler>
    </defs><section><button type="button" on:click="change">Change</button>
    <ul><li $each="row of rows" $key="row"><b $value="row"></b></li></ul></section></template>`,
  `<template component="ssr-reader"><defs><context name="current" from="ssr-provider"></context></defs>
    <output $value="current"></output></template>`,
  `<template component="ssr-bound-button"><defs><prop name="count" type="number" default="0">Count</prop></defs>
    <template $match><button $when="count < 6" type="button"><slot></slot><span $value="count"></span></button>
    <a $else href="#kept"><slot></slot><span $value="count"></span></a></template></template>`,
  `<template component="ssr-bound-parent"><defs><state name="count" type="number" value="0"></state>
    <handler name="increment"><set name="count" expr:value="count + 1"></set></handler></defs>
    <section><ssr-bound-button $ref="action" from:count="count" from:aria-expanded="count > 4"
    class:active="count > 4" style:opacity="count > 4 ? '0.5' : '1'" on:click="increment"><strong>Next</strong></ssr-bound-button></section></template>`,
  `<template component="ssr-provider"><defs><state name="current" type="number" value="1"></state>
    <handler name="increment"><set name="current" expr:value="current + 1"></set></handler></defs>
    <section><button type="button" on:click="increment">Next</button><ssr-reader></ssr-reader><slot></slot></section></template>`,
  `<template component="ssr-control"><defs><state name="text" type="string" value="'initial'"></state></defs>
    <input bind:value="text" value="authored"></template>`,
  `<template component="ssr-delegate"><ssr-counter><slot></slot></ssr-counter></template>`,
  `<template component="ssr-props"><defs>
    <prop name="items" type="list(string)" default="[]">Items.</prop>
    <prop name="amount" type="number" default="2">Amount.</prop>
    <prop name="enabled" type="boolean" default="false">Enabled.</prop>
    </defs><output from:data-items="items" $value="amount"></output></template>`,
  `<template component="ssr-alias"><defs>
    <state name="first" type="unknown" value="{ count: 1 }"></state>
    <state name="second" type="unknown" value="first"></state>
    <handler name="increment"><set name="first.count" expr:value="first.count + 1"></set></handler>
    </defs><section><button type="button" on:click="increment">Next</button><output $value="second.count"></output></section></template>`,
  `<template component="ssr-match"><defs><state name="open" type="boolean" value="false"></state>
    <handler name="toggle"><set name="open" expr:value="not open"></set></handler></defs>
    <template $match><article $when="open"><button type="button" on:click="toggle">Close</button><slot></slot></article>
    <div $else><button type="button" on:click="toggle">Open</button><slot></slot></div></template></template>`,
  `<template component="ssr-table"><table><tbody><tr><td>Cell <slot></slot> end</td></tr></tbody></table></template>`,
  `<template component="ssr-scoped"><defs>
    <state name="rows" type="list(string)" value="['Ada']"></state>
    <handler name="change"><set name="rows" expr:value="['Bea', 'Ada', 'Cy']"></set></handler>
    </defs><section><button type="button" on:click="change">Change</button><ul>
    <slot $each="row of rows" $key="row" name="row" from:item="row"><li $value="row"></li></slot>
    </ul></section></template>`,
].map((source) => parseComponent(source));

const cases = [
  { name: "Intl text expressions and inferred declared types", html: '<x-formatting id="subject"></x-formatting>', state: {} },
  { name: "braced inline expressions with adjacent text and elements", html: '<ssr-inline id="subject"></ssr-inline>', state: { count: 7 } },
  { name: "changed state, implicit props, adjacent text and unrendered slots", html: '<ssr-counter id="subject"><b slot="title">T</b>world<i slot="extra">Hidden</i></ssr-counter>', state: { count: 7 } },
  { name: "keyed lists and retained row identity", html: '<ssr-list id="subject"></ssr-list>', state: { rows: ["Ada", "Bea"] } },
  { name: "nested components and shared state", html: '<ssr-provider id="subject"><strong>Projected</strong></ssr-provider>', state: { current: 5 } },
  { name: "parent bindings and events on nested native roots", html: '<ssr-bound-parent id="subject"></ssr-bound-parent>', state: { count: 5 } },
  { name: "native form controls and edits before hydration", html: '<ssr-control id="subject"></ssr-control>', state: { text: "server" } },
  { name: "delegated roots and slot passthrough", html: '<ssr-delegate id="subject">Delegated</ssr-delegate>', state: {} },
  { name: "structured, boolean and rejected prop inputs", html: '<ssr-props id="subject" enabled items="[&quot;&lt;/script&gt;&amp;&quot;]" amount="invalid"></ssr-props>', state: {} },
  { name: "shared object state after nested writes", html: '<ssr-alias id="subject"></ssr-alias>', state: {} },
  { name: "state-selected native roots", html: '<ssr-match id="subject">Content</ssr-match>', state: { open: true } },
  { name: "slot ranges inside tables", html: '<ssr-table id="subject">Projected</ssr-table>', state: {} },
  { name: "scoped slots and keyed projection", html: '<ssr-scoped id="subject"><template slot="row"><li><b $value="item"></b></li></template></ssr-scoped>', state: { rows: ["Ada", "Bea"] } },
] as const;

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("Node render to browser hydration", () => {
  let directory: string;
  let bundle: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-server-hydration-"));
    bundle = join(directory, "runtime.js");
    await build({ entryPoints: [new URL("../src/live.ts", import.meta.url).pathname], outfile: bundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const fixture of cases) {
      it(`${engine} restores ${fixture.name} from actual Node output`, async () => {
        const rendered = await renderComponents(fixture.html, { definitions, state: { "#subject": fixture.state } });
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.setContent(`<main id="server">${rendered.html}</main><main id="client">${fixture.html}</main>`);
          await page.evaluate(() => {
            const box = document.querySelector("#server")!;
            const root = box.querySelector("#subject")!;
            Object.assign(window, { originalRoot: root, originalNodes: Array.from(box.querySelectorAll("button, span, li, b, output, input, strong")) });
            if (root instanceof HTMLInputElement) {
              root.value = "edited before hydration";
              root.focus();
              root.setSelectionRange(2, 6);
            }
          });
          await page.addScriptTag({ path: bundle });
          const result = await page.evaluate(async ({ definitionJSON, stateJSON }) => {
            const definitions = JSON.parse(definitionJSON) as unknown[];
            const state = JSON.parse(stateJSON) as Record<string, unknown>;
            const context = window as unknown as {
              HtmlRuntime: {
                registerComponentDefinitions(definitions: unknown[]): void;
                lowerDocument(): number;
                inspectInstance(element: Element): unknown;
                getComponentHost(element: Element): { state: Record<string, unknown>; refs: Record<string, Element> } | undefined;
              };
              originalRoot: Element;
              originalNodes: Element[];
            };
            const runtime = context.HtmlRuntime;
            runtime.registerComponentDefinitions(definitions);
            runtime.lowerDocument();
            const server = document.querySelector("#server")!;
            const client = document.querySelector("#client")!;
            const root = server.querySelector("#subject")!;
            const clientRoot = client.querySelector("#subject")!;
            const host = runtime.getComponentHost(clientRoot)!;
            for (const [name, value] of Object.entries(state)) host.state[name] = value;
            await new Promise((resolve) => setTimeout(resolve, 0));
            const inspect = (box: Element) => Array.from(box.querySelectorAll("[data-component]"), (element) => runtime.inspectInstance(element));
            const initial = { server: inspect(server), client: inspect(client) };
            const identity = root === context.originalRoot && context.originalNodes.every((node) => server.contains(node));
            const metadataRemoved = server.querySelector("[data-html-next-instance], [data-html-next-form-defaults]") === null;
            const control = root instanceof HTMLInputElement ? {
              value: root.value, defaultValue: root.defaultValue, focused: document.activeElement === root,
              selection: [root.selectionStart, root.selectionEnd],
            } : null;
            const retained = server.querySelector("li");
            server.querySelector<HTMLButtonElement>("button")?.click();
            client.querySelector<HTMLButtonElement>("button")?.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const nested = server.querySelector<HTMLElement>('[data-component~="ssr-bound-button"]');
            let parentBindings = null;
            if (nested !== null) {
              nested.click();
              await new Promise((resolve) => setTimeout(resolve, 0));
              client.querySelector<HTMLElement>('[data-component~="ssr-bound-button"]')!.click();
              await new Promise((resolve) => setTimeout(resolve, 0));
              parentBindings = {
                tag: nested.localName, count: nested.querySelector("span")!.textContent,
                expanded: nested.getAttribute("aria-expanded"), active: nested.classList.contains("active"),
                opacity: nested.style.opacity, refFollowsRoot: runtime.getComponentHost(root)!.refs.action === nested,
                projectionKept: context.originalNodes.filter(node => node.localName === "strong").every(node => nested.contains(node)),
                noNativeProp: !nested.hasAttribute("count"),
              };
            }
            const after = { server: inspect(server), client: inspect(client), html: [server.innerHTML, client.innerHTML] };
            const rowKept = retained === null || Array.from(server.querySelectorAll("li")).includes(retained);
            if (root instanceof HTMLInputElement) {
              root.value = "next";
              root.dispatchEvent(new Event("input", { bubbles: true }));
            }
            await Promise.resolve();
            return { initial, identity, metadataRemoved, control, after, rowKept, parentBindings,
              editedState: root instanceof HTMLInputElement ? runtime.getComponentHost(root)?.state.text : null };
          }, { definitionJSON: JSON.stringify(definitions), stateJSON: JSON.stringify(fixture.state) });
          assert.deepEqual(result.initial.server, result.initial.client);
          assert.equal(result.identity, true, "hydrate existing nodes in place");
          assert.equal(result.metadataRemoved, true);
          assert.deepEqual(result.after.server, result.after.client);
          assert.deepEqual(result.after.html[0], result.after.html[1]);
          assert.equal(result.rowKept, true);
          if (fixture.name.startsWith("parent bindings")) {
            assert.deepEqual(result.parentBindings, { tag: "a", count: "7", expanded: "true", active: true,
              opacity: "0.5", refFollowsRoot: true, projectionKept: true, noNativeProp: true });
          }
          if (fixture.name.includes("controls")) {
            assert.deepEqual(result.control, { value: "edited before hydration", defaultValue: "authored", focused: true, selection: [2, 6] });
            assert.equal(result.editedState, "next");
          }
        } finally { await browser.close(); }
      });
    }
  }
});
