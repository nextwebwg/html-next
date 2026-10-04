import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { parseComponent } from "../src/source-parser.js";


const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const fixtureUrl = new URL("./runtime.html", import.meta.url);
const runtimeUrl = new URL("../src/live.ts", import.meta.url);
const generatedRuntimeUrl = new URL("../src/generated-runtime.ts", import.meta.url);
/** The general runtime on its own: what a build-time graph ships, with no component parser. */
const runtimeOnlyUrl = new URL("../src/runtime.ts", import.meta.url);

describe.skipIf(!enabled)("browser runtime", () => {
  let bundlePath = "";
  let generatedBundlePath = "";
  let runtimeOnlyBundlePath = "";
  let temporaryDirectory = "";
  let source = "";

  beforeAll(async () => {
    source = await readFile(fixtureUrl, "utf8");
    const runtimeSource = await readFile(runtimeUrl, "utf8");
    assert.doesNotMatch(runtimeSource, /\beval\s*\(|new\s+Function\s*\(|customElements\.define\s*\(/);

    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-runtime-"));
    bundlePath = join(temporaryDirectory, "runtime.js");
    generatedBundlePath = join(temporaryDirectory, "generated-runtime.js");
    runtimeOnlyBundlePath = join(temporaryDirectory, "runtime-only.js");
    await build({
      entryPoints: [runtimeOnlyUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "BareRuntime",
      outfile: runtimeOnlyBundlePath,
      platform: "browser",
      target: ["es2022"],
    });
    await build({
      entryPoints: [runtimeUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlRuntime",
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
    await build({
      entryPoints: [generatedRuntimeUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlGeneratedRuntime",
      outfile: generatedBundlePath,
      platform: "browser",
      target: ["es2022"],
    });
  });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} updates braced inline expressions without replacing siblings or retained keyed rows`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(String.raw`<template component="x-inline"><defs>
          <state name="rows" type="list(object({ id: number, name: string }))" value="[{ id: 1, name: 'Ada' }, { id: 2, name: 'Bea' }]"></state>
          <state name="Name" type="string" value="Upper"></state><state name="name" type="string" value="lower"></state>
          </defs><section><p>Hello {$rows.0.name}! <b>Kept</b> $literal costs $1.15; {$Name}/{$name}.</p>
          <table><tbody><tr $each="r of $rows" $key="$r.id"><td>{$r.name}</td></tr></tbody></table></section></template>
          <x-inline id="case"></x-inline>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void; getComponentHost(element: Element): { state: Record<string, unknown> };
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#case")!;
          const p = root.querySelector("p")!;
          const bold = p.querySelector("b")!;
          const initialText = p.textContent;
          const firstRow = root.querySelector("tr")!;
          const text = firstRow.querySelector("td")!.firstChild;
          const host = runtime.getComponentHost(root);
          host.state.rows = [{ id: 2, name: "Bea" }, { id: 1, name: "<i>Lin</i>" }];
          host.state.Name = "Changed";
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initialText, afterText: p.textContent, boldKept: p.querySelector("b") === bold,
            rowKept: root.querySelectorAll("tr")[1] === firstRow, textKept: firstRow.querySelector("td")!.firstChild === text,
            rows: Array.from(root.querySelectorAll("td"), (td) => td.textContent), markup: root.querySelector("i") !== null };
        });
        assert.deepEqual(actual, { initialText: "Hello Ada! Kept $literal costs $1.15; Upper/lower.",
          afterText: "Hello Bea! Kept $literal costs $1.15; Changed/lower.", boldKept: true, rowKept: true,
          textKept: true, rows: ["Bea", "<i>Lin</i>"], markup: false });
      } finally { await browser.close(); }
    });
    it(`${engine} keeps a typed binding's last accepted value through invalid updates`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-reading-default"><defs>
          <prop name="amount" type="number" default="5">Reading.</prop>
        </defs><output from:data-amount="amount"></output></template>
        <template component="x-reading-empty"><defs>
          <prop name="amount" type="number">Reading.</prop>
        </defs><output from:data-amount="amount"></output></template>
        <template component="x-reading-owner"><defs>
          <prop name="incoming" type="number" max="100">Source value.</prop>
        </defs><main from:data-incoming="incoming"><x-reading-default id="with-default" from:amount="incoming"></x-reading-default>
          <x-reading-empty id="without-default" from:amount="incoming"></x-reading-empty>
          <x-reading-default id="from-function" from:amount="concat(incoming)"></x-reading-default>
        </main></template>
        <x-reading-owner id="owner" incoming="oops"></x-reading-owner>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown; inputValue: unknown; validity: ValidityState; validate(): ValidityState }> } | undefined;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const owner = document.querySelector("#owner") as Element & { validity: ValidityState };
          const read = () => {
            const defaulted = document.querySelector("#with-default")!;
            const empty = document.querySelector("#without-default")!;
            const fromFunction = document.querySelector("#from-function")!;
            const ownerHost = runtime.getComponentHost(owner)!;
            return {
              incoming: ownerHost.props.incoming!.value,
              stateHasIncoming: "incoming" in ownerHost.state,
              inputValue: ownerHost.props.incoming!.inputValue,
              propValue: ownerHost.props.incoming!.value,
              propBadInput: ownerHost.props.incoming!.validity.badInput,
              checkedBadInput: ownerHost.props.incoming!.validate().badInput,
              defaultInput: runtime.getComponentHost(defaulted)?.props.amount?.inputValue,
              defaultValid: runtime.getComponentHost(defaulted)?.props.amount?.validity.valid,
              defaulted: runtime.getComponentHost(defaulted)?.props.amount?.value,
              empty: runtime.getComponentHost(empty)?.props.amount?.value,
              fromFunction: runtime.getComponentHost(fromFunction)?.props.amount?.value,
              rendered: [defaulted, empty].map((element) => element.getAttribute("data-amount")),
              boundRoot: owner.getAttribute("data-incoming"),
              badInput: owner.validity.badInput,
              rangeOverflow: owner.validity.rangeOverflow,
            };
          };
          const flush = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          const initial = read();
          runtime.updateComponentProps(owner, { incoming: 2 });
          await flush();
          const valid = read();
          runtime.updateComponentProps(owner, { incoming: "oops" });
          await flush();
          const rejected = read();
          runtime.updateComponentProps(owner, { incoming: 7 });
          await flush();
          const recovered = read();
          runtime.updateComponentProps(owner, { incoming: 130 });
          await flush();
          return { initial, valid, rejected, recovered, constrained: read() };
        });
        assert.deepEqual(actual, {
          initial: { incoming: null, stateHasIncoming: false, inputValue: "oops", propValue: null, propBadInput: true, checkedBadInput: true, defaultInput: null, defaultValid: true, defaulted: 5, empty: null, fromFunction: 5,
            rendered: ["5", null], boundRoot: null, badInput: true, rangeOverflow: false },
          valid: { incoming: 2, stateHasIncoming: false, inputValue: 2, propValue: 2, propBadInput: false, checkedBadInput: false, defaultInput: 2, defaultValid: true, defaulted: 2, empty: 2, fromFunction: 5,
            rendered: ["2", "2"], boundRoot: "2", badInput: false, rangeOverflow: false },
          rejected: { incoming: 2, stateHasIncoming: false, inputValue: "oops", propValue: 2, propBadInput: true, checkedBadInput: true, defaultInput: 2, defaultValid: true, defaulted: 2, empty: 2, fromFunction: 5,
            rendered: ["2", "2"], boundRoot: "2", badInput: true, rangeOverflow: false },
          recovered: { incoming: 7, stateHasIncoming: false, inputValue: 7, propValue: 7, propBadInput: false, checkedBadInput: false, defaultInput: 7, defaultValid: true, defaulted: 7, empty: 7, fromFunction: 5,
            rendered: ["7", "7"], boundRoot: "7", badInput: false, rangeOverflow: false },
          constrained: { incoming: 130, stateHasIncoming: false, inputValue: 130, propValue: 130, propBadInput: false, checkedBadInput: false, defaultInput: 130, defaultValid: true, defaulted: 130, empty: 130, fromFunction: 5,
            rendered: ["130", "130"], boundRoot: "130", badInput: false, rangeOverflow: true },
        });
      } finally { await browser.close(); }
    });

    it(`${engine} retains a user's invalid edit while a typed downstream binding stays unchanged`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const warnings: string[] = [];
        page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
        await page.setContent(`<template component="x-email-display"><defs>
          <prop name="address" type="email">Address.</prop>
        </defs><output from:data-address="address"></output></template>
        <template component="x-email-editor"><defs>
          <state name="address" type="email" value="ada@example.org"></state>
        </defs><section><input type="email" bind:value="address">
          <x-email-display id="display" from:address="address"></x-email-display>
        </section></template><x-email-editor id="editor"></x-email-editor>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const editor = document.querySelector("#editor")!;
          const display = document.querySelector("#display")!;
          const input = editor.querySelector("input")!;
          const read = () => ({ input: input.value, nativeMismatch: input.validity.typeMismatch,
            source: runtime.getComponentHost(editor)?.state.address,
            downstream: runtime.getComponentHost(display)?.props.address?.value });
          const initial = read();
          input.value = "oops";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await Promise.resolve();
          const invalid = read();
          input.value = "grace@example.org";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await Promise.resolve();
          return { initial, invalid, recovered: read() };
        });
        assert.deepEqual(actual, {
          initial: { input: "ada@example.org", nativeMismatch: false,
            source: "ada@example.org", downstream: "ada@example.org" },
          invalid: { input: "oops", nativeMismatch: true,
            source: "oops", downstream: "ada@example.org" },
          recovered: { input: "grace@example.org", nativeMismatch: false,
            source: "grace@example.org", downstream: "grace@example.org" },
        });
        assert.deepEqual(warnings, []);
      } finally { await browser.close(); }
    });

    it(`${engine} skips a handler write when its expression result has the wrong type`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-handler-type"><defs>
          <state name="count" type="number" value="2"></state>
          <handler name="bad"><set name="count" expr:value="concat(count)"></set></handler>
          <handler name="good"><set name="count" value="7"></set></handler>
        </defs><section><button class="bad" on:click="bad">Bad</button>
          <button class="good" on:click="good">Good</button>
          <output from:data-count="count"></output></section></template>
        <x-handler-type id="handler-test"></x-handler-type>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, unknown> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#handler-test")!;
          const read = () => ({ count: runtime.getComponentHost(root)?.state.count,
            rendered: root.querySelector("output")?.getAttribute("data-count") });
          const initial = read();
          root.querySelector<HTMLButtonElement>("button.bad")!.click();
          await Promise.resolve();
          const rejected = read();
          root.querySelector<HTMLButtonElement>("button.good")!.click();
          await Promise.resolve();
          return { initial, rejected, recovered: read(), noPropHandleForState: runtime.getComponentHost(root)?.props.count === undefined };
        });
        assert.deepEqual(actual, {
          noPropHandleForState: true,
          initial: { count: 2, rendered: "2" },
          rejected: { count: 2, rendered: "2" },
          recovered: { count: 7, rendered: "7" },
        });
      } finally { await browser.close(); }
    });

    it(`${engine} checks the selected field type for dynamic handler paths`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-dynamic-handler"><defs>
          <state name="items" type="list(object({ name: string }))" value="[{ name: 'Ada' }]"></state>
          <state name="index" type="integer" value="0"></state>
          <handler name="bad"><set name="items[$index].name" expr:value="7"></set></handler>
          <handler name="good"><set name="items[$index].name" value="Bea"></set></handler>
        </defs><main><button class="bad" on:click="bad"></button>
          <button class="good" on:click="good"></button><output $value="$items.0.name"></output></main>
        </template><x-dynamic-handler id="dynamic-handler"></x-dynamic-handler>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
          const root = document.querySelector("#dynamic-handler")!;
          const read = () => root.querySelector("output")?.textContent;
          const initial = read();
          root.querySelector<HTMLButtonElement>("button.bad")!.click();
          await Promise.resolve();
          const rejected = read();
          root.querySelector<HTMLButtonElement>("button.good")!.click();
          await Promise.resolve();
          return { initial, rejected, recovered: read() };
        });
        assert.deepEqual(actual, { initial: "Ada", rejected: "Ada", recovered: "Bea" });
      } finally { await browser.close(); }
    });

    it(`${engine} writes a correctly typed value even when it fails a values constraint`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-choice-state"><defs>
          <state name="size" type="keyword" values="sm, md" value="sm"></state>
        </defs><section><input bind:value="size"><output from:data-size="size"></output></section></template>
        <x-choice-state id="choice-state"></x-choice-state>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#choice-state")!;
          const input = root.querySelector("input")!;
          const output = root.querySelector("output")!;
          const initial = output.getAttribute("data-size");
          input.value = "lg";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await Promise.resolve();
          return { initial, source: runtime.getComponentHost(root)?.state.size,
            current: output.getAttribute("data-size") };
        });
        assert.deepEqual(actual, { initial: "sm", source: "lg", current: "lg" });
      } finally { await browser.close(); }
    });

    it(`${engine} reports authored prop bounds through the root validity state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const warnings: string[] = [];
        page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
        await page.setContent(`<template component="x-bounds"><defs>
          <prop name="amount" type="number" min="1" max="5">Amount.</prop>
          <prop name="code" type="string" minlength="2" maxlength="4">Code.</prop>
        </defs><div from:data-amount="amount" from:data-code="code"></div></template>
        <x-bounds id="bounded" amount="0" code="x"></x-bounds>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#bounded") as HTMLDivElement & { validity: ValidityState };
          const initial = { amount: runtime.getComponentHost(root)?.props.amount?.value,
            rangeUnderflow: root.validity.rangeUnderflow, tooShort: root.validity.tooShort };
          runtime.updateComponentProps(root, { amount: 6, code: "abcde" });
          await Promise.resolve();
          const changed = { rangeOverflow: root.validity.rangeOverflow, tooLong: root.validity.tooLong };
          runtime.updateComponentProps(root, { amount: 3, code: "abc" });
          await Promise.resolve();
          return { initial, changed, valid: root.validity.valid };
        });
        assert.deepEqual(actual, {
          initial: { amount: 0, rangeUnderflow: true, tooShort: true },
          changed: { rangeOverflow: true, tooLong: true }, valid: true,
        });
        assert.deepEqual(warnings, []);
      } finally { await browser.close(); }
    });

    it(`${engine} updates from: attributes when a prop or state changes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-from-reactive"><defs>
          <prop name="label" type="string">Label.</prop>
          <state type="number" name="count" value="0"></state>
          <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
        </defs><button from:data-label="label" from:data-count="count" on:click="increment">Go</button></template>
        <x-from-reactive id="test" label="First"></x-from-reactive>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const button = document.querySelector<HTMLButtonElement>("#test")!;
          const read = () => [button.getAttribute("data-label"), button.getAttribute("data-count")];
          const initial = read();
          runtime.updateComponentProps(button, { label: "Second" });
          await Promise.resolve();
          const afterProp = read();
          button.click();
          await Promise.resolve();
          return { initial, afterProp, afterState: read() };
        });
        assert.deepEqual(actual, {
          initial: ["First", "0"], afterProp: ["Second", "0"], afterState: ["Second", "1"],
        });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} reselects a prop type when its named state changes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-state-selected"><defs>
          <state name="mode" type="keyword" values="text, number" value="text"></state>
          <prop name="value">Value.<type from="mode">
            <option value="text" type="string"></option>
            <option value="number" type="number"></option>
          </type></prop>
          <handler name="toggle"><set name="mode" expr:value="mode = 'text' ? 'number' : 'text'"></set></handler>
        </defs><button from:data-value="value" on:click="toggle">Toggle</button></template>
        <x-state-selected id="test"></x-state-selected>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const button = document.querySelector<HTMLButtonElement>("#test")!;
          const read = () => ({ mode: runtime.getComponentHost(button)?.state.mode, value: runtime.getComponentHost(button)?.props.value?.value });
          runtime.updateComponentProps(button, { value: "2.5" });
          const textValue = read();
          runtime.updateComponentProps(button, { value: undefined });
          button.click();
          await Promise.resolve();
          runtime.updateComponentProps(button, { value: 2.5 });
          const numberValue = read();
          let rejected = false;
          try { runtime.updateComponentProps(button, { value: "2.5" }); }
          catch (error) { rejected = String(error).includes("HR002"); }
          return { textValue, numberValue, rejected };
        });
        assert.deepEqual(actual, {
          textValue: { mode: "text", value: "2.5" },
          numberValue: { mode: "number", value: 2.5 },
          rejected: false,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} reselects a child type from a parent state-bound prop`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-selected-child"><defs>
          <prop name="type" type="keyword" values="text, number" default="text">Mode.</prop>
          <prop name="value">Value.<type from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
        </defs><input from:type="type" from:value="value"></template>
        <template component="x-parent-source"><defs>
          <state name="mode" type="keyword" values="text, number" value="text"></state>
          <state name="entry" type="number"></state>
          <handler name="switch"><set name="mode" value="number"></set><set name="entry" value="2.5"></set></handler>
        </defs><div><button on:click="switch">Switch</button><x-selected-child id="child" from:type="mode" from:value="entry"></x-selected-child></div></template>
        <x-parent-source id="parent"></x-parent-source>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const parent = document.querySelector("#parent")!;
          const child = document.querySelector("#child")!;
          const read = () => ({ type: runtime.getComponentHost(child)?.props.type?.value, value: runtime.getComponentHost(child)?.props.value?.value });
          const initial = read();
          parent.querySelector("button")!.click();
          await Promise.resolve();
          return { initial, changed: read() };
        });
        assert.deepEqual(actual, {
          initial: { type: "text", value: null },
          changed: { type: "number", value: 2.5 },
        });
      } finally {
        await browser.close();
      }
    });

    for (const form of ["inline", "named"] as const) {
      it(`${engine} selects a ${form} prop type before parsing an HTML value`, async () => {
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const definition = form === "inline"
            ? `<prop name="value">Value.<type from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>`
            : `<type name="input-value" from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type><prop name="value" type="input-value">Value.</prop>`;
          await page.setContent(`<template component="x-dependent"><defs>
            <prop name="type" type="keyword" values="text, number" default="text">Control mode.</prop>
            ${definition}</defs><input from:type="type" from:value="value"></template>
            <x-dependent id="numeric" value="2.5" type="number"></x-dependent>
            <x-dependent id="text" value="2.5"></x-dependent>
            <x-dependent id="empty"></x-dependent>`);
          await page.addScriptTag({ path: bundlePath });
          const actual = await page.evaluate(() => {
            const runtime = (window as unknown as { HtmlRuntime: {
              lowerDocument(): void;
              getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
              updateComponentProps(element: Element, props: Record<string, unknown>): void;
            } }).HtmlRuntime;
            runtime.lowerDocument();
            const numeric = document.querySelector("#numeric")!;
            const text = document.querySelector("#text")!;
            const empty = document.querySelector("#empty")!;
            const initial = [numeric, text, empty].map((element) => runtime.getComponentHost(element)?.props.value?.value);
            runtime.updateComponentProps(numeric, { type: "text", value: "2.5" });
            const changed = runtime.getComponentHost(numeric)?.props.value?.value;
            let rejected = false;
            try { runtime.updateComponentProps(numeric, { type: "number", value: "2.5" }); }
            catch (error) { rejected = String(error).includes("HR002"); }
            return { initial, changed, rejected, typeAfterRejection: runtime.getComponentHost(numeric)?.props.type?.value };
          });
          assert.deepEqual(actual, { initial: [2.5, "2.5", null], changed: "2.5", rejected: false, typeAfterRejection: "number" });
        } finally {
          await browser.close();
        }
      });
    }

    it(`${engine} warns and ignores an invalid values constraint in a live definition`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const warnings: string[] = [];
        page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
        await page.setContent(`<template component="x-choices"><defs>
          <prop name="size" type="keyword" values="sm, two words">Size.</prop>
          <prop name="count" type="number" min="oops">Count.</prop>
        </defs><output from:data-size="size" from:data-count="count"></output></template><x-choices id="choice" size="lg" count="3"></x-choices>`);
        await page.addScriptTag({ path: bundlePath });
        const size = await page.evaluate(() => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: { size: unknown }; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          return runtime.getComponentHost(document.querySelector("#choice")!)?.props.size?.value;
        });
        assert.equal(size, "lg");
        assert.ok(warnings.some((message) => message.includes("HC013") && message.includes("values constraint")));
        assert.ok(warnings.some((message) => message.includes("HC013") && message.includes("min constraint")));
      } finally {
        await browser.close();
      }
    });

    it(`${engine} parses the supported types at an HTML component boundary`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const cases: ReadonlyArray<[string, string, unknown]> = [
          ["string", "Save", "Save"], ["keyword", "size-2", "size-2"],
          ["boolean", "false", false], ["integer", "-2", -2], ["number", "0.3", 0.3],
          ["url", "https://example.org/", "https://example.org/"], ["email", "ada@example.org", "ada@example.org"],
          ["email", "a@b", "a@b"],
          ["date", "2026-09-29", "2026-09-29"], ["month", "2026-09", "2026-09"],
          ["week", "2026-W40", "2026-W40"], ["time", "13:45", "13:45"],
          ["datetime-local", "2026-09-29T13:45", "2026-09-29T13:45"],
          ["datetime", "2026-09-29T13:45Z", "2026-09-29T13:45Z"],
          ["color", "rebeccapurple", "rebeccapurple"], ["color", "rgb(102 51 153)", "rgb(102 51 153)"],
          ["color-hex", "#663399cc", "#663399cc"],
          ["length", "1rem", "1rem"], ["percentage", "25%", "25%"], ["duration", "200ms", "200ms"],
          ["keyword+", "red blue", ["red", "blue"]], ["keyword#", "red, blue", ["red", "blue"]],
          ["object({ x: number, y: number })", "{ x: 3, y: 5 }", { x: 3, y: 5 }],
        ];
        const declarations = cases.map(([type], index) =>
          `<prop name="v${index}" type="${type}">Value ${index}.</prop>`).join("");
        const bindings = cases.map((_, index) => ` from:data-v${index}="v${index}"`).join("");
        const attributes = cases.map(([, written], index) => ` v${index}="${written}"`).join("");
        await page.setContent(`<template component="x-types"><defs>${declarations}</defs><output${bindings}></output></template><x-types id="typed"${attributes}></x-types>`);
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate((count) => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const props = runtime.getComponentHost(document.querySelector("#typed")!)!.props;
          return Array.from({ length: count }, (_, index) => props[`v${index}`]?.value);
        }, cases.length);
        assert.deepEqual(actual, cases.map(([, , expected]) => expected));
      } finally {
        await browser.close();
      }
    });

    it(`${engine} follows native email format cases at the component boundary`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-email"><defs>
          <prop name="address" type="email">Email address.</prop>
        </defs><output from:data-address="address"></output></template><x-email id="valid" address="a@b"></x-email>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          const native = document.createElement("input");
          native.type = "email";
          native.value = "a@b";
          const nativeValid = native.validity.valid;
          native.value = "a@-b";
          const nativeInvalid = native.validity.typeMismatch;
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
            getComponentHost(element: Element): { props: Record<string, { value: unknown; inputValue: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#valid")!;
          let rejected = false;
          try { runtime.updateComponentProps(root, { address: "a@-b" }); }
          catch (error) { rejected = String(error).includes("HR002"); }
          const address = runtime.getComponentHost(root)?.props.address;
          return { nativeValid, nativeInvalid, reflected: root.getAttribute("data-address"),
            accepted: address?.value, inputValue: address?.inputValue, rejected };
        });
        assert.deepEqual(result, { nativeValid: true, nativeInvalid: true, reflected: "a@b",
          accepted: "a@b", inputValue: "a@-b", rejected: false });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} parses constrained numeric values and preserves invalid framework input`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-current"><defs>
          <prop name="current" type="integer" values="1, 2, 3">Current location.</prop>
        </defs><div from:data-current="current"></div></template><x-current id="current" current="2"></x-current>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: { current: unknown }; props: { current: { inputValue: unknown; value: unknown; validity: ValidityState } } } | undefined;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#current")!;
          const fromHtml = runtime.getComponentHost(root)?.props.current.value;
          runtime.updateComponentProps(root, { current: "2" });
          const invalidValue = runtime.getComponentHost(root)?.props.current.value;
          const invalidInput = runtime.getComponentHost(root)?.props.current.inputValue;
          const propBadInput = runtime.getComponentHost(root)?.props.current.validity.badInput;
          const invalidValidity = (root as HTMLDivElement & { checkValidity(): boolean }).checkValidity();
          runtime.updateComponentProps(root, { current: 3 });
          return { fromHtml, invalidValue, invalidInput, propBadInput, invalidValidity, fromValue: runtime.getComponentHost(root)?.props.current.value };
        });
        assert.deepEqual(result, { fromHtml: 2, invalidValue: 2, invalidInput: "2", propBadInput: true, invalidValidity: false, fromValue: 3 });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} reports a declared pattern through validity on typed prop values`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-sku"><defs>
          <prop name="sku" type="string" pattern="[A-Z]{3}-[0-9]{4}">Stock code.</prop>
        </defs><div from:data-sku="sku"></div></template><x-sku id="valid" sku="ABC-1234"></x-sku>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(async () => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#valid") as HTMLDivElement & { validity: ValidityState };
          const initial = root.getAttribute("data-sku");
          runtime.updateComponentProps(root, { sku: "xABC-1234" });
          await Promise.resolve();
          return { initial, patternMismatch: root.validity.patternMismatch, after: root.getAttribute("data-sku") };
        });
        assert.deepEqual(result, { initial: "ABC-1234", patternMismatch: true, after: "xABC-1234" });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} uses an explicit null before framework root selection`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const definition = parseComponent(`<template component="x-null-choice" status="early" summary="Null root.">
          <defs><prop name="choice" type="keyword" values="on, off" default="on">Choice.</prop></defs>
          <template $match><article $when="choice = null"><output $value="choice"></output></article><section $else><output $value="choice"></output></section></template>
        </template>`, "null-choice.html");
        const page = await browser.newPage();
        await page.setContent(`<article id="null"></article><section id="default"></section>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate((parsed) => {
          const runtime = (window as unknown as { HtmlRuntime: {
            attachComponent(element: Element, definition: unknown, options?: { props?: Record<string, unknown> }): () => void;
            getComponentHost(element: Element): { state: { choice: unknown }; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          const nullRoot = document.querySelector("#null")!;
          const defaultRoot = document.querySelector("#default")!;
          const disposeNull = runtime.attachComponent(nullRoot, parsed, { props: { choice: null } });
          const disposeDefault = runtime.attachComponent(defaultRoot, parsed);
          const values = [runtime.getComponentHost(nullRoot)?.props.choice?.value, runtime.getComponentHost(defaultRoot)?.props.choice?.value];
          disposeNull();
          disposeDefault();
          return values;
        }, JSON.parse(JSON.stringify(definition)) as Record<string, unknown>);
        assert.deepEqual(result, [null, "on"]);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} exposes an omitted optional prop as null to the host`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-null-prop"><defs>
          <prop name="value" type="number">Optional count.</prop>
        </defs><output from:data-value="value"></output></template><x-null-prop id="missing"></x-null-prop>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          const runtime = (window as unknown as { HtmlRuntime: {
            lowerDocument(): void;
            getComponentHost(element: Element): { state: { value: unknown }; props: Record<string, { value: unknown }> } | undefined;
          } }).HtmlRuntime;
          runtime.lowerDocument();
          const root = document.querySelector("#missing")!;
          return runtime.getComponentHost(root)?.props.value?.value;
        });
        assert.equal(result, null);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} ignores malformed serialized form-default records during hydration`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-form-record"><input value="authored"></template>
          <input id="primitive" data-component="x-form-record" value="server" data-html-next-form-defaults="null">
          <input id="syntax" data-component="x-form-record" value="server" data-html-next-form-defaults="not-json">`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
          return Array.from(document.querySelectorAll<HTMLInputElement>("#primitive, #syntax"), (control) => ({
            value: control.value,
            defaultValue: control.defaultValue,
            marker: control.hasAttribute("data-html-next-form-defaults"),
          }));
        });
        assert.deepEqual(result, [
          { value: "server", defaultValue: "authored", marker: false },
          { value: "server", defaultValue: "authored", marker: false },
        ]);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} repeats scoped projection with reactive slot props`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-scoped-list"><defs>
          <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
          <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
          </defs><section><button type="button" on:click="add">Add</button><ul>
          <slot $each="row of rows" $key="row.id" name="row" from:item="row" from:index="loop.index">
          <li class="fallback" $value="row.name"></li></slot></ul></section></template>
          <x-scoped-list id="filled"><template slot="row"><li><b $value="item.name"></b><em $value="index"></em></li></template></x-scoped-list>
          <x-scoped-list id="empty"></x-scoped-list>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
        const read = () => page.evaluate(() => ({
          filled: Array.from(document.querySelectorAll("#filled li"), (row) => row.textContent),
          fallback: Array.from(document.querySelectorAll("#empty li"), (row) => row.textContent),
        }));
        assert.deepEqual(await read(), { filled: ["Ada0"], fallback: ["Ada"] });
        await page.locator("#filled button").click();
        await page.locator("#empty button").click();
        await page.waitForFunction(() => document.querySelectorAll("#filled li").length === 2);
        assert.deepEqual(await read(), { filled: ["Ada0", "Bea1"], fallback: ["Ada", "Bea"] });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} hydrates scoped projection in place and reconnects its row bindings`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-scoped-hydrate"><defs>
          <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
          <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
          <handler name="rename"><set name="rows.0.name" expr:value="'Ann'"></set></handler>
          </defs><section><button class="add" type="button" on:click="add">Add</button><button class="rename" type="button" on:click="rename">Rename</button><ul>
          <slot $each="row of rows" $key="row.id" name="row" from:item="row" from:index="loop.index"></slot>
          </ul></section></template><main><x-scoped-hydrate id="source"><template slot="row"><li><b $value="item.name"></b><em $value="index"></em></li></template></x-scoped-hydrate></main>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const R = window.HtmlRuntime;
          R.lowerDocument();
          const source = document.querySelector('#source');
          const server = document.createElement('main');
          server.setHTMLUnsafe(R.serializeRenderedForm(source.parentElement));
          const hydrated = server.querySelector('#source');
          hydrated.id = 'hydrated';
          const originalRow = hydrated.querySelector('li');
          document.body.append(server);
          R.lowerDocument();
          const initial = { rootKept: document.querySelector('#hydrated') === hydrated,
            rowKept: hydrated.querySelector('li') === originalRow,
            source: [...source.querySelectorAll('li')].map(row => row.textContent),
            hydrated: [...hydrated.querySelectorAll('li')].map(row => row.textContent) };
          source.querySelector('.rename').click();
          hydrated.querySelector('.rename').click();
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          const renamed = { source: [...source.querySelectorAll('li')].map(row => row.textContent),
            hydrated: [...hydrated.querySelectorAll('li')].map(row => row.textContent) };
          source.querySelector('.add').click();
          hydrated.querySelector('.add').click();
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          return { initial,
            renamed,
            source: [...source.querySelectorAll('li')].map(row => row.textContent),
            hydrated: [...hydrated.querySelectorAll('li')].map(row => row.textContent) };
        })()`);
        assert.deepEqual(result, {
          initial: { rootKept: true, rowKept: true, source: ["Ada0"], hydrated: ["Ada0"] },
          renamed: { source: ["Ann0"], hydrated: ["Ann0"] },
          source: ["Ada0", "Bea1"], hydrated: ["Ada0", "Bea1"],
        });
      } finally {
        await browser.close();
      }
    });

    it(`${engine} retains the consumer's lexical scope in a nested scoped slot`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-scoped-rows"><defs>
          <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
          <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
          </defs><section><button class="add" type="button" on:click="add">Add</button><ul>
          <slot $each="row of rows" $key="row.id" name="row" from:item="row"></slot></ul></section></template>
          <template component="x-scoped-consumer"><defs><state name="heading" value="People"></state>
          <handler name="rename"><set name="heading" expr:value="'Team'"></set></handler></defs>
          <main><button class="rename" type="button" on:click="rename">Rename</button><x-scoped-rows>
          <template slot="row"><li><b $value="item.name"></b><i $value="heading"></i></li></template>
          </x-scoped-rows></main></template><x-scoped-consumer id="parent"></x-scoped-consumer>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
        const rows = () => page.locator("#parent li").allTextContents();
        assert.deepEqual(await rows(), ["AdaPeople"]);
        await page.locator("#parent .rename").click();
        await page.waitForFunction(() => document.querySelector("#parent li")?.textContent === "AdaTeam");
        await page.locator("#parent .add").click();
        await page.waitForFunction(() => document.querySelectorAll("#parent li").length === 2);
        assert.deepEqual(await rows(), ["AdaTeam", "BeaTeam"]);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} restores nested scoped-slot ownership after hydration`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-hydrated-rows"><defs>
          <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
          <handler name="renameRow"><set name="rows.0.name" expr:value="'Ann'"></set></handler>
          </defs><section><button class="row-rename" type="button" on:click="renameRow">Row</button><ul>
          <slot $each="row of rows" $key="row.id" name="row" from:item="row"></slot></ul></section></template>
          <template component="x-hydrated-consumer"><defs><state name="heading" value="People"></state>
          <handler name="rename"><set name="heading" expr:value="'Team'"></set></handler></defs>
          <main><button class="rename" type="button" on:click="rename">Rename</button><x-hydrated-rows>
          <template slot="row"><li><b $value="item.name"></b><i $value="heading"></i></li></template>
          </x-hydrated-rows></main></template><div><x-hydrated-consumer id="source"></x-hydrated-consumer></div>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const R = window.HtmlRuntime;
          R.lowerDocument();
          const source = document.querySelector('#source');
          const server = document.createElement('div');
          server.setHTMLUnsafe(R.serializeRenderedForm(source.parentElement));
          const hydrated = server.querySelector('#source');
          hydrated.id = 'hydrated';
          const originalChild = hydrated.querySelector('section');
          const originalRow = hydrated.querySelector('li');
          document.body.append(server);
          R.lowerDocument();
          const read = () => [source.querySelector('li')?.textContent, hydrated.querySelector('li')?.textContent];
          const initial = { rows: read(), childKept: hydrated.querySelector('section') === originalChild,
            rowKept: hydrated.querySelector('li') === originalRow };
          source.querySelector('.rename').click();
          hydrated.querySelector('.rename').click();
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          const heading = read();
          source.querySelector('.row-rename').click();
          hydrated.querySelector('.row-rename').click();
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          return { initial, heading, row: read() };
        })()`);
        assert.deepEqual(result, {
          initial: { rows: ["AdaPeople", "AdaPeople"], childKept: true, rowKept: true },
          heading: ["AdaTeam", "AdaTeam"], row: ["AnnTeam", "AnnTeam"],
        });
      } finally {
        await browser.close();
      }
    });
  }

  afterAll(async () => {
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];

  for (const [name, browserType] of engines) {
    it(`${name} can leave application-owned roots out of document observation`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="observed-card" status="early" summary="Observation filter fixture.">' +
          '<article><slot></slot></article></template>' +
          '<main><article id="owned" data-component="observed-card" data-owned>Owned</article></main>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const stop = window.HtmlRuntime.observeDocument(document, {
            shouldLower: (element, _definition, hydration) =>
              !(hydration && element.hasAttribute("data-owned")),
          });
          const live = document.createElement("observed-card");
          live.textContent = "Live";
          document.querySelector("main").append(live);
          await new Promise(resolve => setTimeout(resolve, 0));
          const owned = document.querySelector("#owned");
          const lowered = document.querySelector("main > article:not(#owned)");
          const result = {
            ownedText: owned.textContent,
            ownedMarked: owned.hasAttribute("data-owned"),
            loweredTag: lowered?.localName,
            loweredText: lowered?.textContent,
          };
          stop();
          return result;
        })()`);
        assert.deepEqual(result, {
          ownedText: "Owned",
          ownedMarked: true,
          loweredTag: "article",
          loweredText: "Live",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders template SVG in the SVG namespace with camelCase names`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="icon-close" status="early" summary="SVG namespace fixture.">' +
          '<button type="button"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">' +
          '<path d="M6 6l12 12M18 6 6 18"></path><linearGradient id="g" from:gradientUnits="\'userSpaceOnUse\'"></linearGradient>' +
          '<foreignObject width="10" height="10"><span>html</span></foreignObject></svg></button></template>' +
          '<main><icon-close></icon-close></main>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const svg = document.querySelector("main svg");
          const path = svg.querySelector("path");
          return {
            svg: svg.namespaceURI,
            viewBox: svg.getAttribute("viewBox"),
            path: path.namespaceURI,
            pathWidth: Math.round(path.getBBox().width),
            gradient: svg.querySelector("linearGradient")?.namespaceURI ?? null,
            boundUnits: svg.querySelector("linearGradient")?.getAttribute("gradientUnits") ?? null,
            foreignChild: svg.querySelector("foreignObject > span")?.namespaceURI ?? null,
          };
        })()`);
        assert.deepEqual(result, {
          svg: "http://www.w3.org/2000/svg",
          viewBox: "0 0 24 24",
          path: "http://www.w3.org/2000/svg",
          pathWidth: 12,
          gradient: "http://www.w3.org/2000/svg",
          boundUnits: "userSpaceOnUse",
          foreignChild: "http://www.w3.org/1999/xhtml",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} lowers components that other components render in the same pass`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // A component's invocations only exist once it renders, so one explicit pass has to follow
        // them. Otherwise nested components stay inert until something observes the document.
        await page.setContent(
          '<template component="x-chip" status="early" summary="Chip.">' +
          '<defs><prop name="label" type="string" default="none">Label.</prop></defs>' +
          '<span class="chip" $value="label"></span></template>' +
          '<template component="x-row" status="early" summary="Row.">' +
          '<defs><prop name="tone" type="string" default="a">Tone.</prop></defs>' +
          '<li class="row"><x-chip from:label="tone"></x-chip><slot></slot></li></template>' +
          '<template component="x-bar" status="early" summary="Bar.">' +
          '<main><ul><x-row $each="index of [1, 2]" from:tone="concat(\'t\', index)">' +
          '<b>projected</b></x-row></ul></main></template>' +
          '<x-bar></x-bar>',
        );
        await page.addScriptTag({ path: bundlePath });
        const lowered = await page.evaluate(() => {
          return (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
        });
        const result = await page.evaluate(() => ({
          rows: Array.from(document.querySelectorAll("li.row"), (row) => row.getAttribute("data-tone")),
          chips: Array.from(document.querySelectorAll("span.chip"), (chip) => chip.textContent),
          projected: Array.from(document.querySelectorAll("li.row > b"), (node) => node.textContent),
          pending: document.querySelectorAll("x-row, x-chip").length,
        }));
        assert.deepEqual({ lowered, ...result }, {
          // x-bar, two x-row, and the x-chip each row renders.
          lowered: 5,
          rows: ["t1", "t2"],
          chips: ["t1", "t2"],
          projected: ["projected", "projected"],
          pending: 0,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} lets slotted descendants react to their logical provider's state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-steps"><defs>` +
          `<state type="number" name="current" value="1"></state>` +
          `<handler name="next"><set name="current" expr:value="current + 1"></set></handler>` +
          `</defs><section><button type="button" on:click="next">Next</button><ol><slot></slot></ol></section></template>` +
          `<template component="x-step"><defs>` +
          `<prop name="index" type="number" required>Step index.</prop>` +
          `<context name="current" from="x-steps" as="activeStep"></context>` +
          `</defs><li from:aria-current="activeStep = index ? 'step' : null"><slot></slot></li></template>` +
          `<x-steps><x-step index="1">Account</x-step><x-step index="2">Payment</x-step></x-steps>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(async () => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          const read = () => Array.from(document.querySelectorAll("ol > li"), (step) => step.getAttribute("aria-current"));
          const before = read();
          (document.querySelector("section > button") as HTMLButtonElement).click();
          await Promise.resolve();
          await Promise.resolve();
          return { before, after: read(), roots: document.querySelectorAll("[data-component]").length };
        });
        assert.deepEqual(result, { before: ["step", null], after: [null, "step"], roots: 3 });
      } finally {
        await browser.close();
      }
    });

    it(`${name} rejects a context reader without an ancestor state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-reader"><defs>` +
          `<context name="current" from="x-steps"></context></defs>` +
          `<span $value="current"></span></template><x-reader></x-reader>`);
        await page.addScriptTag({ path: bundlePath });
        const message = await page.evaluate(() => {
          try {
            (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
            return "no error";
          } catch (error) {
            return String(error);
          }
        });
        assert.match(message, /HR009.*requires context `current` from <x-steps>/);
      } finally {
        await browser.close();
      }
    });

    it(`${name} reports a clear diagnostic when a document definition needs the live parser`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="x-plain" status="early" summary="Plain.">' +
          '<p class="plain">plain</p></template><x-plain></x-plain>',
        );
        // The general runtime, without the live delivery's parser installed.
        await page.addScriptTag({ path: runtimeOnlyBundlePath });
        const outcome = await page.evaluate(() => {
          try {
            (window as unknown as { BareRuntime: { lowerDocument(): number } }).BareRuntime.lowerDocument();
            return "lowered";
          } catch (error) {
            return (error as { diagnostic?: { code?: string } }).diagnostic?.code ?? String(error);
          }
        });
        assert.equal(outcome, "HR007");
      } finally {
        await browser.close();
      }
    });

    it(`${name} leaves native length constraints applying to a two-way bound control`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // Assigning `value` clears the control's dirty value flag, and minlength only constrains a
        // dirty value, so echoing the user's own input back would switch their constraint off.
        await page.setContent(
          '<template component="x-note" status="early" summary="Note.">' +
          '<defs><state name="note"></state></defs>' +
          '<form><input name="note" bind:value="note" minlength="3" maxlength="6">' +
          '<output class="echo" $value="note"></output></form></template>' +
          '<x-note></x-note>',
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
        });
        await page.locator('input[name="note"]').pressSequentially("ab");
        await page.waitForFunction(`document.querySelector(".echo")?.textContent === "ab"`);
        const short = await page.evaluate(() => {
          const field = document.querySelector('input[name="note"]') as HTMLInputElement;
          return { tooShort: field.validity.tooShort, valid: field.checkValidity(), bound: field.value };
        });
        await page.locator('input[name="note"]').pressSequentially("cd");
        await page.waitForFunction(`document.querySelector(".echo")?.textContent === "abcd"`);
        const long = await page.evaluate(() => {
          const field = document.querySelector('input[name="note"]') as HTMLInputElement;
          return { tooShort: field.validity.tooShort, valid: field.checkValidity() };
        });
        assert.deepEqual(
          { short, long },
          {
            short: { tooShort: true, valid: false, bound: "ab" },
            long: { tooShort: false, valid: true },
          },
        );
      } finally {
        await browser.close();
      }
    });

    it(`${name} runs a parent's on: binding on a child component's declared event`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // The listener is written on the <x-emit> invocation, which is replaced by that
        // component's own <button> root, so the binding has to follow it there.
        await page.setContent(
          '<template component="x-emit" status="early" summary="Emitter.">' +
          '<defs><event name="picked" type="string">A choice.</event>' +
          '<handler name="choose"><dispatch event="picked" value="olives"></dispatch></handler></defs>' +
          '<button type="button" class="pick" on:click="choose">pick</button></template>' +
          '<template component="x-collect" status="early" summary="Collector.">' +
          '<defs><state type="number" name="taken" value="0"></state>' +
          '<handler name="count"><set name="taken" expr:value="taken + 1"></set></handler></defs>' +
          '<main><x-emit on:picked="count"></x-emit><i class="taken" $value="taken"></i></main>' +
          '</template><x-collect></x-collect>',
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
        await page.waitForSelector("button.pick");
        await page.click("button.pick");
        await page.click("button.pick");
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => document.querySelector(".taken")?.textContent), "2");
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a component delegating its root reactive and connected`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://api.example/**", async (route) => {
          await route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ label: "from the endpoint" }),
          });
        });
        // x-outer's root is another component, so the element x-outer renders is replaced by
        // x-frame's own root. The outer instance has to follow that root instead of being left on
        // the discarded element, which used to disconnect it and abort its declared read.
        await page.setContent(
          '<template component="x-frame" status="early" summary="Frame.">' +
          '<defs><prop name="heading" type="string" default="none">Heading.</prop></defs>' +
          '<section class="frame"><h2 class="heading" $value="heading"></h2>' +
          '<slot name="body"></slot></section></template>' +
          '<template component="x-outer" status="early" summary="Outer.">' +
          '<defs><prop name="label" type="string" default="none">Label.</prop>' +
          '<state type="number" name="count" value="1"></state>' +
          '<data name="feed" src="https://api.example/feed" type="object({ label: string })"></data>' +
          '<handler name="bump"><set name="count" expr:value="count + 1"></set></handler></defs>' +
          '<x-frame from:heading="concat(\'count \', count)">' +
          '<span slot="body"><button type="button" class="bump" on:click="bump"></button>' +
          '<i class="own" $value="count"></i>' +
          '<output class="feed" $value="feed.value.label"></output></span></x-frame></template>' +
          '<x-outer label="reflected"></x-outer>',
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
        await page.waitForSelector("section.frame");
        // The declared read must settle: the outer instance is still connected.
        await page.waitForFunction(`document.querySelector(".feed")?.textContent === "from the endpoint"`);
        await page.click("button.bump");
        await page.waitForTimeout(100);
        const result = await page.evaluate(() => ({
          own: document.querySelector(".own")?.textContent,
          heading: document.querySelector(".heading")?.textContent,
          feed: document.querySelector(".feed")?.textContent,
          lineage: document.querySelector("section.frame")?.getAttribute("data-component"),
          // The component the author invoked owns the shared root, so page code reaching that root
          // gets the outer component's host and state, not the component it delegates to.
          hostState: (() => {
            const runtime = (window as unknown as { HtmlRuntime: unknown }).HtmlRuntime as {
              getComponentHost(element: Element): { root: Element; element: Element; state: Record<string, unknown>; props: Record<string, { value: unknown }> } | undefined;
            };
            const host = runtime.getComponentHost(document.querySelector("section.frame")!);
            return host === undefined
              ? "no host"
              : `${host.element === host.root}:${host.root.localName}:count=${String(host.state.count)}:label=${String(host.props.label?.value)}`;
          })(),
        }));
        assert.deepEqual(result, {
          own: "2",
          heading: "count 2",
          feed: "from the endpoint",
          lineage: "x-outer x-frame",
          hostState: "true:section:count=2:label=reflected",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} gives a controller its root and the elements a consumer projected`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // One tree, no shadow boundary: the component's own <li> and the consumer's <b>/<i> are
        // siblings under the same root, so only the slot can tell them apart.
        await page.setContent(
          '<template component="x-listbox" status="early" summary="Listbox.">' +
          '<ul class="list"><li class="own">own</li><slot></slot><slot name="footer"></slot></ul>' +
          "</template>" +
          '<x-listbox><b class="a">A</b><i class="b">B</i><em slot="footer">F</em></x-listbox>',
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
        await page.waitForSelector("ul.list");
        const result = await page.evaluate(() => {
          const runtime = (window as unknown as { HtmlRuntime: unknown }).HtmlRuntime as {
            getComponentHost(element: Element): {
              root: Element;
              slots: Record<string, readonly Element[]>;
            } | undefined;
          };
          const host = runtime.getComponentHost(document.querySelector("ul.list")!)!;
          const named = (elements: readonly Element[]): string =>
            elements.map((element) => element.className || element.localName).join(",");
          return {
            root: host.root.localName,
            byDefault: named(host.slots.default!),
            footer: named(host.slots.footer!),
            absent: named(host.slots.nothing!),
          };
        });
        assert.deepEqual(result, {
          root: "ul",
          byDefault: "a,b",
          footer: "em",
          absent: "",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} gives one $ref inside an iteration the list that iteration renders`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="x-rows" status="early" summary="Rows.">' +
          "<defs><state name=\"items\" type=\"list(string)\" value=\"['a', 'b', 'c']\"></state>" +
          "<handler name=\"drop\"><set name=\"items\" value=\"['a', 'c']\"></set></handler></defs>" +
          '<div class="panel" $ref="panel">' +
          '<ul><li $each="n of items" $key="n" $ref="rows" $value="n"></li></ul>' +
          '<button type="button" class="drop" on:click="drop"></button>' +
          "</div></template>" +
          "<x-rows></x-rows>",
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
        await page.waitForSelector("div.panel li");
        const read = () => page.evaluate(() => {
          const runtime = (window as unknown as { HtmlRuntime: unknown }).HtmlRuntime as {
            getComponentHost(element: Element): {
              refs: Record<string, Element | readonly Element[]>;
            } | undefined;
          };
          const refs = runtime.getComponentHost(document.querySelector("div.panel")!)!.refs;
          const rows = refs.rows as readonly Element[];
          return {
            panelIsList: Array.isArray(refs.panel),
            rowsIsList: Array.isArray(rows),
            rows: rows.map((row) => row.textContent).join(","),
          };
        });
        // Outside an iteration a name is one element; inside it, always a list.
        assert.deepEqual(await read(), { panelIsList: false, rowsIsList: true, rows: "a,b,c" });
        await page.click("button.drop");
        await page.waitForTimeout(50);
        // The list is what the iteration still renders, so a removed row leaves it.
        assert.deepEqual(await read(), { panelIsList: false, rowsIsList: true, rows: "a,c" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a lowered child component's bound props up to date`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // The child's invocation element is replaced by its own root when it lowers, so the
        // parent's binding has to follow the child rather than keep writing to the replaced node.
        await page.setContent(
          '<template component="x-child" status="early" summary="Child.">' +
          '<defs><prop name="label" type="string" default="none">Label.</prop></defs>' +
          '<p class="child" $value="label"></p></template>' +
          '<template component="x-parent" status="early" summary="Parent.">' +
          '<defs><state type="number" name="count" value="1"></state>' +
          '<handler name="bump"><set name="count" expr:value="count + 1"></set></handler></defs>' +
          '<main><button type="button" class="bump" on:click="bump"></button>' +
          '<x-child from:label="concat(\'count \', count)"></x-child></main></template>' +
          '<x-parent></x-parent>',
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
        await page.waitForSelector("p.child");
        const before = await page.evaluate(() => document.querySelector("p.child")?.textContent);
        await page.click("button.bump");
        await page.click("button.bump");
        await page.waitForTimeout(100);
        const after = await page.evaluate(() => ({
          text: document.querySelector("p.child")?.textContent,
          reflected: document.querySelector("p.child")?.getAttribute("data-label"),
        }));
        assert.deepEqual({ before, ...after }, {
          before: "count 1",
          text: "count 3",
          reflected: "count 3",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} rebuilds the same instance from its rendered form`, async () => {
      // Spec: live-browser-distributable.md, "Rendered form". Authored markup lowered in the browser and
      // the same instance's serialized rendered form hydrated must build equal instances, and behave the
      // same after the same later change.
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="rf-card" status="early" summary="Rendered form fixture.">' +
          '<defs><prop name="tone" type="string" default="info">Tone.</prop></defs>' +
          '<article><header><slot name="title">Untitled</slot></header><div><slot></slot></div></article></template>' +
          '<template component="rf-adj" status="early" summary="Rendered form fixture."><p>Hello <slot></slot>!</p></template>' +
          '<template component="rf-if" status="early" summary="Rendered form fixture.">' +
          '<defs><prop name="open" type="boolean" default="false">Open.</prop></defs>' +
          '<div><section $if="open"><slot name="extra">none</slot></section><slot></slot></div></template>' +
          '<template component="rf-toggle" status="early" summary="Rendered form fixture."><defs>' +
          '<state type="boolean" name="open" value="false"></state>' +
          '<handler name="toggle"><set name="open" expr:value="not open"></set></handler></defs>' +
          '<div><button type="button" on:click="toggle">More</button>' +
          '<section $if="open"><slot name="extra">none</slot></section><slot></slot></div></template>' +
          '<template component="rf-list" status="early" summary="Rendered form fixture.">' +
          '<defs><prop name="rows" type="list(string)" default="[]">Rows.</prop></defs>' +
          `<ul><li $each="row of rows" $key="row"><slot from:name="concat('row-', row)">Unnamed</slot></li></ul></template>` +
          '<template component="rf-wrap" status="early" summary="Rendered form fixture.">' +
          '<section><rf-card><span slot="title"><slot name="heading"></slot></span><slot></slot></rf-card></section></template>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const R = window.HtmlRuntime;
          const tick = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          const tags = "rf-card,rf-adj,rf-if,rf-toggle,rf-list,rf-wrap";
          const cases = [
            { name: "named and default slots", html: '<rf-card><b slot="title">T</b>Body <i>x</i></rf-card>', change: ["attr", "data-tone", "warn"] },
            { name: "text beside template text", html: '<rf-adj>world</rf-adj>' },
            { name: "slot under $if opened by a prop", html: '<rf-if><i slot="extra">E</i>main</rf-if>', change: ["attr", "data-open", "true"] },
            { name: "slot under $if opened by a handler", html: '<rf-toggle><i slot="extra">E</i>main</rf-toggle>', change: ["click"] },
            { name: "$each row added later", html: '<rf-list rows="[&quot;a&quot;]"><span slot="row-b">B</span></rf-list>', change: ["attr", "data-rows", '["a","b"]'] },
            { name: "slot passthrough into a nested component", html: '<rf-wrap><em slot="heading">H</em>Inner</rf-wrap>' },
          ];
          const shapes = (box) => JSON.stringify([...box.querySelectorAll("[data-component]")].map((el) => R.inspectInstance(el)));
          const failures = [];
          for (const { name, html, change } of cases) {
            const lowered = document.createElement("div");
            lowered.setHTMLUnsafe(html);
            document.body.append(lowered);
            for (let pass = 0; pass < 10 && lowered.querySelector(tags); pass += 1) { R.lowerDocument(); await tick(); }
            const hydrated = document.createElement("div");
            hydrated.setHTMLUnsafe(R.serializeRenderedForm(lowered));
            document.body.append(hydrated);
            R.lowerDocument();
            await tick();
            if (shapes(lowered) !== shapes(hydrated)) failures.push(name + ": instance");
            if (lowered.innerHTML !== hydrated.innerHTML) failures.push(name + ": DOM");
            if (hydrated.querySelector(":scope > * > template")) failures.push(name + ": carrier left in the DOM");
            if (change) {
              for (const box of [lowered, hydrated]) {
                if (change[0] === "attr") box.firstElementChild.setAttribute(change[1], change[2]);
                else box.querySelector("button").click();
              }
              await tick();
              if (lowered.innerHTML !== hydrated.innerHTML) failures.push(name + ": DOM after change");
            }
            lowered.remove();
            hydrated.remove();
          }
          return failures;
        })()`);
        assert.deepEqual(result, []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} parses and lowers components owned by another browser realm`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          const frame = document.createElement("iframe");
          document.querySelector("main").append(frame);
          const frameDocument = frame.contentDocument;
          frameDocument.open();
          frameDocument.write('<template component="realm-button" status="early" summary="Cross-realm fixture."><button><slot></slot></button></template><realm-button id="realm">Realm</realm-button>');
          frameDocument.close();
          const stop = window.HtmlRuntime.observeDocument(frameDocument);
          const result = {
            localName: frameDocument.querySelector("#realm").localName,
            text: frameDocument.querySelector("#realm").textContent,
          };
          stop();
          frame.remove();
          return result;
        })()`);
        assert.deepEqual(result, { localName: "button", text: "Realm" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} lowers later declarative instances without rescanning the document`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<template component="demo-local" status="early" summary="Local mutation fixture."><button><slot></slot></button></template>' +
          '<template component="demo-unused-a" status="early" summary="Unused A."><span></span></template>' +
          '<template component="demo-unused-b" status="early" summary="Unused B."><span></span></template>' +
          '<main></main>',
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const stop = window.HtmlRuntime.observeDocument();
          const nativeQuery = Document.prototype.querySelectorAll;
          const nativeElementQuery = Element.prototype.querySelectorAll;
          let documentQueries = 0;
          let wildcardQueries = 0;
          let rootMarkerQueries = 0;
          let discoveryQueries = 0;
          let registryScans = 0;
          const nativeMapKeys = Map.prototype.keys;
          const nativeMapValues = Map.prototype.values;
          Map.prototype.keys = function() {
            registryScans += 1;
            return nativeMapKeys.call(this);
          };
          Map.prototype.values = function() {
            registryScans += 1;
            return nativeMapValues.call(this);
          };
          Document.prototype.querySelectorAll = function(selector) {
            if (this === document) documentQueries += 1;
            return nativeQuery.call(this, selector);
          };
          Element.prototype.querySelectorAll = function(selector) {
            if (selector === "*") wildcardQueries += 1;
            if (selector === "[data-component]") rootMarkerQueries += 1;
            if (["template[component]", "[data-component]", "demo-local", "demo-unused-a", "demo-unused-b"].every(part => selector.includes(part))) {
              discoveryQueries += 1;
            }
            return nativeElementQuery.call(this, selector);
          };
          const section = document.createElement("section");
          section.innerHTML = '<demo-local id="local">Local</demo-local>';
          document.querySelector("main").append(section);
          await tick();
          const localName = document.querySelector("#local").localName;
          Document.prototype.querySelectorAll = nativeQuery;
          Element.prototype.querySelectorAll = nativeElementQuery;
          Map.prototype.keys = nativeMapKeys;
          Map.prototype.values = nativeMapValues;
          stop();
          return { documentQueries, wildcardQueries, rootMarkerQueries, discoveryQueries, registryScans, localName };
        })()`) as {
          documentQueries: number;
          wildcardQueries: number;
          rootMarkerQueries: number;
          discoveryQueries: number;
          registryScans: number;
          localName: string;
        };
        assert.equal(result.documentQueries, 0);
        assert.equal(result.wildcardQueries, 0);
        assert.equal(result.rootMarkerQueries, 0);
        assert.equal(result.discoveryQueries, 2);
        assert.equal(result.registryScans, 0);
        assert.equal(result.localName, "button");
      } finally {
        await browser.close();
      }
    });

    it(`${name} shares one mutation observer across live and generated components`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const NativeObserver = window.MutationObserver;
          let documentObservers = 0;
          window.MutationObserver = class extends NativeObserver {
            observe(target, options) {
              if (target instanceof Document) documentObservers += 1;
              return super.observe(target, options);
            }
          };
          const stopDocument = window.HtmlRuntime.observeDocument();
          const definition = {
            contract: { version: 1, name: "DemoManaged", tag: "demo-managed", status: "early",
              summary: "Managed lifecycle fixture.", nativeElement: "button", props: {} },
            template: { kind: "element", name: "button", attributes: [], children: [] },
            css: "", declarations: [], slots: [],
            root: { kind: "native", element: "button", choices: ["button"] },
          };
          const first = document.createElement("button");
          const second = document.createElement("button");
          const stopFirst = window.HtmlRuntime.manageComponentLifecycle(first, definition);
          const stopSecond = window.HtmlRuntime.manageComponentLifecycle(second, definition);
          document.querySelector("main").append(first, second);
          await tick();
          const connected = [first, second].every(element => window.HtmlRuntime.getComponentHost(element) != null);
          const events = [];
          const host = window.HtmlRuntime.getComponentHost(first);
          const privateState = first[Symbol.for("@nextwebwg/html-next.runtime.v1")] === undefined;
          const frozenHost = Object.isFrozen(host);
          const nativeOnlyEvents = !("on" in host);
          first.addEventListener("connect", () => events.push("connect"));
          first.addEventListener("disconnect", () => events.push("disconnect"));
          first.remove();
          await tick();
          document.querySelector("main").append(first);
          await tick();
          stopDocument();
          stopFirst();
          stopSecond();
          return { documentObservers, connected, events, privateState, frozenHost, nativeOnlyEvents };
        })()`);
        assert.deepEqual(result, {
          documentObservers: 1,
          connected: true,
          events: [],
          privateState: true,
          frozenHost: true,
          nativeOnlyEvents: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} observes later definitions and instances with balanced connection cleanup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<main></main><aside></aside>");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const events = [];
          const errors = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onConnect(element, definition) {
              events.push("connect:" + element.id + ":" + (definition.controller ?? "none"));
              return () => events.push("dispose:" + element.id);
            },
            onError(error) { errors.push(error.diagnostic?.code ?? error.message); },
          });
          document.querySelector("main").innerHTML = '<demo-dynamic id="first">First</demo-dynamic>';
          await tick();
          const pending = document.querySelector("#first").localName;
          const definition = document.createElement("template");
          definition.setAttribute("component", "demo-dynamic");
          definition.setAttribute("status", "early");
          definition.setAttribute("summary", "Dynamic test component.");
          definition.setAttribute("controller", "./dynamic.js");
          definition.innerHTML = '<button><slot></slot></button><style id="once">button { color: red; }</style>';
          document.body.append(definition);
          await tick();
          const first = document.querySelector("#first");
          const lowered = first.localName;
          document.querySelector("aside").append(first);
          await tick();
          const afterMove = [...events];
          first.remove();
          await tick();
          document.querySelector("main").append(first);
          await tick();
          document.querySelector("main").insertAdjacentHTML("beforeend", '<demo-dynamic id="second">Second</demo-dynamic>');
          await tick();
          const second = document.querySelector("#second").localName;
          const sameFirst = first === document.querySelector("#first");
          stop(); stop();
          document.body.insertAdjacentHTML("beforeend", '<demo-dynamic id="stopped"></demo-dynamic>');
          await tick();
          return { pending, lowered, second, sameFirst, afterMove, events, errors,
            styles: document.querySelectorAll("#once").length,
            stopped: document.querySelector("#stopped").localName };
        })()`);
        assert.deepEqual(result, {
          pending: "demo-dynamic", lowered: "button", second: "button", sameFirst: true,
          afterMove: ["connect:first:./dynamic.js"],
          events: ["connect:first:./dynamic.js", "dispose:first", "connect:first:./dynamic.js",
            "connect:second:./dynamic.js", "dispose:first", "dispose:second"],
          errors: [], styles: 1, stopped: "demo-dynamic",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} can stop observation from a connection callback without leaking cleanup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<template component="demo-stop" status="early" summary="Stop."><button></button></template>');
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const events = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onConnect(element) {
              events.push("connect:" + element.id);
              stop();
              return () => events.push("dispose:" + element.id);
            },
          });
          document.body.insertAdjacentHTML("beforeend", '<demo-stop id="one"></demo-stop><demo-stop id="two"></demo-stop>');
          await new Promise(resolve => setTimeout(resolve, 0));
          stop();
          return events;
        })()`);
        assert.deepEqual(result, ["connect:one", "dispose:one"]);
      } finally {
        await browser.close();
      }
    });

    it(`${name} retains duplicate rules and custom-element precedence after discovery`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<template component="demo-retained" status="early" summary="Retained."><button></button></template>');
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const errors = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onError(error) { errors.push(error.diagnostic.code); },
          });
          const duplicate = document.createElement("template");
          duplicate.setAttribute("component", "demo-retained");
          duplicate.setAttribute("status", "early");
          duplicate.setAttribute("summary", "Duplicate.");
          duplicate.innerHTML = "<span></span>";
          document.body.append(duplicate);
          await tick();
          duplicate.remove();
          customElements.define("demo-retained", class extends HTMLElement {});
          document.body.insertAdjacentHTML("beforeend", '<demo-retained id="owned"></demo-retained>');
          await tick();
          const owned = document.querySelector("#owned");
          stop();
          return { errors, name: owned.localName,
            nativeUpgrade: owned instanceof customElements.get("demo-retained") };
        })()`);
        assert.deepEqual(result, { errors: ["HR001"], name: "demo-retained", nativeUpgrade: true });
      } finally {
        await browser.close();
      }
    });

    it(`${name} never promotes dynamic inert or sanitized content into executable definitions`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<template component="demo-content" status="early" summary="Content."><defs><prop name="body" type="string">Content.</prop></defs><article $html="body"></article></template><template component="demo-safe" status="early" summary="Safe."><button></button></template>');
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const errors = [];
          const stop = window.HtmlRuntime.observeDocument(document, {
            onError(error) { errors.push(error.diagnostic.code); },
          });
          const invalid = document.createElement("template");
          invalid.setAttribute("component", "demo-invalid");
          invalid.innerHTML = '<defs><script>window.executed = true</script></defs><button></button>';
          document.body.append(invalid);
          await tick();
          invalid.remove();
          const external = document.createElement("template");
          external.setAttribute("component", "demo-external");
          external.setAttribute("src", "https://unmapped.example/definition.html");
          document.body.append(external);
          await tick();
          external.remove();
          const content = document.createElement("demo-content");
          content.setAttribute("body", '<template component="demo-injected"><script>window.executed = true</script><button></button></template><demo-safe id="content-only"></demo-safe>');
          document.body.append(content);
          await tick();
          const contentOnly = document.querySelector("#content-only");
          if (contentOnly !== null) document.body.append(contentOnly);
          await tick();
          stop();
          return { errors, executed: window.executed ?? false,
            definitions: document.querySelectorAll("template[component]").length,
            contentName: contentOnly?.localName ?? null,
            sanitizedContent: document.querySelector("article")?.innerHTML };
        })()`);
        assert.deepEqual(result, {
          errors: ["HT009", "HL001"], executed: false, definitions: 0,
          contentName: null, sanitizedContent: "",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} lowers a missing required prop and reports validity`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const definitionMarkup =
          `<template component="demo-transactional-button" id="definition" status="early" summary="Transactional test component.">` +
          `<defs><prop name="label" type="string" required>Button label.</prop></defs>` +
          `<button from:data-label="label"><slot></slot></button>` +
          `<style id="definition-style">button { color: red; }</style></template>`;
        await page.setContent(`${definitionMarkup}<main><demo-transactional-button id="first" label="first"><strong id="kept-child">First</strong></demo-transactional-button><demo-transactional-button id="second"></demo-transactional-button></main>`);
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(() => {
          const definition = document.querySelector("#definition");
          // A <template>'s <style> lives in its inert content fragment, not the light DOM.
          const style = definition.content.querySelector("#definition-style");
          const keptChild = document.querySelector("#kept-child");
          const lowered = window.HtmlRuntime.lowerDocument();
          const loweredFirst = document.querySelector("#first");
          const loweredSecond = document.querySelector("#second");
          return {
            lowered,
            definitionRemoved: !definition.isConnected,
            styleMovedToHead: style.parentElement === document.head,
            firstIsButton: loweredFirst instanceof HTMLButtonElement,
            childIdentityPreserved: loweredFirst.querySelector("#kept-child") === keptChild,
            secondIsButton: loweredSecond instanceof HTMLButtonElement,
            secondInvalid: !loweredSecond.validity.valid,
          };
        })()`);

        assert.deepEqual(result, {
          lowered: 2,
          definitionRemoved: true,
          styleMovedToHead: true,
          firstIsButton: true,
          childIdentityPreserved: true,
          secondIsButton: true,
          secondInvalid: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} rejects executable literal attributes and unsafe property sinks`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const diagnostic = async (source: string): Promise<string> => {
          await page.setContent(source);
          await page.addScriptTag({ path: bundlePath });
          return page.evaluate(`(() => {
            try {
              window.HtmlRuntime.lowerDocument();
              return "no diagnostic";
            } catch (error) {
              return error.diagnostic.code;
            }
          })()`);
        };
        const buttonMarkup =
          `<template component="demo-unsafe-button" status="early" summary="Unsafe test component.">` +
          `<button onclick="alert(1)"></button></template>`;
        const iframeMarkup =
          `<template component="demo-unsafe-frame" status="early" summary="Unsafe test component.">` +
          `<defs><prop name="markup" type="string">Embedded markup.</prop></defs>` +
          `<iframe from:srcdoc="markup"></iframe></template>`;

        assert.equal(await diagnostic(buttonMarkup), "HT010");
        assert.equal(await diagnostic(iframeMarkup), "HT007");
      } finally {
        await browser.close();
      }
    });

    it(`${name} evaluates $value/$html and sanitizes $html markup`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-note" status="early" summary="Note.">` +
            `<defs><prop name="body" type="string">Body markup.</prop>` +
            `<prop name="label" type="string" default="Note">Label.</prop></defs>` +
            `<article><h3 $value="label"></h3><div class="body" $html="body"></div></article>` +
            `</template>` +
            `<x-note id="n" label="Hi" body="<b class='unsafe-class' id='unsafe-id' title='safe'>ok</b><script>window.__x=1</script><img src=x onerror=window.__x=2><a href='java&#x0A;script:window.__x=3' target='_blank'>bad</a><iframe srcdoc='&lt;script>window.parent.__x=4&lt;/script>'></iframe>"></x-note>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const note = document.querySelector("#n");
          const body = note.querySelector(".body");
          return {
            heading: note.querySelector("h3").textContent,
            hasBold: body.querySelector("b") !== null,
            markup: body.innerHTML,
            scriptCount: body.querySelectorAll("script").length,
            onerror: body.querySelector("img")?.hasAttribute("onerror") ?? null,
            dangerousHref: body.querySelector("a")?.hasAttribute("href") ?? null,
            iframeCount: body.querySelectorAll("iframe").length,
            xflag: window.__x ?? "unset",
          };
        })()`);
        assert.deepEqual(result, {
          heading: "Hi",
          hasBold: true,
          markup: '<b title="safe">ok</b><a>bad</a>',
          scriptCount: 0,
          onerror: null,
          dangerousHref: false,
          iframeCount: 0,
          xflag: "unset",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} updates inline template $html when state changes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-inline-html" status="early" summary="Inline HTML.">` +
            `<defs><state name="body" type="string" value="<b>One</b>"></state>` +
            `<handler name="update"><set name="body" expr:value="'<i>Two</i>'"></set></handler></defs>` +
            `<p>Before <template $html="body"></template> after <button on:click="update">Update</button></p>` +
            `</template><x-inline-html id="inline"></x-inline-html>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate<{ before: string; after: string }>(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector("#inline");
          const before = root.innerHTML;
          root.querySelector("button").click();
          await Promise.resolve();
          const after = root.innerHTML;
          return { before, after };
        })()`);
        assert.match(result.before, /<b>One<\/b>/);
        assert.doesNotMatch(result.after, /<b>One<\/b>/);
        assert.match(result.after, /<i>Two<\/i>/);
      } finally {
        await browser.close();
      }
    });

    it(`${name} drops executable schemes from bound URL attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-link" status="early" summary="Link.">` +
            `<defs><prop name="destination" type="string">Destination.</prop></defs>` +
            `<a from:href="destination"><slot></slot></a></template>` +
            `<x-link id="link" destination="java&#x0A;script:alert(1)">Open</x-link>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const hasHref = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          return document.getElementById("link")!.hasAttribute("href");
        });

        assert.equal(hasHref, false);
      } finally {
        await browser.close();
      }
    });

    it(`${name} renders control flow: $each, $if, $match, $with`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-demo" status="early" summary="Control flow.">` +
            `<defs>` +
            `<prop name="tier" type="keyword" values="free, pro" default="free">Plan.</prop>` +
            `<prop name="show" type="boolean" default="false">Show.</prop>` +
            `</defs>` +
            `<div>` +
            `<ul class="nums"><li $each="n, i of [10, 20, 30]" $where="n > 10" from:data-i="i" $value="n"></li></ul>` +
            `<p class="maybe" $if="show">extra</p>` +
            `<template $match="tier as t">` +
            `<span class="tier" $when="t = 'pro'">Pro</span>` +
            `<span class="tier" $else>Free</span>` +
            `</template>` +
            `<template $with="{ name: 'Ada' } as u"><b class="who" $value="u.name"></b></template>` +
            `</div></template>` +
            `<x-demo id="d" tier="pro"></x-demo>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(() => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector("#d");
          return {
            nums: Array.from(root.querySelectorAll(".nums li")).map((li) => [li.getAttribute("data-i"), li.textContent]),
            maybePresent: root.querySelector(".maybe") !== null,
            tier: root.querySelector(".tier")?.textContent ?? null,
            tierCount: root.querySelectorAll(".tier").length,
            who: root.querySelector(".who")?.textContent ?? null,
          };
        })()`);
        assert.deepEqual(result, {
          nums: [["0", "20"], ["1", "30"]], // $where drops 10; index is post-filter
          maybePresent: false, // show defaults false
          tier: "Pro",
          tierCount: 1, // only the winning arm renders
          who: "Ada",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} parses boolean HTML attributes and checks typed generated updates`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-boolean" status="early" summary="Boolean attributes.">` +
            `<defs><prop name="enabled" type="boolean" default="true">Enabled.</prop></defs>` +
            `<output from:data-enabled="enabled"></output></template>` +
            `<x-boolean id="bare" enabled></x-boolean>` +
            `<x-boolean id="explicit-true" enabled="true"></x-boolean>` +
            `<x-boolean id="explicit-false" enabled="false"></x-boolean>` +
            `<x-boolean id="default"></x-boolean>` +
            `<div id="generated"></div>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.addScriptTag({ path: generatedBundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const interpreted = ["bare", "explicit-true", "explicit-false", "default"].map(id =>
            document.getElementById(id).getAttribute("data-enabled")
          );
          const generated = document.getElementById("generated");
          let applied;
          window.HtmlGeneratedRuntime.manageGeneratedProps(generated, [{
            name: "enabled", attribute: "data-enabled", value: false, type: "boolean", required: false
          }], (_name, value) => { applied = value; });
          const values = [];
          for (const value of [true, false]) {
            window.HtmlGeneratedRuntime.updateGeneratedProps(generated, { enabled: value });
            await new Promise(resolve => setTimeout(resolve, 0));
            values.push(applied);
          }
          let invalid = false;
          try { window.HtmlGeneratedRuntime.updateGeneratedProps(generated, { enabled: "false" }); }
          catch (error) { invalid = String(error).includes("HR002"); }
          await new Promise(resolve => setTimeout(resolve, 0));
          return { interpreted, generated: values, invalid, typeMismatch: generated.validity.typeMismatch };
        })()`);

        assert.deepEqual(result, {
          interpreted: ["true", "true", "false", "true"],
          generated: [true, false],
          invalid: false,
          typeMismatch: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} updates state, computed values, and bindings through declarative handlers`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-counter" status="early" summary="Counter.">` +
            `<defs>` +
            `<state name="count" type="number" value="5"></state>` +
            `<computed name="doubled" from="count * 2"></computed>` +
            `<data name="feed"></data>` +
            `<handler name="inc"><set name="count" expr:value="count + 1"></set></handler>` +
            `<handler name="ready"></handler>` +
            `</defs>` +
            `<div from:data-count="count" from:data-doubled="doubled">` +
            `<button on:click="inc" $value="count"></button>` +
            `<output bind:value="count"></output>` +
            `<i $value="feed.pending"></i>` +
            `<span on:mouseover="ready"></span>` +
            `</div></template>` +
            `<x-counter id="c"></x-counter>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector("#c");
          const snapshot = () => ({
            count: root.getAttribute("data-count"),
            doubled: root.getAttribute("data-doubled"),
            buttonText: root.querySelector("button").textContent,
            boundValue: root.querySelector("output").getAttribute("value"),
          });
          const initial = snapshot();
          root.querySelector("button").click();
          await Promise.resolve();
          return {
            initial,
            after: snapshot(),
            buttonHasOnClick: root.querySelector("button").hasAttribute("on:click"),
            pending: root.querySelector("i").textContent,
            spanHasOnMouseover: root.querySelector("span").hasAttribute("on:mouseover"),
          };
        })()`);
        assert.deepEqual(result, {
          initial: { count: "5", doubled: "10", buttonText: "5", boundValue: "5" },
          after: { count: "6", doubled: "12", buttonText: "6", boundValue: "6" },
          buttonHasOnClick: false, // on: consumed, never emitted
          pending: "true", // data seeded in its pending shape
          spanHasOnMouseover: false, // event binding consumed
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} provides lazy controller signals and computed values`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-controller-reactivity" status="early" summary="Controller reactivity.">` +
            `<defs><event name="local-change" type="number" bubbles="false"></event></defs>` +
            `<p>Ready</p></template><div id="controller-parent"><x-controller-reactivity id="controller-reactivity"></x-controller-reactivity></div>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#controller-reactivity');
          const { computed, dispatch, effect, signal } = window.HtmlRuntime.getComponentHost(root);
          const source = signal(0);
          let computedRuns = 0;
          let effectRuns = 0;
          let observed = '';
          let eventTotal = 0;
          const onControllerValue = (event) => {
            eventTotal += event.detail.value;
          };
          root.addEventListener('controller-value', onControllerValue);
          const dispatched = dispatch('controller-value', { value: 2 });
          root.removeEventListener('controller-value', onControllerValue);
          dispatch('controller-value', { value: 10 });
          let parentSawLocal = false;
          document.querySelector('#controller-parent').addEventListener('local-change', () => { parentSawLocal = true; });
          dispatch('local-change', 1);
          const bucket = computed(() => {
            computedRuns += 1;
            return source.get() === 0 ? 'empty' : 'ready';
          });
          source.set(1);
          source.set(2);
          await Promise.resolve();
          const beforeRead = computedRuns;
          const first = bucket.get();
          const second = bucket.get();
          effect(() => {
            effectRuns += 1;
            observed = bucket.get();
          });
          source.set(3);
          await Promise.resolve();
          return { beforeRead, first, second, computedRuns, effectRuns, observed, dispatched, eventTotal, parentSawLocal };
        })()`);
        assert.deepEqual(result, {
          beforeRead: 0,
          first: "ready",
          second: "ready",
          computedRuns: 2,
          effectRuns: 1,
          observed: "ready",
          dispatched: true,
          eventTotal: 2,
          parentSawLocal: false,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} reconnects controller effects after later computeds and pauses detached creation`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<main><div id="controller-order"></div></main>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const tick = () => new Promise(resolve => setTimeout(resolve, 0));
          const stopDocument = window.HtmlRuntime.observeDocument();
          const root = document.querySelector('#controller-order');
          const definition = {
            contract: { version: 1, name: 'ControllerOrder', tag: 'controller-order', status: 'early',
              summary: 'Controller order fixture.', nativeElement: 'div', props: {} },
            template: { kind: 'element', name: 'div', attributes: [], children: [] },
            css: '', declarations: [], slots: [],
            root: { kind: 'native', element: 'div', choices: ['div'] },
          };
          const stopRoot = window.HtmlRuntime.manageComponentLifecycle(root, definition);
          const { computed, effect, signal } = window.HtmlRuntime.getComponentHost(root);
          const gate = signal(false);
          const source = signal(1);
          let derived;
          let observed = 0;
          let computedRuns = 0;
          let effectRuns = 0;
          let effectCleanups = 0;
          effect(() => {
            effectRuns += 1;
            gate.get();
            if (derived) observed = derived.get();
            return () => { effectCleanups += 1; };
          });
          derived = computed(() => {
            computedRuns += 1;
            return source.get() * 2;
          });
          gate.set(true);
          await Promise.resolve();

          root.remove();
          await tick();
          let detachedRuns = 0;
          effect(() => { detachedRuns += 1; });
          const detachedRunsBeforeReconnect = detachedRuns;
          source.set(10);
          await Promise.resolve();
          const whileDetached = {
            signalValue: source.get(),
            computedRuns,
            effectRuns,
            effectCleanups,
          };

          document.querySelector('main').append(root);
          await tick();
          source.set(2);
          await Promise.resolve();
          await Promise.resolve();
          const beforeStop = { detachedRuns, computedRuns, effectRuns, effectCleanups, observed };
          stopRoot();
          source.set(3);
          await Promise.resolve();
          const afterStop = { detachedRuns, computedRuns, effectRuns, effectCleanups, observed };
          stopDocument();
          return { detachedRunsBeforeReconnect, whileDetached, beforeStop, afterStop };
        })()`);
        assert.deepEqual(result, {
          detachedRunsBeforeReconnect: 0,
          whileDetached: {
            signalValue: 10,
            computedRuns: 1,
            effectRuns: 2,
            effectCleanups: 2,
          },
          beforeStop: {
            detachedRuns: 1,
            computedRuns: 3,
            effectRuns: 4,
            effectCleanups: 3,
            observed: 4,
          },
          afterStop: {
            detachedRuns: 1,
            computedRuns: 3,
            effectRuns: 4,
            effectCleanups: 4,
            observed: 4,
          },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} writes text, checkbox, radio, select, and number controls back to state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-form" status="early" summary="Bindings.">` +
            `<defs><state type="object({ text: string, checked: boolean, radio: boolean, choice: string, count: number })" name="form" value="{ text: 'a', checked: false, radio: false, choice: 'a', count: 1 }"></state></defs>` +
            `<form>` +
            `<input class="text" bind:value="form.text">` +
            `<input class="check" type="checkbox" bind:checked="form.checked">` +
            `<input class="radio" type="radio" bind:checked="form.radio">` +
            `<select class="choice" bind:value="form.choice"><option value="a">A</option><option value="b">B</option></select>` +
            `<input class="number" type="number" bind:value="form.count">` +
            `<output class="result" $value="[form.text, form.checked, form.radio, form.choice, form.count]"></output>` +
            `</form></template><x-form id="f"></x-form>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#f');
          const text = root.querySelector('.text');
          const check = root.querySelector('.check');
          const radio = root.querySelector('.radio');
          const choice = root.querySelector('.choice');
          const number = root.querySelector('.number');
          text.value = 'next'; text.dispatchEvent(new Event('input', { bubbles: true }));
          check.checked = true; check.dispatchEvent(new Event('change', { bubbles: true }));
          radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }));
          choice.value = 'b'; choice.dispatchEvent(new Event('change', { bubbles: true }));
          number.value = '7'; number.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
          return root.querySelector('.result').textContent;
        })()`);
        assert.equal(result, "next true true b 7");
      } finally {
        await browser.close();
      }
    });

    it(`${name} reactively updates structural ranges and preserves keyed node identity`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-structure" status="early" summary="Structure.">` +
            `<defs>` +
            `<state type="boolean" name="show" value="true"></state>` +
            `<state type="list(unknown)" name="rows" value="[{ id: 1, label: 'A' }, { id: 2, label: 'B' }, { id: 3, label: 'C' }, { id: 4, label: 'D' }, { id: 5, label: 'E' }]"></state>` +
            `<state type="string" name="mode" value="a"></state>` +
            `<state type="object({ name: string })" name="person" value="{ name: 'Ada' }"></state>` +
            `<handler name="change">` +
            `<set name="show" value="false"></set>` +
            `<set name="rows" expr:value="[{ id: 1, label: 'A' }, { id: 5, label: 'E' }, { id: 3, label: 'C2' }, { id: 4, label: 'D' }, { id: 2, label: 'B' }]"></set>` +
            `<set name="mode" expr:value="'b'"></set>` +
            `<set name="person" expr:value="{ name: 'Grace' }"></set>` +
            `</handler></defs>` +
            `<main><button on:click="change">change</button>` +
            `<i class="conditional" $if="show">shown</i>` +
            `<ul><li $each="row of rows" $key="row.id" from:data-id="row.id" $value="row.label"></li></ul>` +
            `<div $match="mode as current"><span class="a" $when="current = 'a'">A</span><span class="b" $else>B</span></div>` +
            `<p $with="person as current" class="person" $value="current.name"></p>` +
            `</main></template><x-structure id="s"></x-structure>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#s');
          const before = Array.from(root.querySelectorAll('li'));
          const list = root.querySelector('ul');
          const nativeMoveBefore = typeof list.moveBefore === 'function';
          let moveBeforeCalls = 0;
          if (nativeMoveBefore) {
            const moveBefore = list.moveBefore;
            Object.defineProperty(list, 'moveBefore', { value(node, child) {
              moveBeforeCalls += 1;
              return moveBefore.call(this, node, child);
            }});
          }
          let movedRows = 0;
          const observer = new MutationObserver(records => {
            for (const record of records) {
              movedRows += Array.from(record.addedNodes).filter(node => node instanceof HTMLLIElement).length;
            }
          });
          observer.observe(list, { childList: true });
          root.querySelector('button').click();
          await Promise.resolve();
          await Promise.resolve();
          for (const record of observer.takeRecords()) {
            movedRows += Array.from(record.addedNodes).filter(node => node instanceof HTMLLIElement).length;
          }
          observer.disconnect();
          const after = Array.from(root.querySelectorAll('li'));
          return {
            conditional: root.querySelector('.conditional') !== null,
            rows: after.map((row) => [row.dataset.id, row.textContent]),
            identitiesPreserved: after.every((row) => before.includes(row)),
            arm: root.querySelector('.b')?.textContent,
            oldArmGone: root.querySelector('.a') === null,
            person: root.querySelector('.person')?.textContent,
            movedRows,
            nativeMoveBefore,
            moveBeforeCalls,
          };
        })()`);
        const { nativeMoveBefore, moveBeforeCalls, ...behavior } = result as {
          readonly nativeMoveBefore: boolean;
          readonly moveBeforeCalls: number;
        } & Readonly<Record<string, unknown>>;
        assert.deepEqual(behavior, {
          conditional: false,
          rows: [["1", "A"], ["5", "E"], ["3", "C2"], ["4", "D"], ["2", "B"]],
          identitiesPreserved: true,
          arm: "B",
          oldArmGone: true,
          person: "Grace",
          movedRows: 2,
        });
        assert.equal(moveBeforeCalls > 0, nativeMoveBefore);
      } finally {
        await browser.close();
      }
    });

    it(`${name} leaves ordered keyed blocks settled across insertion and deletion`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-key-order" status="early" summary="Key order.">` +
            `<defs><state type="list(unknown)" name="rows" value="[{ id: 1 }, { id: 2 }, { id: 3 }]"></state></defs>` +
            `<ul><li $each="row of rows" $key="row.id" from:data-id="row.id" $value="row.id"></li></ul>` +
            `</template><x-key-order id="keys"></x-key-order>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#keys');
          const list = root;
          const host = window.HtmlRuntime.getComponentHost(root);
          const identities = new Map(Array.from(list.querySelectorAll('li'), row => [row.dataset.id, row]));
          const update = async rows => {
            const existing = new Set(list.querySelectorAll('li'));
            let moved = 0;
            const observer = new MutationObserver(records => {
              for (const record of records) {
                moved += Array.from(record.addedNodes).filter(node => existing.has(node)).length;
              }
            });
            observer.observe(list, { childList: true });
            host.state.rows = rows;
            await Promise.resolve();
            await Promise.resolve();
            for (const record of observer.takeRecords()) {
              moved += Array.from(record.addedNodes).filter(node => existing.has(node)).length;
            }
            observer.disconnect();
            return moved;
          };
          const insertionMoves = await update([{ id: 1 }, { id: 4 }, { id: 2 }, { id: 3 }]);
          const deletionMoves = await update([{ id: 1 }, { id: 4 }, { id: 3 }]);
          const rows = Array.from(list.querySelectorAll('li'));
          return {
            insertionMoves,
            deletionMoves,
            order: rows.map(row => row.dataset.id),
            retained: rows[0] === identities.get('1') && rows[2] === identities.get('3'),
          };
        })()`);
        assert.deepEqual(result, {
          insertionMoves: 0,
          deletionMoves: 0,
          order: ["1", "4", "3"],
          retained: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} runs declared data reads and updates their reactive state`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://api.example/**", async (route) => {
          const query = new URL(route.request().url()).searchParams.get("q");
          await route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ label: `Result ${query}` }),
          });
        });
        await page.setContent(
          `<template component="x-data" status="early" summary="Data.">` +
            `<defs><state type="string" name="query" value="hello"></state>` +
            `<data name="result" src="https://api.example/search" type="object({ label: string })">` +
            `<param name="q" from:value="query"></param></data></defs>` +
            `<main><i class="pending" $value="result.pending"></i>` +
            `<output class="label" $value="result.value.label"></output></main>` +
            `</template><x-data id="data"></x-data>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
        });
        await page.waitForFunction(() => document.querySelector("#data .label")?.textContent === "Result hello");
        const result = await page.evaluate(() => ({
          pending: document.querySelector("#data .pending")?.textContent,
          label: document.querySelector("#data .label")?.textContent,
        }));
        assert.deepEqual(result, { pending: "false", label: "Result hello" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} samples expr:value data params without subscribing to them`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const requests: string[] = [];
        await page.route("https://api.example/**", async (route) => {
          const url = new URL(route.request().url());
          requests.push(url.search);
          await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ label: `${url.searchParams.get("q")}:${url.searchParams.get("token")}` }) });
        });
        await page.setContent(`<template component="x-param-modes"><defs>
          <state name="query" type="string" value="first"></state>
          <state name="token" type="string" value="a"></state>
          <data name="result" src="https://api.example/search" type="object({ label: string })">
            <param name="q" from:value="query"></param>
            <param name="token" expr:value="token"></param>
          </data>
          <handler name="changeToken"><set name="token" value="b"></set></handler>
          <handler name="changeQuery"><set name="query" value="second"></set></handler>
        </defs><section><button class="token" on:click="changeToken">Token</button>
          <button class="query" on:click="changeQuery">Query</button>
          <output $value="result.value.label"></output></section></template><x-param-modes id="case"></x-param-modes>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
        await page.waitForFunction(() => document.querySelector("#case output")?.textContent === "first:a");
        await page.locator("#case .token").click();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(requests.length, 1);
        await page.locator("#case .query").click();
        await page.waitForFunction(() => document.querySelector("#case output")?.textContent === "second:b");
        assert.deepEqual(requests, ["?q=first&token=a", "?q=second&token=b"]);
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps the accepted data request when a calculated parameter becomes invalid`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const requests: string[] = [];
        await page.route("https://api.example/**", async (route) => {
          const query = new URL(route.request().url()).searchParams.get("width") ?? "";
          requests.push(query);
          await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ label: query }) });
        });
        await page.setContent(`<template component="x-data-unit"><defs>
          <state name="width" type="length" value="8.8px"></state>
          <state name="step" type="length" value="1px"></state>
          <data name="result" src="https://api.example/search" type="object({ label: string })">
            <param name="width" from:value="round(width, step)"></param>
          </data>
          <handler name="bad"><set name="step" value="1rem"></set></handler>
          <handler name="good"><set name="step" value="2px"></set></handler>
        </defs><section><button class="bad" on:click="bad">Bad</button><button class="good" on:click="good">Good</button>
          <output $value="result.value.label"></output></section></template><x-data-unit id="case"></x-data-unit>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
        await page.waitForFunction(() => document.querySelector("#case output")?.textContent === "9px");
        await page.locator("#case .bad").click();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.deepEqual(requests, ["9px"]);
        await page.locator("#case .good").click();
        await page.waitForFunction(() => document.querySelector("#case output")?.textContent === "8px");
        assert.deepEqual(requests, ["9px", "8px"]);
      } finally {
        await browser.close();
      }
    });

    it(`${name} checks a typed reference read by index, as ui-combobox reads its first item`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const messages: string[] = [];
        page.on("console", (message) => messages.push(message.text()));
        await page.setContent(
          `<template component="x-first" status="early" summary="Indexed reads.">` +
            `<defs><state name="items" type="list(object({ name: string, 'odd key': string }))"` +
            ` value="[{ name: 'Apple', 'odd key': 'x' }]"></state>` +
            `<state name="byId" type="object({ '42': object({ name: string }) })" value="{ '42': { name: 'Ann' } }"></state>` +
            `<handler name="swap"><set name="items" expr:value="[{ name: 7, 'odd key': 'y' }]"></set>` +
            `<set name="byId" expr:value="{ '42': { name: 7 } }"></set></handler></defs>` +
            `<main><output $value="$items.0.name"></output><b $value="$items.0['odd key']"></b><i $value="$byId.42.name"></i>` +
            `<button type="button" on:click="swap"></button></main>` +
            `</template><x-first id="first"></x-first>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const read = () => page.evaluate(() => [
          document.querySelector("#first output")?.textContent,
          document.querySelector("#first b")?.textContent,
          document.querySelector("#first i")?.textContent,
        ]);
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
        });
        const initial = await read();
        await page.click("#first button");
        await page.waitForTimeout(50);
        // A dependency path names a list index and an object key alike (items.0.name, byId.42.name);
        // reading it must not fail, and a value that breaks its declared type leaves only that
        // reference inert, whether a list or an object holds it.
        assert.deepEqual({ initial, swapped: await read() }, { initial: ["Apple", "x", "Ann"], swapped: ["Apple", "y", "Ann"] });
        assert.deepEqual(messages.filter((text) => /SyntaxError/.test(text)), []);
        assert.deepEqual(messages.filter((text) => text.includes("declared type")), []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} leaves a reference inert when its value breaks its declared type`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // The second response breaks `label`; the third shows the typed reference can recover.
        let read = 0;
        await page.route("https://api.example/**", async (route) => {
          read += 1;
          await route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: read === 1
              ? JSON.stringify({ label: "first", note: "kept" })
              : read === 2
                ? JSON.stringify({ label: 42, note: "second", addedByServer: true })
                : JSON.stringify({ label: "third", note: "third note" }),
          });
        });
        await page.setContent(
          `<template component="x-typed" status="early" summary="Typed data.">` +
            `<defs><state type="number" name="round" value="1"></state>` +
            `<data name="result" src="https://api.example/search"` +
            ` type="object({ label: string, note: string, ... })">` +
            `<param name="round" from:value="round"></param></data>` +
            `<computed name="shouted" from="concat(result.value.label, '!')"></computed>` +
            `<handler name="again"><set name="round" expr:value="round + 1"></set></handler></defs>` +
            `<main><output class="label" $value="result.value.label"></output>` +
            `<output class="note" $value="result.value.note"></output>` +
            `<output class="shouted" $value="shouted"></output>` +
            `<i class="ok" $value="result.ok"></i>` +
            `<button type="button" class="again" on:click="again"></button></main>` +
            `</template><x-typed id="typed"></x-typed>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
        });
        await page.waitForFunction(() => document.querySelector("#typed .label")?.textContent === "first");
        await page.click("button.again");
        await page.waitForFunction(() => document.querySelector("#typed .note")?.textContent === "second");
        const afterInvalid = await page.evaluate(() => ({
          label: document.querySelector("#typed .label")?.textContent,
          note: document.querySelector("#typed .note")?.textContent,
          shouted: document.querySelector("#typed .shouted")?.textContent,
          ok: document.querySelector("#typed .ok")?.textContent,
        }));
        assert.deepEqual(afterInvalid, {
          // `label` broke its declared type, so the binding kept what it had...
          label: "first",
          // ...while the sibling reference, and the request itself, carried on.
          note: "second",
          ok: "true",
          shouted: "first!",
        });
        await page.click("button.again");
        await page.waitForFunction(() => document.querySelector("#typed .note")?.textContent === "third note");
        const recovered = await page.evaluate(() => ({
          label: document.querySelector("#typed .label")?.textContent,
          note: document.querySelector("#typed .note")?.textContent,
          shouted: document.querySelector("#typed .shouted")?.textContent,
        }));
        assert.deepEqual(recovered, { label: "third", note: "third note", shouted: "third!" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps component controls associated with their author-owned form`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-slug" status="early" summary="Slug editor.">` +
            `<defs><state type="string" name="slug" value=""></state></defs>` +
            `<fieldset><input name="slug" required pattern="[a-z-]+" bind:value="slug">` +
            `<output $value="slug"></output></fieldset></template>` +
            `<form id="post" action="/posts" method="post"><x-slug></x-slug>` +
            `<button type="submit">Save post</button></form>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument();
          const input = document.querySelector("input[name=slug]") as HTMLInputElement;
          input.value = "short-slug";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForFunction(() => document.querySelector("output")?.textContent === "short-slug");
        const result = await page.evaluate(() => {
          const input = document.querySelector("input[name=slug]") as HTMLInputElement;
          return {
            form: input.form?.id,
            valid: input.checkValidity(),
            output: document.querySelector("output")?.textContent,
            formCount: document.querySelectorAll("form").length,
          };
        });
        assert.deepEqual(result, { form: "post", valid: true, output: "short-slug", formCount: 1 });
      } finally {
        await browser.close();
      }
    });

    it(`${name} scopes component styles to their region`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<style>.projected { background-color: rgb(240, 240, 0); }</style>` +
          `<template component="x-inner" status="early" summary="Inner component.">` +
            `<section class="inner"><div class="inside"><div class="own"><span class="marker"></span></div><slot></slot></div></section>` +
            `<style>:host { border-top: 3px solid rgb(1, 2, 3); } :slotted(.deep) { border-bottom: 2px solid; } .inside { background-color: rgb(0, 120, 0); } .projected, .deep { background-color: rgb(0, 0, 200); } @media all { .inside:has(.own > .marker) { padding-top: 9px; } }</style>` +
          `</template>` +
          `<template component="x-outer" status="early" summary="Outer component.">` +
            `<article><div class="own" required><span class="marker"></span><i class="leaf"></i></div><x-inner class="nested"><em class="projected"><b class="deep">Projected</b></em></x-inner></article>` +
            `<style>:host { color: rgb(12, 34, 56); --inherited-token: inherited; } .own { --bare: yes; } :host .leaf { --descendant: yes; } :host > .own { --child: yes; } article .leaf { --relative: yes; } .own + x-inner { margin-left: 13px; } :host:has(.own > .marker) { padding-left: 11px; } .inside { background-color: rgb(200, 0, 0); } @media all { .own:invalid { border-left: 7px solid rgb(90, 0, 0); } }</style>` +
          `</template>` +
          `<template component="x-base" status="early" summary="Base component.">` +
            `<button><slot></slot></button><style id="base-style">:host { border-right: 4px solid rgb(1, 2, 3); }</style>` +
          `</template>` +
          `<template component="x-primary" status="early" summary="Delegated component.">` +
            `<x-base><slot></slot></x-base><style id="primary-style">:host { padding-right: 6px; }</style>` +
          `</template>` +
          `<x-outer id="outer"></x-outer><x-primary id="delegated">Label</x-primary>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { observeDocument(): () => void } })
            .HtmlRuntime.observeDocument();
        });
        await page.waitForFunction(() => document.querySelector("#outer > section.inner") !== null);
        await page.waitForFunction(() => document.querySelector("#delegated")?.localName === "button");

        const result = await page.evaluate(`(() => {
          const outer = document.querySelector("#outer");
          const own = outer.querySelector(":scope > .own");
          const leaf = own.querySelector(".leaf");
          const nested = outer.querySelector(":scope > section.inner");
          const inside = nested.querySelector(".inside");
          const projected = inside.querySelector(".projected");
          const deep = projected.querySelector(".deep");
          const delegated = document.querySelector("#delegated");
          const value = (element, property) =>
            getComputedStyle(element).getPropertyValue(property).trim();
          return {
            outer: {
              padding: value(outer, "padding-left"),
              color: value(outer, "color"),
              provenance: outer.getAttribute("data-component"),
            },
            own: {
              bare: value(own, "--bare"),
              child: value(own, "--child"),
              invalidBorder: value(own, "border-left-width"),
            },
            leaf: value(leaf, "--descendant"),
            // A selector without :host is relative to the root, so its root type selector never matches.
            relative: value(leaf, "--relative"),
            nested: {
              margin: value(nested, "margin-left"),
              border: value(nested, "border-top-width"),
              provenance: nested.getAttribute("data-component"),
            },
            inside: {
              background: value(inside, "background-color"),
              padding: value(inside, "padding-top"),
              color: value(inside, "color"),
            },
            projected: {
              background: value(projected, "background-color"),
              marker: projected.hasAttribute("data-slotted"),
              color: value(projected, "color"),
            },
            deepBackground: value(deep, "background-color"),
            deepBorder: value(deep, "border-bottom-width"),
            delegated: {
              element: delegated.localName,
              border: value(delegated, "border-right-width"),
              padding: value(delegated, "padding-right"),
              provenance: delegated.getAttribute("data-component"),
              baseStyles: document.querySelectorAll("#base-style").length,
              primaryStyles: document.querySelectorAll("#primary-style").length,
            },
          };
        })()`);

        assert.deepEqual(result, {
          outer: {
            padding: "11px",
            color: "rgb(12, 34, 56)",
            provenance: "x-outer",
          },
          own: { bare: "yes", child: "yes", invalidBorder: "0px" },
          leaf: "yes",
          relative: "",
          nested: {
            // The enclosing component's rules never match a nested component's root.
            margin: "0px",
            border: "3px",
            provenance: "x-inner",
          },
          inside: {
            background: "rgb(0, 120, 0)",
            padding: "9px",
            color: "rgb(12, 34, 56)",
          },
          projected: {
            background: "rgb(240, 240, 0)",
            marker: true,
            color: "rgb(12, 34, 56)",
          },
          deepBackground: "rgba(0, 0, 0, 0)",
          deepBorder: "2px",
          delegated: {
            element: "button",
            border: "4px",
            padding: "6px",
            provenance: "x-primary x-base",
            baseStyles: 1,
            primaryStyles: 1,
          },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} projects named, fallback, and data-selected slots and reconciles public props`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // A root `$match` chooses the native root, and each arm declares the same slots.
        const panelBody = `<header><slot name="title"><h2 class="title-fallback">Untitled</h2></slot></header>` +
          `<output class="label" $value="label"></output><main><slot><p class="body-fallback">Empty</p></slot></main>` +
          `<ul><li $each="row of rows" $key="row.id"><slot from:name="concat('row-', row.id)"><span class="row-fallback" $value="row.id"></span></slot></li></ul>`;
        await page.setContent(
          `<template component="x-panel" status="early" summary="Panel.">` +
            `<defs><state type="list(unknown)" name="rows" value="[{ id: 'a' }, { id: 'b' }]"></state><prop name="label" type="string" default="Panel">Label.</prop>` +
            `<prop name="as" type="keyword" values="section, article" default="section">Root.</prop></defs>` +
            `<template $match><article $when="as = 'article'">${panelBody}</article><section $else>${panelBody}</section></template>` +
          `</template>` +
          `<x-panel id="filled" as="article" label="Initial"><h1 id="title-node" slot="title">Title</h1><p id="body-node">Body</p><strong id="row-node" slot="row-a">A</strong></x-panel>` +
          `<x-panel id="empty"></x-panel>`,
        );
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(async () => {
          const title = document.querySelector('#title-node');
          const body = document.querySelector('#body-node');
          const row = document.querySelector('#row-node');
          window.HtmlRuntime.lowerDocument();
          const filled = document.querySelector('#filled');
          const empty = document.querySelector('#empty');
          const initial = {
            root: filled.localName,
            emptyRoot: empty.localName,
            label: filled.querySelector('.label').textContent,
            titleSame: filled.querySelector('#title-node') === title,
            bodySame: filled.querySelector('#body-node') === body,
            rowSame: filled.querySelector('#row-node') === row,
            projected: [title, body, row].map(node => node.hasAttribute('data-slotted')),
            rows: Array.from(filled.querySelectorAll('li'), item => item.textContent),
            fallbacks: [
              empty.querySelector('.title-fallback')?.textContent,
              empty.querySelector('.body-fallback')?.textContent,
            ],
          };
          const reflectedInitially = filled.getAttribute('data-label');
          const reflectedDefault = empty.hasAttribute('data-label');
          // data-label records the configuration; writing it is not a prop update.
          filled.setAttribute('data-label', 'External');
          await Promise.resolve();
          await Promise.resolve();
          const written = filled.querySelector('.label').textContent;
          window.HtmlRuntime.updateComponentProps(filled, { label: 'Updated' });
          await Promise.resolve();
          await Promise.resolve();
          return {
            initial,
            written,
            updated: {
              label: filled.querySelector('.label').textContent,
              rows: Array.from(filled.querySelectorAll('li'), item => item.textContent),
              reflectedLabel: filled.getAttribute('data-label'),
              reflectedInitially,
              reflectedDefault,
              ownLabelProperty: Object.hasOwn(filled, 'label'),
            },
          };
        })()`);

        assert.deepEqual(result, {
          initial: {
            root: "article",
            emptyRoot: "section",
            label: "Initial",
            titleSame: true,
            bodySame: true,
            rowSame: true,
            projected: [true, true, true],
            rows: ["A", "b"],
            fallbacks: ["Untitled", "Empty"],
          },
          written: "Initial",
          updated: {
            label: "Updated",
            rows: ["A", "b"],
            reflectedLabel: "Updated",
            reflectedInitially: "Initial",
            reflectedDefault: false,
            ownLabelProperty: false,
          },
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a real-element root \`$match\` wrapper while switching its child`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<template component="x-root-choice" status="early" summary="Root choice."><defs>
          <state name="kind" value="a"></state>
          <handler name="toggle"><set name="kind" expr:value="kind = 'a' ? 'b' : 'a'"></set></handler></defs>
          <section $match="kind as choice" class="choice" from:data-kind="kind" on:click="toggle">
            <p $when="choice = 'a'">First</p><p $else>Second</p>
          </section></template><main><x-root-choice id="case"></x-root-choice></main>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const root = document.querySelector('#case');
          const before = [root.localName, root.getAttribute('data-kind'), root.querySelector('p')?.textContent];
          const server = document.createElement('main');
          server.setHTMLUnsafe(window.HtmlRuntime.serializeRenderedForm(root.parentElement));
          document.body.append(server);
          const adoptedRoot = server.querySelector('#case');
          const adoptedChild = adoptedRoot.querySelector('p');
          window.HtmlRuntime.lowerDocument();
          const hydration = { rootKept: server.querySelector('#case') === adoptedRoot,
            childKept: adoptedRoot.querySelector('p') === adoptedChild,
            child: adoptedRoot.querySelector('p')?.textContent };
          root.click();
          adoptedRoot.click();
          await new Promise((resolve) => setTimeout(resolve));
          const after = [root.localName, root.getAttribute('data-kind'), root.querySelector('p')?.textContent];
          return { before, after, kept: document.querySelector('#case') === root,
            host: window.HtmlRuntime.getComponentHost(root)?.root === root, hydration,
            hydratedAfter: adoptedRoot.querySelector('p')?.textContent };
        })()`);
        assert.deepEqual(result, {
          before: ["section", "a", "First"], after: ["section", "b", "Second"], kept: true, host: true,
          hydration: { rootKept: true, childKept: true, child: "First" }, hydratedAfter: "Second",
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} replaces a root \`$match\` arm's element when its props choose another`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const body = `<slot></slot><output $value="count"></output>`;
        await page.setContent(
          `<template component="x-action" status="early" summary="Button or link.">` +
            `<defs><prop name="as" type="keyword" values="button, a" default="button">Root.</prop><prop name="href" type="string">Link.</prop>` +
            `<state type="number" name="count" value="0"></state><handler name="bump"><set name="count" expr:value="count + 1"></set></handler></defs>` +
            `<template $match><a $when="as = 'a'" class="action" from:href="href" on:click="bump" $ref="control">${body}</a>` +
            `<button $else class="action" type="button" .title="'Save'" style="cursor: pointer; margin: 1px" style:--tone="as" on:click="bump" $ref="control">${body}</button></template>` +
          `</template>` +
          `<x-action id="action" class="consumer" style="color: rgb(255, 0, 0)" href="#next"><b id="label">Go</b></x-action>`,
        );
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(async () => {
          const settle = () => new Promise((resolve) => setTimeout(resolve));
          const runtime = window.HtmlRuntime;
          const label = document.querySelector('#label');
          runtime.lowerDocument();
          const describe = (element) => ({
            tag: element.localName,
            id: element.id,
            className: element.className,
            component: element.getAttribute('data-component'),
            href: element.getAttribute('href'),
            dataHref: element.getAttribute('data-href'),
            type: element.getAttribute('type'),
            title: element.getAttribute('title'),
            count: element.querySelector('output').textContent,
            // The consumer's inline style carries over; the button arm's own does not.
            style: [element.style.color, element.style.cursor, element.style.marginTop, element.style.getPropertyValue('--tone')],
            label: element.querySelector('#label') === label,
            host: runtime.getComponentHost(element)?.root === element,
          });
          const button = document.querySelector('#action');
          const stopObservation = runtime.observeDocument();
          const host = runtime.getComponentHost(button);
          let nativeClicks = 0;
          const stopListening = host.effect(() => {
            const root = host.root;
            const onClick = () => { nativeClicks += 1; };
            root.addEventListener('click', onClick);
            return () => root.removeEventListener('click', onClick);
          });
          await settle();
          button.click();
          await settle();
          const before = describe(button);
          runtime.updateComponentProps(button, { as: 'a' });
          await settle();
          const link = document.querySelector('#action');
          link.click();
          await settle();
          const linked = { ...describe(link), replaced: !button.isConnected, dataAs: link.getAttribute('data-as') };
          runtime.updateComponentProps(link, { as: undefined });
          await settle();
          const back = document.querySelector('#action');
          back.click();
          await settle();
          const final = describe(back);
          stopListening();
          stopObservation();
          return { before, linked, back: final, nativeClicks };
        })()`);

        const common = { id: "action", className: "action consumer", component: "x-action", dataHref: "#next", label: true, host: true };
        assert.deepEqual(result, {
          before: { ...common, tag: "button", href: null, type: "button", title: "Save", count: "1", style: ["rgb(255, 0, 0)", "pointer", "1px", "button"] },
          // State, the handler, slot content, invocation attributes, and the instance all move to the new root.
          linked: { ...common, tag: "a", href: "#next", type: null, title: null, count: "2", replaced: true, dataAs: "a", style: ["rgb(255, 0, 0)", "", "", ""] },
          back: { ...common, tag: "button", href: null, type: "button", title: "Save", count: "3", style: ["rgb(255, 0, 0)", "pointer", "1px", "button"] },
          nativeClicks: 3,
        });
        assert.deepEqual(pageErrors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} switches a root \`$match\` arm from state a handler sets`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const toggle = (label: string) => `<button type="button" on:click="toggle">${label}</button><slot></slot>`;
        await page.setContent(
          `<template component="x-disclosure" status="early" summary="Disclosure.">` +
            `<defs><state type="boolean" name="open" value="false"></state><handler name="toggle"><set name="open" expr:value="not open"></set></handler></defs>` +
            `<template $match><section $when="open">${toggle("Close")}</section><div $else>${toggle("Open")}</div></template>` +
          `</template>` +
          `<x-disclosure id="disclosure"><p id="body">Body</p></x-disclosure>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const settle = () => new Promise((resolve) => setTimeout(resolve));
          const body = document.querySelector('#body');
          window.HtmlRuntime.lowerDocument();
          // Focus stays on the toggle, which the switch replaces with the new arm's toggle.
          const read = () => {
            const root = document.querySelector('#disclosure');
            const button = root.querySelector('button');
            return [root.localName, button.textContent, root.querySelector('#body') === body, document.activeElement === button];
          };
          const states = [read()];
          for (let index = 0; index < 2; index += 1) {
            document.querySelector('#disclosure button').focus();
            document.querySelector('#disclosure button').click();
            await settle();
            states.push(read());
          }
          return states;
        })()`);
        assert.deepEqual(result, [["div", "Open", true, false], ["section", "Close", true, true], ["div", "Open", true, true]]);
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a parent's bindings and a consumer's overrides on a child whose root switches`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.setContent(
          `<template component="x-choice" status="early" summary="Button or link.">` +
            `<defs><prop name="as" type="keyword" values="button, a" default="button">Root.</prop></defs>` +
            `<template $match><a $when="as = 'a'" href="#next"><slot></slot></a><button $else type="button"><slot></slot></button></template>` +
          `</template>` +
          `<template component="x-host" status="early" summary="Parent.">` +
            `<defs><state type="boolean" name="linked" value="false"></state><state type="number" name="clicks" value="0"></state>` +
            `<handler name="flip"><set name="clicks" expr:value="clicks + 1"></set><set name="linked" expr:value="not linked"></set></handler></defs>` +
            `<section><x-choice id="choice" type="submit" from:as="{ true: 'a', false: 'button' }[concat(linked)]" on:click="flip">Go</x-choice>` +
            `<output $value="clicks"></output></section>` +
          `</template>` +
          `<x-host></x-host>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const settle = () => new Promise((resolve) => setTimeout(resolve));
          window.HtmlRuntime.lowerDocument();
          await settle();
          const read = () => {
            const choice = document.querySelector('#choice');
            return [choice.localName, choice.getAttribute('type'), choice.getAttribute('data-as'), document.querySelector('output').textContent];
          };
          const states = [read()];
          for (let index = 0; index < 3; index += 1) {
            document.querySelector('#choice').addEventListener('click', (event) => event.preventDefault());
            document.querySelector('#choice').click();
            await settle();
            states.push(read());
          }
          return states;
        })()`);
        // The parent's on:click follows the root, its :as binding reaches the current root's
        // record, and the consumer's type="submit" outlasts the button arm's own type="button".
        assert.deepEqual(result, [
          ["button", "submit", "button", "0"],
          ["a", "submit", "a", "1"],
          ["button", "submit", "button", "2"],
          ["a", "submit", "a", "3"],
        ]);
        assert.deepEqual(pageErrors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} stops everything the old arm owned when a root switches`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const arm = `<i $if="show" $value="n"></i>`;
        await page.setContent(
          `<template component="x-owned" status="early" summary="Ownership.">` +
            `<defs><state type="boolean" name="linked" value="false"></state><state type="boolean" name="show" value="true"></state>` +
            `<state type="number" name="n" value="0"></state></defs>` +
            `<template $match><a $when="linked" href="#x">${arm}</a><div $else>${arm}</div></template>` +
          `</template>` +
          `<main><x-owned id="owned"></x-owned></main>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const settle = () => new Promise((resolve) => setTimeout(resolve));
          window.HtmlRuntime.observeDocument();
          await settle();
          const root = () => document.querySelector('#owned');
          const { state } = window.HtmlRuntime.getComponentHost(root());
          // A $if that re-renders after the first render creates effects the arm still owns.
          state.show = false;
          await settle();
          state.show = true;
          await settle();
          const old = root().querySelector('i');
          state.linked = true;
          await settle();
          state.n = 42;
          await settle();
          const values = [old.textContent, root().querySelector('i').textContent];
          state.linked = false;
          await settle();
          return { values, root: root().localName };
        })()`);
        // The detached <i> stops updating while the newly selected arm takes ownership.
        assert.deepEqual(result, { values: ["0", "42"], root: "div" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a delegating parent's instance when its polymorphic root switches`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const toggle = (label: string) => `<button type="button" on:click="toggle">${label}</button><slot></slot>`;
        await page.setContent(
          `<template component="x-fold" status="early" summary="Polymorphic.">` +
            `<defs><state type="boolean" name="open" value="false"></state><handler name="toggle"><set name="open" expr:value="not open"></set></handler></defs>` +
            `<template $match><section $when="open">${toggle("Close")}</section><div $else>${toggle("Open")}</div></template>` +
          `</template>` +
          `<template component="x-card" status="early" summary="Delegates.">` +
            `<defs><prop name="tone" type="keyword" values="warm, cool" default="warm">Tone.</prop></defs>` +
            `<x-fold><output $value="tone"></output></x-fold>` +
          `</template>` +
          `<x-card id="card" tone="warm"></x-card>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const settle = () => new Promise((resolve) => setTimeout(resolve));
          window.HtmlRuntime.lowerDocument();
          await settle();
          const before = document.querySelector('#card');
          before.querySelector('button').click();
          await settle();
          const root = document.querySelector('#card');
          window.HtmlRuntime.updateComponentProps(root, { tone: 'cool' });
          await settle();
          return {
            tags: [before.localName, root.localName],
            component: root.getAttribute('data-component'),
            tone: [root.querySelector('output').textContent, root.getAttribute('data-tone')],
            host: window.HtmlRuntime.getComponentHost(root) !== undefined,
          };
        })()`);
        assert.deepEqual(result, {
          tags: ["div", "section"],
          component: "x-card x-fold",
          tone: ["cool", "cool"],
          host: true,
        });
        assert.deepEqual(pageErrors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} parses structured props from JSON attributes and reflects only explicit ones`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.setContent(
          `<template component="x-tags" status="early" summary="Structured props.">` +
            `<defs><prop name="tags" type="list(string)" default='["none"]'>Tags.</prop></defs>` +
            `<ul><li $each="tag of tags" $key="tag" $value="tag"></li></ul></template>` +
          `<x-tags id="authored" tags='["design","docs"]'></x-tags><x-tags id="default"></x-tags>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.lowerDocument();
          const authored = document.getElementById("authored");
          const fallback = document.getElementById("default");
          const read = (root) => Array.from(root.querySelectorAll("li"), (item) => item.textContent);
          const initial = {
            authored: read(authored),
            reflected: authored.getAttribute("data-tags"),
            fallback: read(fallback),
            fallbackReflected: fallback.hasAttribute("data-tags"),
          };
          // data-tags records the configuration; writing it is not a prop update.
          authored.setAttribute("data-tags", '["api"]');
          await new Promise((resolve) => setTimeout(resolve, 0));
          const written = read(authored);
          window.HtmlRuntime.updateComponentProps(authored, { tags: ["api"] });
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, written, updated: read(authored) };
        })()`);
        assert.deepEqual(result, {
          initial: {
            authored: ["design", "docs"],
            reflected: '["design","docs"]',
            fallback: ["none"],
            fallbackReflected: false,
          },
          written: ["design", "docs"],
          updated: ["api"],
        });
        assert.deepEqual(pageErrors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${name} maps camel-case public props to kebab-case HTML attributes`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-camel" status="early" summary="Camel-case props.">` +
            `<defs><prop name="defaultValue" type="string" default="fallback">Default value.</prop></defs>` +
            `<output from:data-default="defaultValue"></output></template>` +
          `<x-camel id="camel" default-value="authored"></x-camel>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          const root = document.getElementById("camel") as Element;
          return {
            ownProperty: Object.hasOwn(root, "defaultValue"),
            rendered: root.getAttribute("data-default"),
            reflected: root.getAttribute("data-default-value"),
            legacyReflection: root.hasAttribute("data-defaultvalue"),
          };
        });
        assert.deepEqual(result, {
          ownProperty: false,
          rendered: "authored",
          reflected: "authored",
          legacyReflection: false,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name} preserves nested projected invocations independent of definition order`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-nested-child" status="early" summary="Child."><button><slot></slot></button></template>` +
          `<template component="x-nested-parent" status="early" summary="Parent."><section><slot></slot></section></template>` +
          `<x-nested-parent id="parent"><x-nested-child id="child"><span id="label">Label</span></x-nested-child></x-nested-parent>`,
        );
        const label = await page.$("#label");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          return {
            parent: document.getElementById("parent")?.localName,
            child: document.getElementById("child")?.localName,
            text: document.getElementById("child")?.textContent,
          };
        });
        assert.deepEqual(result, { parent: "section", child: "button", text: "Label" });
        assert.equal(await label?.evaluate((node) => node === document.getElementById("label")), true);
      } finally {
        await browser.close();
      }
    });

    it(`${name} keeps a prop value when a component event has the same name`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-openable" status="early" summary="Openable.">` +
            `<defs><prop name="open" type="boolean">Open state.</prop><event name="open" type="boolean"></event></defs>` +
            `<section from:data-open="open"></section></template><x-openable id="openable" open></x-openable>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
          const root = document.getElementById("openable") as Element;
          return { ownProperty: Object.hasOwn(root, "open"), attribute: root.getAttribute("data-open") };
        });
        assert.deepEqual(result, { ownProperty: false, attribute: "true" });
      } finally {
        await browser.close();
      }
    });

    it(`${name} adopts compatible server DOM, repairs owned markup, and preserves live controls`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<template component="x-hydrated" status="early" summary="Hydration.">` +
            `<defs><prop name="label" type="string" default="Default">Label.</prop></defs>` +
            `<article><h2 $value="label"></h2><input .value="label"><slot></slot></article></template>` +
          `<article id="server" data-component="x-hydrated" data-label="Server">` +
            `<h3>stale</h3>` +
            `<input value="server"><?start slot=""?><em id="projected" data-slotted>Projected</em><?end?>` +
          `</article>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const root = document.querySelector('#server');
          const input = root.querySelector('input');
          const projected = root.querySelector('#projected');
          input.value = 'user edit';
          input.focus();
          input.setSelectionRange(2, 6);
          const lowered = window.HtmlRuntime.lowerDocument();
          const initial = {
            lowered,
            rootSame: document.querySelector('#server') === root,
            inputSame: root.querySelector('input') === input,
            projectedSame: root.querySelector('#projected') === projected,
            heading: root.querySelector('h2')?.textContent,
            staleGone: root.querySelector('h3') === null,
            value: input.value,
            focused: document.activeElement === input,
            selection: [input.selectionStart, input.selectionEnd],
          };
          window.HtmlRuntime.updateComponentProps(root, { label: 'Next' });
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { initial, updated: { heading: root.querySelector('h2').textContent, value: input.value } };
        })()`);
        assert.deepEqual(result, {
          initial: {
            lowered: 1,
            rootSame: true,
            inputSame: true,
            projectedSame: true,
            heading: "Server",
            staleGone: true,
            value: "user edit",
            focused: true,
            selection: [2, 6],
          },
          updated: { heading: "Next", value: "Next" },
        });

        const unsafe = await browser.newPage();
        await unsafe.setContent(
          `<template component="x-safe-root" status="early" summary="Safe root."><article>Expected</article></template>` +
          `<section id="unsafe" data-component="x-safe-root">Untouched</section>`,
        );
        await unsafe.addScriptTag({ path: bundlePath });
        const rejected = await unsafe.evaluate(`(() => {
          const root = document.querySelector('#unsafe');
          try { window.HtmlRuntime.lowerDocument(); }
          catch (error) { return { code: error.diagnostic.code, same: document.querySelector('#unsafe') === root, text: root.textContent }; }
          return { code: 'none', same: false, text: '' };
        })()`);
        assert.deepEqual(rejected, { code: "HR005", same: true, text: "Untouched" });
        await unsafe.close();
      } finally {
        await browser.close();
      }
    });

    it(`${name} lowers definitions to equivalent native DOM`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(source);
        await page.addScriptTag({ path: bundlePath });

        const result = await page.evaluate(`(() => {
          const keptChild = document.querySelector("#kept-child");
          const lowered = window.HtmlRuntime.lowerDocument();

          function snapshot(element) {
            return {
              namespace: element.namespaceURI,
              tag: element.localName,
              attributes: Array.from(element.attributes)
                .map((attribute) => [attribute.name, attribute.value])
                .sort(([left], [right]) => left.localeCompare(right)),
              // Rendered-form markers (PIs, or comments where PIs are not parsed) are not public DOM.
              children: Array.from(element.childNodes).filter((child) =>
                child.nodeType !== Node.PROCESSING_INSTRUCTION_NODE && child.nodeType !== Node.COMMENT_NODE,
              ).map((child) =>
                child.nodeType === Node.TEXT_NODE
                  ? { text: child.textContent }
                  : snapshot(child),
              ),
            };
          }

          const primary = document.querySelector("main > #primary");
          const disabled = document.querySelector("main > #disabled");
          const status = document.querySelector("main > #status");
          if (!(primary instanceof HTMLButtonElement)) throw new Error("Primary button was not lowered.");
          if (!(disabled instanceof HTMLButtonElement)) throw new Error("Disabled button was not lowered.");
          if (!(status instanceof HTMLOutputElement)) throw new Error("Status output was not lowered.");

          return {
            lowered,
            primary: snapshot(primary),
            disabled: snapshot(disabled),
            status: snapshot(status),
            primaryDisabled: primary.disabled,
            disabledDisabled: disabled.disabled,
            statusTextContent: status.textContent,
            childIdentityPreserved: primary.querySelector("#kept-child") === keptChild,
            definitionsRemaining: document.querySelectorAll("template[component]").length,
            invocationHostsRemaining: document.querySelectorAll("x-button, x-status").length,
            customElementRegistered: customElements.get("x-button") !== undefined,
          };
        })()`);

        assert.deepEqual(result, {
          lowered: 3,
          primary: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "button",
            attributes: [
              ["aria-label", "Save changes"],
              ["class", "cta"],
              ["data-component", "x-button"],
              // `disabled` was not set by the author and the template does not bind data-disabled.
              ["data-size", "lg"],
              ["data-trace", "runtime"],
              ["data-variant", "outline"],
              ["data-x-button", ""],
              ["id", "primary"],
              // The author's attribute wins over the template's literal.
              ["type", "submit"],
            ],
            children: [
              { text: "Save " },
              {
                namespace: "http://www.w3.org/1999/xhtml",
                tag: "strong",
                attributes: [["data-slotted", ""], ["id", "kept-child"]],
                children: [{ text: "now" }],
              },
            ],
          },
          disabled: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "button",
            attributes: [
              ["data-component", "x-button"],
              ["data-disabled", "true"],
              ["data-size", "md"],
              ["data-variant", "solid"],
              ["data-x-button", ""],
              ["disabled", ""],
              ["id", "disabled"],
              ["type", "button"],
            ],
            children: [],
          },
          status: {
            namespace: "http://www.w3.org/1999/xhtml",
            tag: "output",
            attributes: [
              ["data-component", "x-status"],
              ["data-message", "Ready"],
              ["id", "status"],
            ],
            children: [{ text: "Ready" }],
          },
          primaryDisabled: false,
          disabledDisabled: true,
          statusTextContent: "Ready",
          childIdentityPreserved: true,
          definitionsRemaining: 0,
          invocationHostsRemaining: 0,
          customElementRegistered: false,
        });
      } finally {
        await browser.close();
      }
    });
  }
});
