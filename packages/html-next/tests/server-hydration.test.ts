import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

import { renderComponents } from "../src/server.js";
import { cases, compiledFixtures, definitions } from "./hydration-fixtures.js";

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("Node render to browser hydration", () => {
  let directory: string;
  let bundle: string;
  let compiledBundle: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-server-hydration-"));
    bundle = join(directory, "runtime.js");
    compiledBundle = join(directory, "compiled.js");
    await build({ entryPoints: [new URL("../src/live.ts", import.meta.url).pathname], outfile: bundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    await writeFile(compiledBundle, await compiledFixtures("iife"));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    // The server copy hydrates live, or through compiled modules; the client copy is always live's.
    // A <template slot> written in the document needs the live delivery's parser.
    for (const [mode, fixture] of [...cases.map((fixture) => ["live", fixture] as const),
      ...cases.filter((fixture) => !fixture.html.includes("<template slot")).map((fixture) => ["compiled", fixture] as const)]) {
      it(`${engine} restores ${fixture.name} from actual Node output${mode === "compiled" ? " through compiled modules" : ""}`, async () => {
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
          if (mode === "compiled") await page.addScriptTag({ path: compiledBundle });
          const result = await page.evaluate(async ({ definitionJSON, stateJSON, earlierPass, compiled }) => {
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
            if (compiled) {
              // Compiled modules adopt the server copy, an earlier pass's nested roots first; live lowers the client copy.
              const factories = (window as unknown as { HtmlCompiled: { factories: Record<string, (options: object, html: undefined, root: Element) => Element> } })
                .HtmlCompiled.factories;
              const subject = document.querySelector("#server #subject")!;
              if (earlierPass !== undefined) for (const nested of subject.querySelectorAll(`[data-component~="${earlierPass}"]`)) factories[earlierPass]!({}, undefined, nested);
              factories[subject.getAttribute("data-component")!.split(" ")[0]!]!({}, undefined, subject);
            }
            // A child adopted before its parent is registered has already committed when the parent binds it.
            const first = compiled ? [] : definitions.filter((definition) => (definition as { contract: { tag: string } }).contract.tag === earlierPass);
            if (first.length > 0) {
              runtime.registerComponentDefinitions(first);
              runtime.lowerDocument();
            }
            runtime.registerComponentDefinitions(definitions.filter((definition) => !first.includes(definition)));
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
            // Compiled rows are their element; live keeps item markers around each (owner decision 2a).
            const markup = (box: Element): string => box.innerHTML.replaceAll(/<!--html-next:item-(?:start|end)-->/g, "");
            const after = { server: inspect(server), client: inspect(client), html: [markup(server), markup(client)] };
            const rowKept = retained === null || Array.from(server.querySelectorAll("li")).includes(retained);
            if (root instanceof HTMLInputElement) {
              root.value = "next";
              root.dispatchEvent(new Event("input", { bubbles: true }));
            }
            await Promise.resolve();
            return { initial, identity, metadataRemoved, control, after, rowKept, parentBindings,
              editedState: root instanceof HTMLInputElement ? runtime.getComponentHost(root)?.state.text : null };
          }, { definitionJSON: JSON.stringify(definitions), stateJSON: JSON.stringify(fixture.state),
            earlierPass: "earlierPass" in fixture ? fixture.earlierPass : undefined, compiled: mode === "compiled" });
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

    it(`${engine} keeps a closed slot's <template slot> lazy from Node output through hydration`, async () => {
      const rendered = await renderComponents('<ssr-lazy-page id="subject"></ssr-lazy-page>',
        { definitions, state: { "#subject": { label: "server" } } });
      // The closed slot's template is serialized as it was, in the carrier: nothing rendered, nothing to fetch.
      assert.ok(rendered.html.includes('<?carrier?><template><template slot="details"></template></template>'), rendered.html);
      assert.doesNotMatch(rendered.html, /lazy\.png|<b>/);
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const requests: string[] = [];
        await page.route("https://assets.example/**", async (route) => {
          requests.push(new URL(route.request().url()).pathname);
          await route.fulfill({ status: 200, contentType: "image/png", body: "" });
        });
        await page.setContent(`<main>${rendered.html}</main>`);
        await page.addScriptTag({ path: bundle });
        const read = (): Promise<unknown> => page.evaluate(() => {
          const runtime = (window as unknown as { HtmlRuntime: {
            getComponentHost(element: Element): { slots: Record<string, readonly Element[]> } | undefined;
          } }).HtmlRuntime;
          const toggle = runtime.getComponentHost(document.querySelector('[data-component~="ssr-lazy-toggle"]')!)!;
          return { detail: document.querySelector("b")?.textContent ?? null, img: document.querySelectorAll("img").length,
            templates: document.querySelectorAll("main template").length, details: toggle.slots.details!.map((element) => element.localName) };
        });
        await page.evaluate((definitionJSON) => {
          const runtime = (window as unknown as { HtmlRuntime: {
            registerComponentDefinitions(definitions: unknown[]): void; lowerDocument(): number;
          } }).HtmlRuntime;
          runtime.registerComponentDefinitions(JSON.parse(definitionJSON) as unknown[]);
          runtime.lowerDocument();
        }, JSON.stringify(definitions));
        assert.deepEqual(await read(), { detail: null, img: 0, templates: 0, details: [] });
        const lazy = page.waitForRequest("https://assets.example/lazy.png");
        await page.click("button");
        await page.waitForSelector("b");
        await lazy;
        // Opening renders the template with the consumer's hydrated state.
        assert.deepEqual(await read(), { detail: "server", img: 1, templates: 0, details: ["img", "b"] });
        assert.deepEqual(requests, ["/lazy.png"]);
      } finally { await browser.close(); }
    });
  }
});
