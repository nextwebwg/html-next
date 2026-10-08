import assert from "node:assert/strict";

import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, it, vi } from "vitest";

import { renderComponents } from "../src/server.js";
import { parseComponent } from "../src/source-parser.js";
import { cases, compiledFixtures, definitions } from "./hydration-fixtures.js";

interface Bundle {
  readonly factories: Readonly<Record<string, (options: object, html: undefined, root: Element) => Element>>;
  getComponentHost(element: Element): { state: Record<string, unknown>; refs: Record<string, unknown> } | undefined;
  inspectInstance(element: Element): unknown;
  registerComponentDefinitions(definitions: readonly unknown[]): void;
  lowerDocument(): number;
}

/** Every fixture compiled for hydration, beside the live runtime in one bundle. */
let code: string;
beforeAll(async () => {
  code = await compiledFixtures("esm", 'export { getComponentHost, inspectInstance, registerComponentDefinitions, lowerDocument } from "@nextwebwg/html-next/runtime";');
});

/** A fresh document holding `html` twice, and the bundle loaded against it. */
async function page(html: string, bundle = code): Promise<{ document: Document; runtime: Bundle }> {
  const { window } = new JSDOM(`<!doctype html><body><main id="compiled">${html}</main><main id="live">${html}</main></body>`);
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
    try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
  }
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n// ${Math.random()}`).toString("base64")}`) as Bundle;
  return { document: window.document, runtime };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Compiled rows are their element; live keeps item markers around each (owner decision 2a). */
const comparable = (html: string): string => html.replaceAll(/<!--html-next:item-(?:start|end)-->/g, "");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compiled hydration of Node output", () => {
  // A <template slot> written in the document needs the live delivery's parser; compiled consumers project their own.
  for (const fixture of cases.filter((candidate) => !candidate.html.includes("<template slot"))) {
    it(`adopts ${fixture.name} in place, as the live runtime does`, async () => {
      const rendered = await renderComponents(fixture.html, { definitions, state: { "#subject": fixture.state } });
      const { document, runtime } = await page(rendered.html);
      const compiled = document.querySelector("#compiled")!;
      const live = document.querySelector("#live")!;
      const root = compiled.querySelector("#subject")!;
      const originalNodes = Array.from(compiled.querySelectorAll("button, span, li, b, output, input, strong"));
      for (const box of [live, compiled]) {
        const input = box.querySelector("#subject");
        if (!(input instanceof window.HTMLInputElement)) continue;
        input.value = "edited before hydration";
        input.focus();
        input.setSelectionRange(2, 6);
      }

      // A component an earlier pass adopted is the one its parent then binds.
      const earlier = "earlierPass" in fixture ? fixture.earlierPass : undefined;
      if (earlier !== undefined) for (const nested of compiled.querySelectorAll(`[data-component~="${earlier}"]`)) runtime.factories[earlier]!({}, undefined, nested);
      const tag = root.getAttribute("data-component")!.split(/\s+/)[0]!;
      assert.equal(runtime.factories[tag]!({}, undefined, root), root, "the factory adopts the server root");
      runtime.registerComponentDefinitions(definitions);
      runtime.lowerDocument();
      await flush();

      const inspect = (box: Element): unknown[] => Array.from(box.querySelectorAll("[data-component]"), (element) => runtime.inspectInstance(element));
      assert.deepEqual(inspect(compiled), inspect(live));
      assert.ok(originalNodes.every((node) => compiled.contains(node)), "existing nodes stay in place");
      assert.equal(compiled.querySelector("[data-html-next-instance], [data-html-next-form-defaults]"), null, "hydration metadata is consumed");
      assert.equal(comparable(compiled.innerHTML), comparable(live.innerHTML));

      if (root instanceof window.HTMLInputElement) {
        assert.deepEqual({ value: root.value, defaultValue: root.defaultValue, focused: document.activeElement === root,
          selection: [root.selectionStart, root.selectionEnd] }, { value: "edited before hydration", defaultValue: "authored", focused: true, selection: [2, 6] });
        for (const input of [root, live.querySelector<HTMLInputElement>("#subject")!]) {
          input.value = "next";
          input.dispatchEvent(new window.Event("input", { bubbles: true }));
        }
        await flush();
        assert.equal(runtime.getComponentHost(root)!.state.text, "next");
      }

      const retained = compiled.querySelector("li");
      for (const box of [compiled, live]) box.querySelector<HTMLButtonElement>("button")?.click();
      await flush();
      const nested = compiled.querySelector<HTMLElement>('[data-component~="ssr-bound-button"]');
      if (nested !== null) {
        for (const box of [compiled, live]) box.querySelector<HTMLElement>('[data-component~="ssr-bound-button"]')!.click();
        await flush();
        assert.deepEqual({
          tag: nested.localName, count: nested.querySelector("span")!.textContent, expanded: nested.getAttribute("aria-expanded"),
          active: nested.classList.contains("active"), opacity: nested.style.opacity,
          refFollowsRoot: runtime.getComponentHost(root)!.refs.action === nested,
          projectionKept: originalNodes.filter((node) => node.localName === "strong").every((node) => nested.contains(node)),
        }, { tag: "a", count: "7", expanded: "true", active: true, opacity: "0.5", refFollowsRoot: true, projectionKept: true });
      }
      assert.deepEqual(inspect(compiled), inspect(live));
      assert.equal(comparable(compiled.innerHTML), comparable(live.innerHTML));
      assert.ok(retained === null || Array.from(compiled.querySelectorAll("li")).includes(retained), "a retained row keeps its node");
    });
  }

  it("keeps a closed slot's <template slot> lazy until the slot opens", async () => {
    const rendered = await renderComponents('<ssr-lazy-page id="subject"></ssr-lazy-page>', { definitions, state: { "#subject": { label: "server" } } });
    const { document, runtime } = await page(rendered.html);
    const root = document.querySelector("#compiled #subject")!;
    runtime.factories["ssr-lazy-page"]!({}, undefined, root);
    await flush();
    assert.equal(root.querySelector("b"), null);
    assert.equal(root.querySelectorAll("template").length, 0, "the carrier is consumed");
    root.querySelector("button")!.click();
    await flush();
    assert.equal(root.querySelector("b")?.textContent, "server", "the template renders with the consumer's hydrated state");
  });

  it("runs a controller once, on its adopted root, after the whole tree is adopted", async () => {
    const controlled = { ...parseComponent(`<template component="ssr-controlled" controller="./controlled.js"><defs>
      <state name="count" type="number" value="0"></state></defs>
      <section><button type="button" $ref="increment">Add</button><output $value="$count"></output><ssr-classed></ssr-classed></section></template>`),
    controller: "./controlled.js" };
    const nested = definitions.find((definition) => definition.contract.tag === "ssr-classed")!;
    const bundle = await compiledFixtures("esm", "", [controlled, nested], { "./controlled.js": `export default function (host) {
      globalThis.controllerCalls.push({ root: host.root, increment: host.refs.increment, count: host.state.count });
      const click = () => { host.state.count += 1; };
      host.refs.increment.addEventListener("click", click);
      return () => host.refs.increment.removeEventListener("click", click);
    }` });
    const rendered = await renderComponents('<ssr-controlled id="subject"></ssr-controlled>',
      { definitions: [controlled, nested], state: { "#subject": { count: 3 } } });
    const { document, runtime } = await page(rendered.html, bundle);
    const calls: { root: Element; increment: Element; count: number }[] = [];
    vi.stubGlobal("controllerCalls", calls);
    const root = document.querySelector("#compiled #subject")!;
    const [button, output] = [root.querySelector("button")!, root.querySelector("output")!];
    runtime.factories["ssr-controlled"]!({}, undefined, root);
    await flush();
    assert.deepEqual(calls.map(({ root: element, increment, count }) => ({ root: element === root, increment: increment === button, count })),
      [{ root: true, increment: true, count: 3 }]);
    button.click();
    await flush();
    assert.equal(output.textContent, "4");
    assert.equal(root.querySelector("output"), output);
    assert.equal(root.querySelector('[data-component="ssr-classed"] output')?.textContent, "0", "the nested root renders its own state");
  });

  it("creates a block afresh where the server markup does not match its template", async () => {
    const rendered = await renderComponents('<ssr-list id="subject"></ssr-list>', { definitions, state: { "#subject": { rows: ["Ada", "Bea"] } } });
    const { document, runtime } = await page(rendered.html);
    const root = document.querySelector("#compiled #subject")!;
    // A tool rewrote the first row's markup before startup.
    root.querySelector("li")!.replaceWith(document.createElement("p"));
    const second = root.querySelectorAll("li")[0]!;
    runtime.factories["ssr-list"]!({}, undefined, root);
    await flush();
    assert.deepEqual(Array.from(root.querySelectorAll("li"), (row) => row.textContent), ["Ada", "Bea"]);
    assert.equal(root.querySelector("p"), null);
    assert.equal(root.querySelectorAll("li")[1], second, "a matching row is still adopted");
  });
});
