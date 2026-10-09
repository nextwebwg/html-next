import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileStyle, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { generateVueComponent, vueHostArtifact, vueHtmlArtifact, vueControlArtifact, vuePropsArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import type { ComponentDefinition } from "../src/template.js";
import { cases as conformanceCases } from "./conformance/cases.js";
import { assertPixelsEqual, launchParityBrowser } from "./pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;
const livePath = new URL("../src/live.ts", import.meta.url).pathname;
const validationAlias = { "@nextwebwg/html-next/validation": new URL("../src/validation.ts", import.meta.url).pathname };

interface ParityCase {
  readonly name: string;
  readonly features: readonly string[];
  readonly definitions: Readonly<Record<string, string>>;
  readonly invocation: string;
  readonly vueRender: string;
  readonly root: string;
  readonly probe: string;
  readonly action: string;
  readonly expectedAfter?: unknown;
  readonly mockData?: "instant" | "stale" | "invalid";
  readonly beforeReady?: string;
  readonly afterReady?: string;
  readonly settleAfterMs?: number;
}

import { formattingSource, formattingProbe } from "./formatting-fixture.js";

const cases: readonly ParityCase[] = [
  {
    name: "SVG class rules stay inside owned scope with inherited and explicit projected fills",
    features: ["scoped styles", "SVG", "slots", "inheritance"],
    definitions: {
      "x-svg-boundary": `<template component="x-svg-boundary"><div><svg><rect class="shape" width="10" height="10"></rect></svg><slot></slot></div>
        <style>:host { fill: green; } .shape { fill: red; } :slotted(.styled) { fill: blue; }</style></template>`,
    },
    invocation: '<x-svg-boundary id="case"><svg><rect class="shape" width="10" height="10"></rect><rect class="shape styled" x="20" width="10" height="10"></rect></svg></x-svg-boundary>',
    vueRender: 'h(XSvgBoundary, { id: "case" }, { default: () => h("svg", {}, [h("rect", { class: "shape", width: 10, height: 10 }), h("rect", { class: "shape styled", x: 20, width: 10, height: 10 })]) })',
    root: '#case',
    probe: `Array.from(root.querySelectorAll('rect'), node => getComputedStyle(node).fill)`,
    action: `root.setAttribute('data-probe', 'done')`,
    expectedAfter: ['rgb(255, 0, 0)', 'rgb(0, 128, 0)', 'rgb(0, 0, 255)'],
  },
  {
    name: "delegated roots retain explicit host selectors and exclude ordinary root selectors",
    features: ["scoped styles", "delegated root", "host pseudo-elements"],
    definitions: {
      "x-leaf-boundary": `<template component="x-leaf-boundary"><article class="ordinary">Leaf</article></template>`,
      "x-delegated-boundary": `<template component="x-delegated-boundary"><x-leaf-boundary></x-leaf-boundary><style>
        :host, :host::before { box-sizing: border-box; }
        *, *::after { box-sizing: border-box; }
        article, .ordinary { outline: 7px solid; }
      </style></template>`,
    },
    invocation: `<x-delegated-boundary id="case"></x-delegated-boundary>`,
    vueRender: `h(XDelegatedBoundary, { id: "case" })`,
    root: "#case",
    probe: `({ box: getComputedStyle(root).boxSizing, before: getComputedStyle(root, '::before').boxSizing, after: getComputedStyle(root, '::after').boxSizing, outline: getComputedStyle(root).outlineStyle })`,
    action: `root.setAttribute('data-probe', 'done')`,
    expectedAfter: { box: "border-box", before: "border-box", after: "content-box", outline: "none" },
  },
  ...[false, true].map((explicit): ParityCase => ({
    name: `ordinary selectors exclude roots and nested components${explicit ? " with explicit host pseudos" : ""}`,
    features: ["scoped styles", "host", "pseudo-elements", "nested components", "slots"],
    definitions: {
      "x-boundary-child": `<template component="x-boundary-child"><article><span class="nested">Nested</span></article></template>`,
      "x-boundary": `<template component="x-boundary"><article class="ordinary"><span class="owned">Owned</span><x-boundary-child></x-boundary-child><slot></slot></article>
        <style>:host, *, *::before, *::after { box-sizing: border-box; }
        article, .ordinary { outline: 7px solid; }
        ${explicit ? ":host::before, :host::after { box-sizing: border-box; }" : ""}
        :slotted(.projected) { border-top: 9px solid; }</style></template>`,
    },
    invocation: `<x-boundary id="case"><span class="projected">Projected</span></x-boundary>`,
    vueRender: `h(XBoundary, { id: "case" }, { default: () => h("span", { class: "projected" }, "Projected") })`,
    root: "#case",
    probe: `Array.from([root, root.querySelector('.owned'), root.querySelector('[data-component~=x-boundary-child]'), root.querySelector('.nested'), root.querySelector('.projected')], node => ({ box: getComputedStyle(node).boxSizing, before: getComputedStyle(node, '::before').boxSizing, after: getComputedStyle(node, '::after').boxSizing, outline: getComputedStyle(node).outlineStyle, border: getComputedStyle(node).borderTopWidth }))`,
    action: `root.setAttribute('data-probe', 'done')`,
    expectedAfter: [
      { box: "border-box", before: explicit ? "border-box" : "content-box", after: explicit ? "border-box" : "content-box", outline: "none", border: "0px" },
      { box: "border-box", before: "border-box", after: "border-box", outline: "none", border: "0px" },
      { box: "content-box", before: "content-box", after: "content-box", outline: "none", border: "0px" },
      { box: "content-box", before: "content-box", after: "content-box", outline: "none", border: "0px" },
      { box: "content-box", before: "content-box", after: "content-box", outline: "none", border: "9px" },
    ],
  })),
  ...[false, true].map((selected): ParityCase => ({
    name: `absent component values preserve native select ${selected ? "authored selection" : "first-option selection"}`,
    features: ["optional value prop", "native selection", "projected options", "change event"],
    definitions: {
      "x-native-select": `<template component="x-native-select"><defs><prop name="value" type="string">Optional selection.</prop></defs><select from:value="$value"><slot></slot></select></template>`,
    },
    invocation: `<x-native-select id="case"><option value="a">A</option><option value="b"${selected ? " selected" : ""}>B</option></x-native-select>`,
    vueRender: `h(XNativeSelect, { id: "case" }, { default: () => [h("option", { value: "a" }, "A"), h("option", { value: "b"${selected ? ", selected: true" : ""} }, "B")] })`,
    root: "#case",
    probe: `({ value: root.value, defaults: Array.from(root.options, option => option.defaultSelected) })`,
    beforeReady: `document.querySelector('#case')?.value === '${selected ? "b" : "a"}'`,
    action: `root.value = '${selected ? "a" : "b"}'; root.dispatchEvent(new Event('change', { bubbles: true }));`,
    expectedAfter: { value: selected ? "a" : "b", defaults: [false, selected] },
  })),
  {
    name: "Intl expressions infer declared types and preserve locale overrides",
    features: ["format", "inference", "locale", "text expressions"],
    definitions: { "x-formatting": formattingSource },
    invocation: `<x-formatting id="case"></x-formatting>`,
    vueRender: `h(XFormatting, { id: "case" })`,
    root: "#case",
    probe: formattingProbe,
    action: `root.querySelector("button").click(); root.querySelectorAll("button")[1].click()`,
  },
  {
    name: "inline and value row formatters retain invalid results across keyed moves",
    features: ["inline text", "$value", "format", "keyed lists", "invalid-result retention"],
    definitions: { "x-row-format": `<template component="x-row-format"><defs>
      <state name="rows" type="list(object({ id: number, amount: number, currency: string }))" value="[{ id: 1, amount: 12, currency: 'USD' }, { id: 2, amount: 24, currency: 'USD' }]"></state>
      <handler name="change"><set name="rows" expr:value="[{ id: 2, amount: 99, currency: 'invalid' }, { id: 1, amount: 18, currency: 'USD' }]"></set></handler>
      </defs><section><button on:click="change">Next</button><ul><li $each="row of $rows" $key="$row.id">
      <span class="inline">{format($row.amount, 'currency', { currency: $row.currency }, 'en-US')}</span>
      <span class="value" $value="format($row.amount, 'currency', { currency: $row.currency }, 'en-US')"></span>
      <span class="mixed">Total: {format($row.amount, 'currency', { currency: $row.currency }, 'en-US')}!</span>
      </li></ul></section></template>` },
    invocation: `<x-row-format id="case"></x-row-format>`, vueRender: `h(XRowFormat, { id: "case" })`, root: "#case",
    probe: `Array.from(root.querySelectorAll('li'), row => Array.from(row.querySelectorAll('span'), span => span.textContent))`,
    action: `root.querySelector('button').click()`,
    expectedAfter: [["$24.00", "$24.00", "Total: $24.00!"], ["$18.00", "$18.00", "Total: $18.00!"]],
  },
  {
    name: "braced inline expressions preserve mixed content and keyed table rows",
    features: ["inline text", "keyed lists", "case-sensitive names"],
    definitions: { "x-inline": String.raw`<template component="x-inline"><defs>
      <state name="rows" type="list(object({ id: number, name: string }))" value="[{ id: 1, name: 'Ada' }, { id: 2, name: 'Bea' }]"></state>
      <state name="Name" type="string" value="Upper"></state><state name="name" type="string" value="lower"></state>
      <handler name="change"><set name="rows" expr:value="[{ id: 2, name: 'Bea' }, { id: 1, name: '&lt;i&gt;Lin&lt;/i&gt;' }]"></set></handler>
      </defs><section><button type="button" on:click="change">Next</button><p>{$Name}/{$name}. $literal costs $1.15.</p>
      <table><tbody><tr $each="r of $rows" $key="$r.id"><td>Hello {$r.name}!</td></tr></tbody></table></section></template>` },
    invocation: `<x-inline id="case"></x-inline>`, vueRender: `h(XInline, { id: "case" })`, root: "#case",
    probe: `({ text: root.querySelector('p')?.textContent, rows: Array.from(root.querySelectorAll('td'), (td) => td.textContent), markup: root.querySelector('i') !== null })`,
    action: `root.querySelector('button').click()`,
    expectedAfter: { text: "Upper/lower. $literal costs $1.15.", rows: ["Hello Bea!", "Hello <i>Lin</i>!"], markup: false },
  },
  {
    name: "props, passthrough attributes, slots, and scoped styles",
    features: ["props", "attribute bindings", "attribute passthrough", "slots", "scoped styles"],
    definitions: {
      "x-card": `<template component="x-card" status="early" summary="Parity card.">
        <defs><prop name="label" type="string" default="Ready">Label.</prop></defs>
        <article class="base" from:aria-label="$label"><slot><strong>Fallback</strong></slot></article>
        <style>:host { display: block; padding: 6px; background: rgb(220 235 250); } :host > strong { color: rgb(10 50 90); }</style>
      </template>`,
    },
    invocation: `<x-card id="case" class="consumer" label="Save"><strong>Now</strong></x-card>`,
    vueRender: `h(XCard, { id: "case", class: "consumer", label: "Save" }, { default: () => h("strong", "Now") })`,
    root: "#case",
    probe: `({ tag: root.localName, label: root.getAttribute("aria-label"), className: root.className, text: root.textContent?.trim(), background: getComputedStyle(root).backgroundColor, childColor: getComputedStyle(root.querySelector("strong")).color })`,
    action: `root.setAttribute("data-probe", "untouched")`,
  },
  {
    name: "state, computed output, handlers, and typed events",
    features: ["state", "computed", "$value", "handlers", "typed events"],
    definitions: {
      "x-counter": `<template component="x-counter" status="early" summary="Parity counter.">
        <defs><state type="number" name="count" value="0"></state><computed name="double" from="$count * 2"></computed>
        <event name="count-change" type="number"></event>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set><dispatch event="count-change" expr:value="$count"></dispatch></handler></defs>
        <button type="button" on:click="increment" from:aria-label="concat('Count ', $count)"><output $value="$double"></output></button>
      </template>`,
    },
    invocation: `<x-counter id="case"></x-counter>`,
    vueRender: `h(XCounter, { id: "case", onCountChange: event => window.parityEvents.push(event.detail) })`,
    root: "#case",
    probe: `({ tag: root.localName, label: root.getAttribute("aria-label"), output: root.querySelector("output")?.textContent, events: window.parityEvents })`,
    action: `root.click()`,
    expectedAfter: { tag: "button", label: "Count 1", output: "2", events: [1] },
  },
  {
    name: "literal and computed bracket indexes update after Vue conversion",
    features: ["bracketed indexes", "computed indexes", "state"],
    definitions: {
      "x-bracket-index": `<template component="x-bracket-index" status="early" summary="Index parity fixture.">
        <defs>
          <state name="items" type="list(string)" value="['Ada', 'Bea']"></state>
          <state name="selected" type="integer" value="0"></state>
          <handler name="next"><set name="selected" value="1"></set></handler>
        </defs>
        <button type="button" on:click="next"><output $value="concat($items[0], '/', $items[$selected])"></output></button>
      </template>`,
    },
    invocation: `<x-bracket-index id="case"></x-bracket-index>`,
    vueRender: `h(XBracketIndex, { id: "case" })`,
    root: "#case",
    probe: `({ text: root.querySelector("output")?.textContent })`,
    action: `root.click()`,
    expectedAfter: { text: "Ada/Bea" },
  },
  {
    name: "expression functions preserve written units and update reactively",
    features: ["dimension math", "default", "concat", "join"],
    definitions: {
      "x-measure": `<template component="x-measure" status="early" summary="Expression parity fixture.">
        <defs>
          <prop name="label" type="string">Optional label.</prop>
          <state name="width" type="length" value="8.8px"></state>
          <state name="parts" type="list(string)" value="['a', 'b']"></state>
          <computed name="rounded" from="round($width)"></computed>
          <computed name="description" from="concat(default($label, 'Size'), ': ', $rounded, '/', round($width, 0.5px), '/', min($rounded, 10px), '/', max($width, 1px), '/', clamp(1px, $width, 4px), '/', abs(-2px), ' / ', join($parts, ', '))"></computed>
          <handler name="change"><set name="width" value="2.2px"></set></handler>
        </defs>
        <button type="button" on:click="change"><output $value="$description"></output></button>
      </template>`,
    },
    invocation: `<x-measure id="case"></x-measure>`,
    vueRender: `h(XMeasure, { id: "case" })`,
    root: "#case",
    probe: `({ output: root.querySelector("output")?.textContent })`,
    action: `root.click()`,
    expectedAfter: { output: "Size: 2px/2px/2px/2.2px/2.2px/2px / a, b" },
  },
  {
    name: "a mismatched reactive unit keeps the last accepted result",
    features: ["dimension validation", "live binding retention"],
    definitions: {
      "x-unit-guard": `<template component="x-unit-guard" status="early" summary="Unit validation fixture.">
        <defs>
          <state name="width" type="length" value="8.8px"></state>
          <state name="step" type="length" value="1px"></state>
          <state name="saved" type="length" value="5px"></state>
          <computed name="snapped" from="round($width, $step)"></computed>
          <handler name="badStep"><set name="step" value="1rem"></set></handler>
          <handler name="goodStep"><set name="step" value="2px"></set></handler>
          <handler name="save"><set name="saved" expr:value="round($width, $step)"></set></handler>
        </defs>
        <section style:--snapped="round($width, $step)" class:valid="round($width, $step)" class:from-object="{ value: round($width, $step) }.value = '9px'" from:data-array="['x', round($width, $step)]"><button class="bad" on:click="badStep">Bad</button><button class="good" on:click="goodStep">Good</button><button class="save" on:click="save">Save</button>
          <output class="computed" $value="$snapped"></output><output class="direct" $value="round($width, $step)"></output><output class="array" $value="['x', round($width, $step)]"></output><output class="fallback" $value="default(round($width, $step), 1px)"></output><output class="saved" $value="$saved"></output><output class="comparison" $value="round($width, $step) = 9px"></output><i $if="round($width, $step) = 9px">Ready</i><template $match><em $when="round($width, $step) = 9px">Nine</em><b $else>Other</b></template></section>
      </template>`,
    },
    invocation: `<x-unit-guard id="case"></x-unit-guard>`,
    vueRender: `h(XUnitGuard, { id: "case" })`,
    root: "#case",
    probe: `({ computed: root.querySelector(".computed")?.textContent, direct: root.querySelector(".direct")?.textContent, array: root.getAttribute('data-array'), arrayText: root.querySelector('.array')?.textContent, fallback: root.querySelector(".fallback")?.textContent, saved: root.querySelector(".saved")?.textContent, comparison: root.querySelector(".comparison")?.textContent, ready: root.querySelector("i")?.textContent ?? null, match: root.querySelector("em, b")?.textContent, style: root.style.getPropertyValue('--snapped'), valid: root.classList.contains('valid'), fromObject: root.classList.contains('from-object'), trace: window.unitTrace ?? [] })`,
    action: `return (async () => {
      root.querySelector('.bad').click();
      root.querySelector('.save').click();
      await new Promise(requestAnimationFrame);
      window.unitTrace = [root.querySelector('.computed').textContent + '/' + root.querySelector('.direct').textContent + '/' + root.getAttribute('data-array') + '/' + root.querySelector('.array')?.textContent + '/' + root.querySelector('.fallback').textContent + '/' + root.querySelector('.saved').textContent + '/' + root.querySelector('.comparison').textContent + '/' + root.querySelector('i')?.textContent + '/' + root.querySelector('em, b')?.textContent + '/' + root.style.getPropertyValue('--snapped') + '/' + root.classList.contains('valid') + '/' + root.classList.contains('from-object')];
      root.querySelector('.good').click();
      root.querySelector('.save').click();
      await new Promise(requestAnimationFrame);
      window.unitTrace.push(root.querySelector('.computed').textContent + '/' + root.querySelector('.direct').textContent + '/' + root.getAttribute('data-array') + '/' + root.querySelector('.array')?.textContent + '/' + root.querySelector('.fallback').textContent + '/' + root.querySelector('.saved').textContent + '/' + root.querySelector('.comparison').textContent + '/' + root.querySelector('i')?.textContent + '/' + root.querySelector('em, b')?.textContent + '/' + root.style.getPropertyValue('--snapped') + '/' + root.classList.contains('valid') + '/' + root.classList.contains('from-object'));
    })()`,
    expectedAfter: { computed: "8px", direct: "8px", array: "x 8px", arrayText: "x 8px", fallback: "8px", saved: "8px", comparison: "false", ready: null, match: "Other", style: "8px", valid: true, fromObject: false, trace: ["9px/9px/x 9px/x 9px/9px/5px/true/Ready/Nine/9px/true/true", "8px/8px/x 8px/x 8px/8px/8px/false/undefined/Other/8px/true/false"] },
  },
  {
    name: "a missing function operand clears its previous binding",
    features: ["function absence", "live binding removal"],
    definitions: {
      "x-optional-name": `<template component="x-optional-name" status="early" summary="Missing operand fixture."><defs>
        <state name="user" type="object({ ... })" value="{ name: 'Ada' }"></state>
        <handler name="clear"><set name="user" expr:value="{}"></set></handler>
      </defs><section><button on:click="clear">Clear</button><output $value="concat($user.name)"></output></section></template>`,
    },
    invocation: `<x-optional-name id="case"></x-optional-name>`,
    vueRender: `h(XOptionalName, { id: "case" })`,
    root: "#case",
    probe: `({ output: root.querySelector("output")?.textContent })`,
    action: `root.querySelector("button").click()`,
    expectedAfter: { output: "" },
  },
  {
    name: "a typed loop alias supplies a dimension to a function",
    features: ["typed loop aliases", "dimensional functions"],
    definitions: {
      "x-row-width": `<template component="x-row-width" status="early" summary="Typed loop fixture."><defs>
        <state name="rows" type="list(object({ width: length }))" value="[{ width: '8.8px' }]"></state>
        <state name="step" type="length" value="1px"></state>
        <handler name="change"><set name="step" value="2px"></set></handler>
      </defs><section><button on:click="change">Change</button><output $each="row of $rows" $value="round($row.width, $step)"></output></section></template>`,
    },
    invocation: `<x-row-width id="case"></x-row-width>`,
    vueRender: `h(XRowWidth, { id: "case" })`,
    root: "#case",
    probe: `({ output: root.querySelector("output")?.textContent })`,
    action: `root.querySelector("button").click()`,
    expectedAfter: { output: "8px" },
  },
  {
    name: "event capture, stop, prevent, and once preserve native dispatch behavior",
    features: ["event capture", "event propagation", "event cancellation", "once handlers"],
    definitions: {
      "x-event-options": `<template component="x-event-options" status="early" summary="Event options parity."><defs>
        <state type="number" name="captured" value="0"></state><state type="number" name="pressed" value="0"></state>
        <handler name="captureClick"><set name="captured" expr:value="$captured + 1"></set></handler>
        <handler name="press"><set name="pressed" expr:value="$pressed + 1"></set></handler>
        </defs><div on:click.capture="captureClick"><button type="button" on:click.stop.prevent.once="press">Press</button>
        <output $value="concat($captured, ':', $pressed)"></output></div></template>`,
    },
    invocation: `<x-event-options id="case"></x-event-options>`,
    vueRender: `h(XEventOptions, { id: "case" })`,
    root: "#case",
    probe: `({ output: root.querySelector("output")?.textContent, events: window.parityEventResults ?? null })`,
    action: `window.parityEventResults = []; let bubbled = 0; document.addEventListener("click", () => { bubbled += 1; });
      for (let i = 0; i < 2; i += 1) { const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        const returned = root.querySelector("button").dispatchEvent(event);
        window.parityEventResults.push({ returned, prevented: event.defaultPrevented, bubbled }); }`,
    expectedAfter: { output: "2:1", events: [
      { returned: false, prevented: true, bubbled: 0 },
      { returned: true, prevented: false, bubbled: 1 },
    ] },
  },
  {
    name: "event self and exact keyboard filters reject nonmatching native events",
    features: ["self modifier", "keyboard filters", "system-key filters", "exact modifier"],
    definitions: {
      "x-event-filters": `<template component="x-event-filters" status="early" summary="Event filter parity."><defs>
        <state type="number" name="selfHits" value="0"></state><state type="number" name="keyHits" value="0"></state>
        <state type="number" name="onceHits" value="0"></state>
        <handler name="selfHit"><set name="selfHits" expr:value="$selfHits + 1"></set></handler>
        <handler name="keyHit"><set name="keyHits" expr:value="$keyHits + 1"></set></handler>
        <handler name="onceHit"><set name="onceHits" expr:value="$onceHits + 1"></set></handler>
        </defs><section on:click.self="selfHit"><button type="button">Child</button>
        <input on:keydown.ctrl.enter.exact="keyHit">
        <input class="once" on:keydown.enter.once="onceHit">
        <output $value="concat($selfHits, ':', $keyHits, ':', $onceHits)"></output></section></template>`,
    },
    invocation: `<x-event-filters id="case"></x-event-filters>`,
    vueRender: `h(XEventFilters, { id: "case" })`,
    root: "#case",
    probe: `({ output: root.querySelector("output")?.textContent })`,
    action: `root.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const input = root.querySelector("input");
      for (const options of [{ key: "Enter", ctrlKey: true }, { key: "Enter", ctrlKey: true, shiftKey: true }, { key: "Escape", ctrlKey: true }])
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...options }));
      const once = root.querySelector(".once");
      once.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      once.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));`,
    expectedAfter: { output: "1:1:0" },
  },
  {
    name: "event filters run before propagation modifiers regardless of authored order",
    features: ["self modifier", "stop modifier", "modifier order", "native propagation"],
    definitions: {
      "x-filter-order": `<template component="x-filter-order" status="early" summary="Event filter ordering parity."><defs>
        <state type="number" name="hits" value="0"></state>
        <handler name="hit"><set name="hits" expr:value="$hits + 1"></set></handler>
        </defs><section on:click.stop.self="hit"><button type="button">Child</button><output $value="$hits"></output></section></template>`,
    },
    invocation: `<x-filter-order id="case"></x-filter-order>`,
    vueRender: `h(XFilterOrder, { id: "case" })`,
    root: "#case",
    probe: `({ hits: root.querySelector("output")?.textContent, bubbled: window.parityEventResults ?? null })`,
    action: `window.parityEventResults = []; document.addEventListener("click", () => window.parityEventResults.push("document"));
      root.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      root.dispatchEvent(new MouseEvent("click", { bubbles: true }));`,
    expectedAfter: { hits: "1", bubbled: ["document"] },
  },
  {
    name: "declared events retain detail, propagation flags, and cancellation",
    features: ["typed event detail", "nonbubbling events", "noncomposed events", "cancelable events"],
    definitions: {
      "x-event-contract": `<template component="x-event-contract" status="early" summary="Event contract parity."><defs>
        <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
        <handler name="save"><dispatch event="saved" expr:value="7"></dispatch></handler>
        </defs><section><button type="button" on:click="save">Save</button></section></template>`,
    },
    invocation: `<x-event-contract id="case"></x-event-contract>`,
    vueRender: `h(XEventContract, { id: "case" })`,
    root: "#case",
    probe: `({ events: window.parityEventResults ?? null, parentCount: window.parityParentEvents ?? null })`,
    action: `window.parityEventResults = []; window.parityParentEvents = 0;
      root.parentElement.addEventListener("saved", () => { window.parityParentEvents += 1; });
      root.addEventListener("saved", event => { event.preventDefault();
        window.parityEventResults.push({ detail: event.detail, bubbles: event.bubbles, composed: event.composed,
          cancelable: event.cancelable, prevented: event.defaultPrevented }); });
      root.querySelector("button").click()`,
    expectedAfter: { events: [{ detail: 7, bubbles: false, composed: false, cancelable: true, prevented: true }], parentCount: 0 },
  },
  {
    name: "nested component events reach explicit and ancestor listeners once each",
    features: ["component event listeners", "bubbling", "nested component dispatch"],
    definitions: {
      "x-event-source": `<template component="x-event-source" status="early" summary="Event source."><defs>
        <event name="saved" type="number"></event>
        <handler name="fire"><dispatch event="saved" expr:value="1"></dispatch></handler>
        </defs><button type="button" on:click="fire">Fire</button></template>`,
      "x-event-listener": `<template component="x-event-listener" status="early" summary="Event listener."><defs>
        <state type="number" name="count" value="0"></state>
        <handler name="record"><set name="count" expr:value="$count + 1"></set></handler>
        </defs><section on:saved="record"><x-event-source on:saved="record"></x-event-source>
        <output $value="$count"></output></section></template>`,
    },
    invocation: `<x-event-listener id="case"></x-event-listener>`,
    vueRender: `h(XEventListener, { id: "case" })`,
    root: "#case",
    probe: `({ count: root.querySelector("output")?.textContent })`,
    action: `root.querySelector("button").click()`,
    expectedAfter: { count: "2" },
  },
  {
    name: "component event stop modifiers act on the DOM event before ancestor handlers",
    features: ["component event listeners", "stop modifier", "nested component dispatch"],
    definitions: {
      "x-stopping-source": `<template component="x-stopping-source" status="early" summary="Stopping event source."><defs>
        <event name="saved" type="number"></event>
        <handler name="fire"><dispatch event="saved" expr:value="1"></dispatch></handler>
        </defs><button type="button" on:click="fire">Fire</button></template>`,
      "x-stopping-parent": `<template component="x-stopping-parent" status="early" summary="Stopping event listener."><defs>
        <state type="number" name="direct" value="0"></state><state type="number" name="ancestor" value="0"></state>
        <handler name="recordDirect"><set name="direct" expr:value="$direct + 1"></set></handler>
        <handler name="recordAncestor"><set name="ancestor" expr:value="$ancestor + 1"></set></handler>
        </defs><section on:saved="recordAncestor"><x-stopping-source on:saved.stop="recordDirect"></x-stopping-source>
        <output $value="concat($direct, ':', $ancestor)"></output></section></template>`,
    },
    invocation: `<x-stopping-parent id="case"></x-stopping-parent>`,
    vueRender: `h(XStoppingParent, { id: "case" })`,
    root: "#case",
    probe: `({ counts: root.querySelector("output")?.textContent, bubbled: window.parityEventResults ?? null })`,
    action: `window.parityEventResults = []; document.addEventListener("saved", () => window.parityEventResults.push("document"));
      root.querySelector("button").click()`,
    expectedAfter: { counts: "1:0", bubbled: [] },
  },
  {
    name: "middle and right filters preserve native click type and modifier order",
    features: ["middle mouse button filter", "right mouse button filter", "native event type", "modifier order"],
    definitions: {
      "x-right-click": `<template component="x-right-click" status="early" summary="Right-click parity."><defs>
        <state type="number" name="hits" value="0"></state>
        <handler name="hit"><set name="hits" expr:value="$hits + 1"></set></handler>
        </defs><section><button class="right" type="button" on:click.right.stop.prevent="hit">Right</button>
        <button class="middle" type="button" on:click.middle="hit">Middle</button><output $value="$hits"></output></section></template>`,
    },
    invocation: `<x-right-click id="case"></x-right-click>`,
    vueRender: `h(XRightClick, { id: "case" })`,
    root: "#case",
    probe: `({ hits: root.querySelector("output")?.textContent, events: window.parityEventResults ?? null })`,
    action: `window.parityEventResults = []; let bubbled = 0; document.addEventListener("click", () => { bubbled += 1; });
      for (const [selector, button] of [[".right", 0], [".right", 2], [".middle", 1]]) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, button });
        const returned = root.querySelector(selector).dispatchEvent(event);
        window.parityEventResults.push({ returned, prevented: event.defaultPrevented, bubbled }); }`,
    expectedAfter: { hits: "2", events: [
      { returned: true, prevented: false, bubbled: 1 },
      { returned: false, prevented: true, bubbled: 1 },
      { returned: true, prevented: false, bubbled: 2 },
    ] },
  },
  {
    name: "provided and consumed reactive context across nested components",
    features: ["context provision", "context consumption", "nested components", "reactive attribute bindings"],
    definitions: {
      "x-steps": `<template component="x-steps" status="early" summary="Parity steps."><defs>
        <state type="number" name="current" value="1"></state>
        <handler name="next"><set name="current" expr:value="$current + 1"></set></handler>
        </defs><section><button type="button" on:click="next">Next</button><ol><slot></slot></ol></section></template>`,
      "x-step": `<template component="x-step" status="early" summary="Parity step."><defs>
        <prop name="index" type="number" required>Step index.</prop>
        <context name="current" from="x-steps" as="activeStep"></context>
        </defs><li from:aria-current="$activeStep = $index ? 'step' : null"><slot></slot></li></template>`,
    },
    invocation: `<x-steps id="case"><x-step index="1">One</x-step><x-step index="2">Two</x-step></x-steps>`,
    vueRender: `h(XSteps, { id: "case" }, { default: () => [h(XStep, { index: 1 }, () => "One"), h(XStep, { index: 2 }, () => "Two")] })`,
    root: "#case",
    probe: `({ tag: root.localName, steps: Array.from(root.querySelectorAll("li"), node => [node.textContent?.trim(), node.getAttribute("aria-current")]) })`,
    action: `root.querySelector("button").click()`,
  },
  {
    name: "conditional, match, with, and ternary expressions react to state",
    features: ["$if", "$match", "$when", "$else", "$with", "ternary expressions"],
    definitions: {
      "x-choice": `<template component="x-choice" status="early" summary="Parity choice."><defs>
        <state type="boolean" name="show" value="true"></state>
        <handler name="toggle"><set name="show" expr:value="not $show"></set></handler>
        </defs><section><button type="button" on:click="toggle">Toggle</button>
        <span class="flag" $if="$show" $value="$show ? 'Shown' : 'Hidden'"></span>
        <template $match="$show as active"><b $when="$active">On</b><i $else>Off</i></template>
        <div class="wrapped" $match="$show as active" from:data-show="$show"><small $when="$active">Yes</small><small $else>No</small></div>
        <template $with="{ name: 'Ada' } as user"><em $value="$user.name"></em></template>
        </section></template>`,
    },
    invocation: `<x-choice id="case"></x-choice>`,
    vueRender: `h(XChoice, { id: "case" })`,
    root: "#case",
    probe: `({ flag: root.querySelector(".flag")?.textContent ?? null, strong: root.querySelector("b")?.textContent ?? null, italic: root.querySelector("i")?.textContent ?? null, wrapped: [root.querySelector(".wrapped")?.getAttribute("data-show"), root.querySelector(".wrapped small")?.textContent], name: root.querySelector("em")?.textContent })`,
    action: `root.querySelector("button").click()`,
  },
  {
    name: "keyed nested components retain rows when reordered",
    features: ["keyed list reorder", "nested components", "prop updates"],
    definitions: {
      "x-items": `<template component="x-items" status="early" summary="Keyed items."><defs>
        <state type="list(unknown)" name="rows" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]"></state>
        <handler name="reorder"><set name="rows" expr:value="[{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }, { id: 'b', label: 'Bee' }]"></set></handler>
        </defs><section><button type="button" on:click="reorder">Reorder</button><ul>
        <x-item $each="row of $rows" $key="$row.id" from:data-id="$row.id" from:label="$row.label"></x-item>
        </ul></section></template>`,
      "x-item": `<template component="x-item" status="early" summary="One item."><defs>
        <prop name="label" type="string">Label.</prop></defs>
        <li><input><span $value="$label"></span></li></template>`,
    },
    invocation: `<x-items id="case"></x-items>`,
    vueRender: `h(XItems, { id: "case" })`,
    root: "#case",
    probe: `({ rows: Array.from(root.querySelectorAll("li"), row => [row.getAttribute("data-id"), row.querySelector("span")?.textContent, row.querySelector("input")?.value]) })`,
    action: `root.querySelector("button").click()`,
  },
  {
    name: "sanitized HTML retains scoped styling and updates in element and inline positions",
    features: ["$html", "inline $html", "safe-default sanitizer", "scoped dynamic content"],
    definitions: {
      "x-html": `<template component="x-html" status="early" summary="Sanitized markup."><defs>
        <state name="body" value="&lt;b title='safe'&gt;One&lt;/b&gt;&lt;img src=x onerror=alert(1)&gt;"></state>
        <handler name="change"><set name="body" expr:value="'&lt;i title=&quot;next&quot;&gt;Two&lt;/i&gt;&lt;img src=x onerror=alert(1)&gt;'"></set></handler>
        </defs><article><div class="block" $html="$body"></div>
        <p>Before <template $html="$body"></template> after</p>
        <button type="button" on:click="change">Change</button></article>
        <style>b { color: rgb(12 34 56); } i { color: rgb(65 43 21); }</style></template>`,
    },
    invocation: `<x-html id="case"></x-html>`,
    vueRender: `h(XHtml, { id: "case" })`,
    root: "#case",
    probe: `({ blockTag: root.querySelector(".block")?.firstElementChild?.localName, blockTitle: root.querySelector(".block")?.firstElementChild?.getAttribute("title"), blockText: root.querySelector(".block")?.textContent, inlineText: root.querySelector("p")?.textContent, inlineTags: Array.from(root.querySelector("p")?.children ?? [], child => child.localName), boldColor: root.querySelector("b") ? getComputedStyle(root.querySelector("b")).color : null, italicColor: root.querySelector("i") ? getComputedStyle(root.querySelector("i")).color : null, unsafe: root.querySelectorAll("img, script, [onerror]").length })`,
    action: `root.querySelector("button").click()`,
  },
  {
    name: "two-way input binding updates state and rendered output",
    features: ["bind:value", "input events", "state updates", "$value"],
    definitions: {
      "x-editor": `<template component="x-editor" status="early" summary="Parity editor."><defs>
        <state name="name" value="Ada"></state>
        </defs><div><label>Name <input bind:value="name"></label><output $value="$name"></output></div></template>`,
    },
    invocation: `<x-editor id="case"></x-editor>`,
    vueRender: `h(XEditor, { id: "case" })`,
    root: "#case",
    probe: `({ value: root.querySelector("input")?.value, output: root.querySelector("output")?.textContent })`,
    action: `const input = root.querySelector("input"); input.value = "Grace"; input.dispatchEvent(new Event("input", { bubbles: true }))`,
  },
  {
    name: "two-way binding on an output element updates state without Vue v-model",
    features: ["bind:value on ordinary elements", "input events", "state updates"],
    definitions: {
      "x-output": `<template component="x-output" status="early" summary="Parity output."><defs>
        <state name="name" value="Ada"></state>
        </defs><div><output bind:value="name"></output><span $value="$name"></span></div></template>`,
    },
    invocation: `<x-output id="case"></x-output>`,
    vueRender: `h(XOutput, { id: "case" })`,
    root: "#case",
    probe: `({ value: root.querySelector("output")?.getAttribute("value"), text: root.querySelector("span")?.textContent })`,
    action: `const output = root.querySelector("output"); output.value = "Grace"; output.dispatchEvent(new Event("input", { bubbles: true }))`,
  },
  {
    name: "nested scoped projection keeps consumer state and receiving row props",
    features: ["scoped slots", "consumer lexical state", "nested component conversion", "slot repetition"],
    definitions: {
      "x-scoped-rows": `<template component="x-scoped-rows"><defs>
        <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
        <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
        </defs><section><button class="add" type="button" on:click="add">Add</button><ul>
        <slot $each="row of $rows" $key="$row.id" name="row" from:item="$row"></slot></ul></section></template>`,
      "x-scoped-consumer": `<template component="x-scoped-consumer"><defs><state name="heading" value="People"></state>
        <handler name="rename"><set name="heading" expr:value="'Team'"></set></handler></defs>
        <main><button class="rename" type="button" on:click="rename">Rename</button><x-scoped-rows>
        <template slot="row"><li><b $value="$item.name"></b><i $value="$heading"></i></li></template>
        </x-scoped-rows></main></template>`,
    },
    invocation: `<x-scoped-consumer id="case"></x-scoped-consumer>`,
    vueRender: `h(XScopedConsumer, { id: "case" })`,
    root: "#case",
    probe: `({ rows: Array.from(root.querySelectorAll("li"), (row) => row.textContent) })`,
    action: `root.querySelector(".rename").click(); root.querySelector(".add").click()`,
    expectedAfter: { rows: ["AdaTeam", "BeaTeam"] },
  },
  {
    name: "repeated scoped slots pass row data into consumer templates",
    features: ["scoped slots", "slot props", "slot repetition", "slot fallback"],
    definitions: {
      "x-scoped-list": `<template component="x-scoped-list"><defs>
        <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
        <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
        </defs><section><button type="button" on:click="add">Add</button><ul>
        <slot $each="row of $rows" $key="$row.id" name="row" from:item="$row" from:index="$loop.index">
        <li class="fallback" $value="$row.name"></li></slot></ul></section></template>`,
    },
    invocation: `<x-scoped-list id="case"><template slot="row"><li><b $value="$item.name"></b><em $value="$index"></em></li></template></x-scoped-list>`,
    vueRender: `h(XScopedList, { id: "case" }, { row: ({ item, index }) => h("li", [h("b", item.name), h("em", String(index))]) })`,
    root: "#case",
    probe: `({ rows: Array.from(root.querySelectorAll("li"), (row) => row.textContent) })`,
    action: `root.querySelector("button").click()`,
    expectedAfter: { rows: ["Ada0", "Bea1"] },
  },
  {
    name: "native attribute bindings leave dirty controls to the browser",
    features: ["native attribute binding", "dirty value", "dirty checkedness", "unrelated render"],
    definitions: {
      "x-attribute-control": `<template component="x-attribute-control" status="early" summary="Native attribute semantics."><defs>
        <state name="label" value="first"></state><state type="boolean" name="enabled" value="true"></state><state type="number" name="count" value="0"></state>
        <handler name="bump"><set name="count" expr:value="$count + 1"></set></handler>
        <handler name="advance"><set name="label" expr:value="'second'"></set><set name="enabled" value="false"></set></handler>
        </defs><form><input class="text" from:value="$label"><input class="property" .value="$label" value="authored"><input class="check" type="checkbox" from:checked="$enabled">
        <button class="bump" type="button" on:click="bump">Bump</button><button class="advance" type="button" on:click="advance">Advance</button>
        <output $value="$count"></output></form></template>`,
    },
    invocation: `<x-attribute-control id="case"></x-attribute-control>`,
    vueRender: `h(XAttributeControl, { id: "case" })`,
    root: "#case",
    probe: `({ value: root.querySelector(".text").value, defaultValue: root.querySelector(".text").defaultValue, propertyValue: root.querySelector(".property").value, propertyDefault: root.querySelector(".property").defaultValue, checked: root.querySelector(".check").checked, defaultChecked: root.querySelector(".check").defaultChecked, count: root.querySelector("output").textContent })`,
    action: `root.querySelector(".text").value = "edited"; root.querySelector(".property").value = "edited property"; root.querySelector(".check").checked = false;
      root.querySelector(".bump").click(); root.querySelector(".advance").click()`,
    expectedAfter: { value: "edited", defaultValue: "second", propertyValue: "second", propertyDefault: "authored", checked: false, defaultChecked: false, count: "1" },
  },
  {
    name: "native form controls preserve values, selection, validity, and form data",
    features: ["form ownership", "text input", "checkbox", "radio", "select/option", "number input", "native validity", "FormData"],
    definitions: {
      "x-form": `<template component="x-form" status="early" summary="Form parity."><defs>
        <state type="object({ text: string, checked: boolean, radio: boolean, choice: string, count: number })" name="form" value="{ text: 'a', checked: false, radio: false, choice: 'a', count: 1 }"></state>
        </defs><form><input class="text" name="text" required minlength="3" maxlength="6" pattern="[a-z]+" bind:value="form.text">
        <input class="check" type="checkbox" name="check" bind:checked="form.checked">
        <input class="radio" type="radio" name="radio" bind:checked="form.radio">
        <select class="choice" name="choice" bind:value="form.choice"><option value="a">A</option><option value="b">B</option></select>
        <input class="number" type="number" name="count" min="0" max="10" bind:value="form.count">
        <output class="result" $value="[$form.text, $form.checked, $form.radio, $form.choice, $form.count]"></output>
        </form></template>`,
    },
    invocation: `<x-form id="case"></x-form>`,
    vueRender: `h(XForm, { id: "case" })`,
    root: "#case",
    probe: `({ tag: root.localName, values: [root.querySelector(".text").value, root.querySelector(".check").checked, root.querySelector(".radio").checked, root.querySelector(".choice").value, root.querySelector(".number").value], selected: root.querySelector(".choice").selectedIndex, valid: root.checkValidity(), owner: root.querySelector(".text").form === root, data: Array.from(new FormData(root).entries()), result: root.querySelector(".result").textContent })`,
    action: `const text = root.querySelector(".text"); text.value = "next"; text.dispatchEvent(new Event("input", { bubbles: true })); const check = root.querySelector(".check"); check.checked = true; check.dispatchEvent(new Event("change", { bubbles: true })); const radio = root.querySelector(".radio"); radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); const choice = root.querySelector(".choice"); choice.value = "b"; choice.dispatchEvent(new Event("change", { bubbles: true })); const number = root.querySelector(".number"); number.value = "7"; number.dispatchEvent(new Event("input", { bubbles: true }))`,
  },
  {
    name: "a component control stays associated with its author-owned form",
    features: ["form association", "native validation", "FormData", "component root replacement"],
    definitions: {
      "x-slug": `<template component="x-slug" status="early" summary="Slug editor."><defs>
        <state type="string" name="slug" value=""></state></defs>
        <fieldset><input name="slug" required pattern="[a-z-]+" bind:value="slug"><output $value="$slug"></output></fieldset>
        </template>`,
    },
    invocation: `<form id="case" action="/posts" method="post"><x-slug></x-slug><button type="submit">Save post</button></form>`,
    vueRender: `h("form", { id: "case", action: "/posts", method: "post" }, [h(XSlug), h("button", { type: "submit" }, "Save post")])`,
    root: "#case",
    probe: `({ forms: document.querySelectorAll("form").length, fieldset: root.firstElementChild?.localName, owner: root.querySelector("input")?.form === root, valid: root.checkValidity(), value: root.querySelector("input")?.value, output: root.querySelector("output")?.textContent, data: Array.from(new FormData(root).entries()) })`,
    action: `const input = root.querySelector("input"); input.value = "short-slug"; input.dispatchEvent(new Event("input", { bubbles: true }))`,
  },
  {
    name: "a select root keeps projected options and its form association",
    features: ["select root", "projected options", "select value binding", "FormData"],
    definitions: {
      "x-choice": `<template component="x-choice" status="early" summary="Choice field."><defs>
        <state name="choice" value="b"></state></defs>
        <select name="choice" from:data-choice="$choice" bind:value="choice"><slot></slot></select>
        </template>`,
    },
    invocation: `<form id="owner"><x-choice id="case"><option value="a">A</option><option value="b">B</option></x-choice></form>`,
    vueRender: `h("form", { id: "owner" }, [h(XChoice, { id: "case" }, { default: () => [h("option", { value: "a" }, "A"), h("option", { value: "b" }, "B")] })])`,
    root: "#case",
    probe: `({ tag: root.localName, options: Array.from(root.options, option => [option.value, option.textContent, option.selected]), selected: root.selectedIndex, value: root.value, state: root.getAttribute("data-choice"), owner: root.form?.id, data: Array.from(new FormData(root.form).entries()) })`,
    action: `root.value = "a"; root.dispatchEvent(new Event("change", { bubbles: true }))`,
  },
  {
    name: "a multiple select writes a list and submits every selected option",
    features: ["multiple select", "list binding", "option selection", "FormData"],
    definitions: {
      "x-multi": `<template component="x-multi" status="early" summary="Multiple choice."><defs>
        <state type="list(unknown)" name="choices" value="['a']"></state><computed name="selectedCount" from="$choices.length"></computed>
        </defs><select name="choice" multiple bind:value="choices" from:data-count="$selectedCount">
        <option value="a">A</option><option value="b">B</option><option value="c">C</option></select></template>`,
    },
    invocation: `<form id="owner"><x-multi id="case"></x-multi></form>`,
    vueRender: `h("form", { id: "owner" }, [h(XMulti, { id: "case" })])`,
    root: "#case",
    probe: `({ tag: root.localName, multiple: root.multiple, selected: Array.from(root.selectedOptions, option => option.value), count: root.getAttribute("data-count"), owner: root.form?.id, data: Array.from(new FormData(root.form).entries()) })`,
    action: `root.options[1].selected = true; root.dispatchEvent(new Event("change", { bubbles: true }))`,
  },
  {
    name: "reactive multiple selection preserves native form semantics",
    features: ["reactive multiple attribute", "select value binding", "FormData"],
    definitions: {
      "x-switching-select": `<template component="x-switching-select" status="early" summary="Reactive select mode."><defs>
        <state type="boolean" name="multi" value="false"></state><state type="list(unknown)" name="choices" value="['b']"></state>
        <handler name="toggle"><set name="multi" expr:value="not $multi"></set></handler></defs>
        <form><select name="choice" from:multiple="$multi" bind:value="choices"><option value="a">A</option><option value="b">B</option></select>
        <button type="button" on:click="toggle">Toggle</button><output $value="$multi"></output></form></template>`,
    },
    invocation: `<x-switching-select id="case"></x-switching-select>`,
    vueRender: `h(XSwitchingSelect, { id: "case" })`,
    root: "#case",
    probe: `({ multiple: root.querySelector("select").multiple, selected: Array.from(root.querySelector("select").selectedOptions, option => option.value), data: Array.from(new FormData(root).entries()), state: root.querySelector("output").textContent })`,
    action: `root.querySelector("button").click()`,
    expectedAfter: { multiple: true, selected: ["b"], data: [["choice", "b"]], state: "true" },
  },
  {
    name: "a real-element root match keeps one native root while changing its chosen child",
    features: ["root match wrapper", "reactive arms", "root bindings", "single native root"],
    definitions: {
      "x-root-choice": `<template component="x-root-choice" status="early" summary="Root choice."><defs>
        <state name="kind" value="a"></state>
        <handler name="toggle"><set name="kind" expr:value="$kind = 'a' ? 'b' : 'a'"></set></handler></defs>
        <section class="choice" $match="$kind as choice" from:data-kind="$kind" on:click="toggle">
          <p $when="$choice = 'a'" class="first">First</p>
          <p $else class="second">Second</p>
        </section><style>:host { display: block; padding: 2px; border: 1px solid rgb(0, 0, 0); } :host > p { margin: 0; }</style></template>`,
    },
    invocation: `<x-root-choice id="case"></x-root-choice>`,
    vueRender: `h(XRootChoice, { id: "case" })`,
    root: "#case",
    probe: `({ tag: root.localName, dataKind: root.getAttribute("data-kind"), child: root.querySelector("p")?.textContent, className: root.querySelector("p")?.className, rootCount: document.querySelectorAll("[data-component=x-root-choice]").length, border: getComputedStyle(root).borderTopWidth, childMargin: getComputedStyle(root.querySelector("p")).marginTop })`,
    action: `root.querySelector("p").click()`,
    expectedAfter: { tag: "section", dataKind: "b", child: "Second", className: "second", rootCount: 1, border: "1px", childMargin: "0px" },
  },
  {
    name: "a select reapplies its model when reactive options change",
    features: ["single select", "reactive options", "unchanged bound model"],
    definitions: {
      "x-changing-options": `<template component="x-changing-options" status="early" summary="Changing options."><defs>
        <state type="list(unknown)" name="items" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]"></state>
        <state name="choice" value="b"></state>
        <handler name="change"><set name="items" expr:value="[{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }]"></set></handler></defs>
        <form><select name="choice" bind:value="choice"><option $each="item of $items" $key="$item.id" from:value="$item.id" $value="$item.label"></option></select>
        <button type="button" on:click="change">Change</button><output $value="$choice"></output></form></template>`,
    },
    invocation: `<x-changing-options id="case"></x-changing-options>`,
    vueRender: `h(XChangingOptions, { id: "case" })`,
    root: "#case",
    probe: `({ options: Array.from(root.querySelector("select").options, option => [option.value, option.selected]), selected: root.querySelector("select").selectedIndex, value: root.querySelector("select").value, model: root.querySelector("output").textContent })`,
    action: `root.querySelector("button").click()`,
  },
  {
    name: "reactive options and selection update together",
    features: ["keyed options", "multiple select", "reactive selected values", "FormData"],
    definitions: {
      "x-dynamic-choice": `<template component="x-dynamic-choice" status="early" summary="Dynamic choices."><defs>
        <state type="list(unknown)" name="items" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]"></state>
        <state type="list(unknown)" name="choices" value="['b']"></state>
        <handler name="change"><set name="items" expr:value="[{ id: 'c', label: 'C' }, { id: 'b', label: 'Bee' }, { id: 'a', label: 'A' }]"></set>
        <set name="choices" expr:value="['c']"></set></handler></defs>
        <form><select name="choice" multiple bind:value="choices" from:data-count="$choices.length">
        <option $each="item of $items" $key="$item.id" from:value="$item.id" $value="$item.label"></option></select>
        <button type="button" on:click="change">Change</button></form></template>`,
    },
    invocation: `<x-dynamic-choice id="case"></x-dynamic-choice>`,
    vueRender: `h(XDynamicChoice, { id: "case" })`,
    root: "#case",
    probe: `({ options: Array.from(root.querySelector("select").options, option => [option.value, option.textContent, option.selected]), selected: Array.from(root.querySelector("select").selectedOptions, option => option.value), count: root.querySelector("select").getAttribute("data-count"), data: Array.from(new FormData(root).entries()) })`,
    action: `root.querySelector("button").click()`,
  },
  {
    name: "declared data request follows reactive parameters",
    features: ["data request", "typed response", "reactive parameters", "pending state"],
    definitions: {
      "x-feed": `<template component="x-feed" status="early" summary="Parity feed."><defs>
        <state name="query" value="first"></state>
        <data name="result" src="https://api.example/search" type="object({ label: string })">
          <param name="q" from:value="$query"></param>
        </data>
        <handler name="next"><set name="query" expr:value="'second'"></set></handler>
        </defs><section><button type="button" on:click="next">Next</button>
        <i $value="$result.pending"></i><output $value="$result.value.label"></output></section></template>`,
    },
    invocation: `<x-feed id="case"></x-feed>`,
    vueRender: `h(XFeed, { id: "case" })`,
    root: "#case",
    probe: `({ pending: root.querySelector("i")?.textContent, label: root.querySelector("output")?.textContent })`,
    action: `root.querySelector("button").click()`,
    mockData: "instant",
    beforeReady: `document.querySelector("#case output")?.textContent === "Result first"`,
    afterReady: `document.querySelector("#case output")?.textContent === "Result second"`,
  },
  {
    name: "an invalid calculated data parameter keeps the accepted request",
    features: ["data parameters", "invalid function retention"],
    definitions: {
      "x-data-width": `<template component="x-data-width" status="early" summary="Calculated request fixture."><defs>
        <state name="width" type="length" value="8.8px"></state>
        <state name="step" type="length" value="1px"></state>
        <data name="result" src="https://api.example/search" type="object({ label: string })">
          <param name="q" from:value="round($width, $step)"></param>
        </data>
        <handler name="bad"><set name="step" value="1rem"></set></handler>
        <handler name="good"><set name="step" value="2px"></set></handler>
      </defs><section><button class="bad" on:click="bad">Bad</button><button class="good" on:click="good">Good</button>
        <output $value="$result.value.label"></output></section></template>`,
    },
    invocation: `<x-data-width id="case"></x-data-width>`,
    vueRender: `h(XDataWidth, { id: "case" })`,
    root: "#case",
    probe: `({ label: root.querySelector("output")?.textContent, badLabel: window.badLabel ?? null })`,
    action: `return (async () => { root.querySelector(".bad").click(); await new Promise(resolve => setTimeout(resolve, 100)); window.badLabel = root.querySelector("output")?.textContent; root.querySelector(".good").click(); })()`,
    expectedAfter: { label: "Result 8px", badLabel: "Result 9px" },
    mockData: "instant",
    beforeReady: `document.querySelector("#case output")?.textContent === "Result 9px"`,
    afterReady: `document.querySelector("#case output")?.textContent === "Result 8px"`,
  },
  {
    name: "stale data response cannot replace the latest request",
    features: ["data cancellation", "stale response", "pending state"],
    definitions: {
      "x-stale": `<template component="x-stale" status="early" summary="Parity stale data."><defs>
        <state name="query" value="first"></state>
        <data name="result" src="https://api.example/search" type="object({ label: string })">
          <param name="q" from:value="$query"></param>
        </data>
        <handler name="next"><set name="query" expr:value="'second'"></set></handler>
        </defs><section><button type="button" on:click="next">Next</button>
        <i $value="$result.pending"></i><output $value="$result.value.label"></output></section></template>`,
    },
    invocation: `<x-stale id="case"></x-stale>`,
    vueRender: `h(XStale, { id: "case" })`,
    root: "#case",
    probe: `({ pending: root.querySelector("i")?.textContent, label: root.querySelector("output")?.textContent })`,
    action: `root.querySelector("button").click()`,
    mockData: "stale",
    afterReady: `document.querySelector("#case output")?.textContent === "Result second"`,
    settleAfterMs: 250,
  },
  {
    name: "typed data keeps invalid references inert while valid siblings update",
    features: ["data type checks", "per-reference inert reads", "computed stability"],
    definitions: {
      "x-typed-data": `<template component="x-typed-data" status="early" summary="Parity typed data."><defs>
        <state type="number" name="round" value="1"></state>
        <data name="result" src="https://api.example/search" type="object({ label: string, note: string, ... })">
          <param name="round" from:value="$round"></param>
        </data>
        <computed name="shouted" from="concat($result.value.label, '!')"></computed>
        <handler name="again"><set name="round" expr:value="$round + 1"></set></handler>
        </defs><section from:data-label="$result.value.label" from:data-note="$result.value.note"><button type="button" on:click="again">Again</button>
        <output class="label" $value="$result.value.label"></output>
        <output class="note" $value="$result.value.note"></output>
        <output class="shouted" $value="$shouted"></output>
        <output class="combined" $value="concat($result.value.label, '/', $result.value.note)"></output></section></template>`,
    },
    invocation: `<x-typed-data id="case"></x-typed-data>`,
    vueRender: `h(XTypedData, { id: "case" })`,
    root: "#case",
    probe: `({ label: root.querySelector(".label")?.textContent, note: root.querySelector(".note")?.textContent, shouted: root.querySelector(".shouted")?.textContent, combined: root.querySelector(".combined")?.textContent, attrLabel: root.getAttribute("data-label"), attrNote: root.getAttribute("data-note") })`,
    action: `root.querySelector("button").click()`,
    mockData: "invalid",
    beforeReady: `document.querySelector("#case .label")?.textContent === "first"`,
    afterReady: `document.querySelector("#case .note")?.textContent === "second"`,
  },
  {
    name: "host-state and slotted selectors follow their component style boundaries",
    features: [":host", ":host-state", ":slotted", "style isolation"],
    definitions: {
      "x-painted": `<template component="x-painted" status="early" summary="Parity paint."><defs>
        <state type="boolean" name="active" value="true"></state>
        <handler name="toggle"><set name="active" expr:value="not $active"></set></handler>
        </defs><section><button type="button" on:click="toggle">Toggle</button><slot></slot><span>Own</span></section>
        <style>:host { display: block; padding: 4px; } :host-state([active]) { background: rgb(230 240 250); }
        :slotted(strong) { color: rgb(60 20 100); } span { color: rgb(20 100 60); }</style></template>`,
    },
    invocation: `<x-painted id="case"><strong>Projected</strong></x-painted>`,
    vueRender: `h(XPainted, { id: "case" }, { default: () => h("strong", "Projected") })`,
    root: "#case",
    probe: `({ background: getComputedStyle(root).backgroundColor, projected: getComputedStyle(root.querySelector("strong")).color, own: getComputedStyle(root.querySelector("span")).color })`,
    action: `root.querySelector("button").click()`,
  },
];

/** Preserve the exact definition and invocation slices of a live-runtime conformance case. */
function conformanceScene(source: string): { definition: string; invocation: string } {
  const document = parseFragment(source, { sourceCodeLocationInfo: true });
  const carrier = document.childNodes.find((node) =>
    "tagName" in node && node.tagName === "template" && node.attrs.some((attribute) => attribute.name === "component"));
  assert.ok(carrier?.sourceCodeLocation, "conformance case must have a component definition");
  return {
    definition: source.slice(carrier.sourceCodeLocation.startOffset, carrier.sourceCodeLocation.endOffset),
    invocation: source.slice(carrier.sourceCodeLocation.endOffset),
  };
}

interface ParsedHtmlNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly ParsedHtmlNode[];
}

/** Author the Vue consumer from the same HTML invocation used by the live-runtime corpus. */
function vueInvocation(invocation: string, definition: ComponentDefinition): string {
  const nodes = parseFragment(invocation).childNodes as readonly ParsedHtmlNode[];
  const render = (node: ParsedHtmlNode): string | undefined => {
    if (node.nodeName === "#comment") return undefined;
    if (node.nodeName === "#text") return node.value?.trim() === "" ? undefined : JSON.stringify(node.value);
    const tag = node.tagName;
    if (tag === undefined) return undefined;
    const component = tag === definition.contract.tag;
    const attributes: Record<string, unknown> = {};
    for (const attribute of node.attrs ?? []) {
      const propName = component
        ? Object.keys(definition.contract.props).find((name) => name.toLowerCase() === attribute.name)
        : undefined;
      const name = propName ?? attribute.name;
      const type = propName === undefined ? undefined : definition.contract.props[propName]?.type;
      attributes[name] = type === "number" && Number.isFinite(Number(attribute.value)) ? Number(attribute.value)
        : type === "boolean" ? attribute.value !== "false"
        : attribute.value;
    }
    const children = (node.childNodes ?? []).map(render).filter((child): child is string => child !== undefined);
    const name = component ? definition.contract.name : JSON.stringify(tag);
    return component
      ? `h(${name}, ${JSON.stringify(attributes)}, ${children.length === 0 ? "undefined" : `{ default: () => [${children.join(", ")}] }`})`
      : `h(${name}, ${JSON.stringify(attributes)}, ${children.length === 0 ? "undefined" : `[${children.join(", ")}]`})`;
  };
  const children = nodes.map(render).filter((child): child is string => child !== undefined);
  assert.ok(children.length > 0, "conformance case must invoke a component");
  return children.length === 1 ? children[0]! : `[${children.join(", ")}]`;
}

/** Styling markers are target-owned implementation details, not the component's public behavior. */
function withoutStylingMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStylingMarkers);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "attributes" && Array.isArray(entry)
      ? entry.filter((attribute) => Array.isArray(attribute) &&
        typeof attribute[0] === "string" && attribute[0] !== "data-slotted" && !attribute[0].startsWith("data-v-"))
      : withoutStylingMarkers(entry),
  ]));
}

const knownConversionGaps = new Map<string, string>();
const knownVueCompileGaps = new Set<string>();
const unpairedFeatureAreas: readonly string[] = [];

/** A stable observable state; internal HTML Next and Vue bookkeeping attributes are excluded. */
async function observe(page: Page, testCase: ParityCase): Promise<{ behavior: unknown; pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const behavior = await page.evaluate(({ selector, expression }) => {
    const root = document.querySelector(selector);
    if (root === null) throw new Error(`Missing parity root ${selector}`);
    // The probes are authored in this test file and run in the real browser for both targets.
    return Function("root", `return ${expression}`)(root);
  }, { selector: testCase.root, expression: testCase.probe });
  const pixels = await page.locator(testCase.root).screenshot({ animations: "disabled" });
  return { behavior, pixels };
}

for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
  it.skipIf(!enabled)(`${engine} compares decoded screenshot pixels across PNG encodings`, async () => {
    const browser = await launchParityBrowser(browserType);
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="case" style="width:10px;height:10px;background:rgb(20 30 40)"></div>');
      const screenshot = await page.locator("#case").screenshot();
      assert.equal(screenshot.subarray(-8, -4).toString("ascii"), "IEND");
      // A valid PNG text chunk changes the bytes while leaving all rendered pixels intact.
      const comment = Buffer.from("0000001374455874436f6d6d656e740073616d6520706978656c73d01a19f2", "hex");
      const samePixels = Buffer.concat([screenshot.subarray(0, -12), comment, screenshot.subarray(-12)]);
      await assertPixelsEqual(page, samePixels, screenshot, "metadata-only pixels differ");
      const changedPixel = Buffer.from(await page.evaluate(async (png) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        context.fillRect(0, 0, 1, 1);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, screenshot.toString("base64")), "base64");
      await assert.rejects(assertPixelsEqual(page, changedPixel, screenshot, "changed pixels differ", page), /1 differing RGBA pixels.*recapturedParity/);
    } finally {
      await page.close();
      await browser.close();
    }
  });
}

describe.skipIf(!enabled)("HTML Next → Vue browser parity", () => {
  let directory = "";
  let liveBundle = "";
  const vueBundles = new Map<string, string>();
  const vueStyles = new Map<string, string>();
  const corpusBundles = new Map<string, string>();
  const corpusStyles = new Map<string, string>();
  let htmlHydrationBundle = "";
  let htmlServerMarkup = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-parity-"));
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const [index, testCase] of cases.entries()) {
      const caseDirectory = join(directory, String(index));
      await mkdir(join(caseDirectory, "vue"), { recursive: true });
      const artifacts = new Map([
        ...Object.entries(testCase.definitions).map(([tag, source]) => {
          const definition = parseComponent(source, `${tag}.html`);
          return { path: `vue/${definition.contract.name}.vue`, content: generateVueComponent(definition) };
        }),
        vueHostArtifact(),
        vueHtmlArtifact(),
        vueControlArtifact(),
        vuePropsArtifact(),
      ].map(({ path, content }) => [path, content]));
      const imports: string[] = [];
      const scopeAssignments: string[] = [];
      const styles: string[] = [];
      for (const [path, content] of artifacts) {
        const output = join(caseDirectory, path);
        await mkdir(join(caseDirectory, path.split("/").slice(0, -1).join("/")), { recursive: true });
        await writeFile(output, content);
        if (!path.endsWith(".vue")) continue;
        const parsed = parseVue(content, { filename: path });
        assert.deepEqual(parsed.errors, []);
        const name = path.split("/").at(-1)!.replace(/\.vue$/, "");
        const scopeId = `data-v-parity-${index}-${name.toLowerCase()}`;
        const script = compileScript(parsed.descriptor, { id: scopeId, inlineTemplate: true });
        await writeFile(output.replace(/\.vue$/, ".ts"), script.content.replace(
          /from (['"])(\.\/[^'"\n]+)\.vue\1/g,
          "from $1$2$1",
        ));
        styles.push(...parsed.descriptor.styles.map((style) => {
          const compiled = compileStyle({ source: style.content, filename: path, id: scopeId, scoped: style.scoped === true });
          assert.deepEqual(compiled.errors, []);
          return compiled.code;
        }));
        imports.push(`import ${name} from "./vue/${name}";`);
        scopeAssignments.push(`${name}.__scopeId = "${scopeId}";`);
      }
      vueStyles.set(testCase.name, styles.join("\n"));
      const entry = join(caseDirectory, "entry.ts");
      const bundle = join(caseDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";\n${imports.join("\n")}\n${scopeAssignments.join("\n")}\nwindow.parityEvents = [];\ncreateApp({ render: () => ${testCase.vueRender} }).mount(document.querySelector("main"));\n`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath], alias: validationAlias });
      vueBundles.set(testCase.name, bundle);
      if (testCase.name.startsWith("sanitized HTML")) {
        const hydrateEntry = join(caseDirectory, "hydrate.ts");
        const hydrateBundle = join(caseDirectory, "hydrate.js");
        await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";\n${imports.join("\n")}\n${scopeAssignments.join("\n")}\ncreateSSRApp({ render: () => ${testCase.vueRender} }).mount(document.querySelector("main"));\n`);
        await build({ entryPoints: [hydrateEntry], outfile: hydrateBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath], alias: validationAlias });
        const serverEntry = join(caseDirectory, "server.ts");
        await writeFile(serverEntry, `import { createSSRApp, h } from "vue";\nimport { renderToString } from "@vue/server-renderer";\n${imports.join("\n")}\n${scopeAssignments.join("\n")}\nexport const render = () => renderToString(createSSRApp({ render: () => ${testCase.vueRender} }));\n`);
        const server = await build({ entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath], alias: validationAlias });
        const module = await import(`data:text/javascript;base64,${Buffer.from(server.outputFiles[0]!.text).toString("base64")}`);
        htmlHydrationBundle = hydrateBundle;
        htmlServerMarkup = await module.render();
      }
    }

    for (const [index, testCase] of conformanceCases.entries()) {
      if ("code" in testCase.expect || knownConversionGaps.has(testCase.name) || knownVueCompileGaps.has(testCase.name)) continue;
      const scene = conformanceScene(testCase.source);
      const definition = parseComponent(scene.definition, testCase.name);
      const caseDirectory = join(directory, `corpus-${index}`);
      await mkdir(join(caseDirectory, "vue"), { recursive: true });
      const path = `vue/${definition.contract.name}.vue`;
      const source = generateVueComponent(definition);
      const parsed = parseVue(source, { filename: path });
      assert.deepEqual(parsed.errors, []);
      const scopeId = `data-v-corpus-${index}`;
      const script = compileScript(parsed.descriptor, { id: scopeId, inlineTemplate: true });
      await writeFile(join(caseDirectory, path.replace(/\.vue$/, ".ts")), script.content);
      await writeFile(join(caseDirectory, vueHostArtifact().path), vueHostArtifact().content);
      await writeFile(join(caseDirectory, vueHtmlArtifact().path), vueHtmlArtifact().content);
      await writeFile(join(caseDirectory, vuePropsArtifact().path), vuePropsArtifact().content);
      await writeFile(join(caseDirectory, vueControlArtifact().path), vueControlArtifact().content);
      const styles = parsed.descriptor.styles.map((style) => {
        const compiled = compileStyle({ source: style.content, filename: path, id: scopeId, scoped: style.scoped === true });
        assert.deepEqual(compiled.errors, []);
        return compiled.code;
      });
      corpusStyles.set(testCase.name, styles.join("\n"));
      const entry = join(caseDirectory, "entry.ts");
      const bundle = join(caseDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";\nimport ${definition.contract.name} from "./vue/${definition.contract.name}";\n${definition.contract.name}.__scopeId = "${scopeId}";\ncreateApp({ render: () => ${vueInvocation(scene.invocation, definition)} }).mount(document.querySelector("main"));\n`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath], alias: validationAlias });
      corpusBundles.set(testCase.name, bundle);
    }
  });

  it("tracks Vue conversion of every successful live-runtime conformance example", () => {
    const successes = conformanceCases.filter((testCase) => "probe" in testCase.expect);
    assert.equal(successes.length, 37, "review newly added conformance examples for Vue pixel and behavior coverage");
    for (const testCase of successes) {
      const definition = parseComponent(conformanceScene(testCase.source).definition, testCase.name);
      const gap = knownConversionGaps.get(testCase.name);
      if (gap === undefined) {
        const source = generateVueComponent(definition);
        assert.ok(source.includes("<template>"), `${testCase.name} must convert to Vue`);
        const parsed = parseVue(source, { filename: testCase.name });
        assert.deepEqual(parsed.errors, []);
        assert.ok(compileScript(parsed.descriptor, { id: testCase.name, inlineTemplate: true }).content.includes("export default"));
      } else {
        assert.throws(
          () => generateVueComponent(definition),
          (error) => error instanceof Error && error.message.startsWith(`${gap}:`),
          `${testCase.name} must remain an explicit gap until supported`,
        );
      }
    }
    assert.deepEqual(
      [...knownConversionGaps.keys()].sort(),
      successes.filter((testCase) => knownConversionGaps.has(testCase.name)).map((testCase) => testCase.name).sort(),
    );
  });

  it.skipIf(process.env.HTMLNEXT_REQUIRE_COMPLETE_VUE_PARITY !== "1")("requires complete Vue parity before React work", () => {
    const remaining = [
      ...[...knownConversionGaps.keys()].map((name) => `conversion: ${name}`),
      ...[...knownVueCompileGaps].map((name) => `Vue compilation: ${name}`),
      ...unpairedFeatureAreas.map((name) => `unpaired feature area: ${name}`),
    ];
    assert.deepEqual(remaining, [], "Vue parity is not complete; React work must remain gated");
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  for (const [engineName, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    describe(engineName, () => {
      let browser: Browser;
      beforeAll(async () => { browser = await launchParityBrowser(browserType); });
      afterAll(async () => { await browser?.close(); });

      it("hydrates sanitized $html without replacing server nodes", async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const style = vueStyles.get("sanitized HTML retains scoped styling and updates in element and inline positions");
          await page.setContent(`<style>${style}</style><main>${htmlServerMarkup}</main>`);
          await page.evaluate(() => {
            window.serverRoot = document.querySelector("#case");
            window.serverBold = document.querySelector("#case b");
          });
          await page.addScriptTag({ path: htmlHydrationBundle });
          const hydrated = await page.evaluate(() => ({
            rootKept: document.querySelector("#case") === window.serverRoot,
            boldKept: document.querySelector("#case b") === window.serverBold,
            unsafe: document.querySelectorAll("#case img, #case [onerror]").length,
          }));
          assert.deepEqual(hydrated, { rootKept: true, boldKept: true, unsafe: 0 });
          await page.locator("#case button").click();
          await page.waitForFunction(() => document.querySelector("#case i")?.textContent === "Two");
          assert.equal(await page.locator("#case b").count(), 0);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });

      it("preserves native length validity while a user types into a bound control", async () => {
        const testCase = cases.find(({ name }) => name.startsWith("native form controls"))!;
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          await live.setContent(`${Object.values(testCase.definitions).join("\n")}<main>${testCase.invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          await vue.addScriptTag({ path: vueBundles.get(testCase.name)! });
          const state = async (page: Page) => ({
            behavior: await page.locator("#case .text").evaluate((node) => {
              const input = node as HTMLInputElement;
              return { value: input.value, tooShort: input.validity.tooShort, valid: input.checkValidity(), output: document.querySelector("#case .result")?.textContent };
            }),
            pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
          });
          for (const [typed, expected] of [["b", true], ["cd", false]] as const) {
            for (const page of [live, vue]) {
              const input = page.locator("#case .text");
              await input.focus();
              await input.press("End");
              await input.pressSequentially(typed);
            }
            await Promise.all([live, vue].map((page) => page.waitForFunction((value) => document.querySelector<HTMLInputElement>("#case .text")?.value === value, typed === "b" ? "ab" : "abcd")));
            const [liveState, vueState] = await Promise.all([state(live), state(vue)]);
            assert.equal(liveState.behavior.tooShort, expected, "live runtime native validity baseline changed");
            assert.deepEqual(vueState.behavior, liveState.behavior, "bound control validity differs");
            await assertPixelsEqual(vue, vueState.pixels, liveState.pixels, "bound control pixels differ");
          }
        } finally {
          await Promise.all([live.close(), vue.close()]);
        }
      });

      it("preserves keyed nested-component output and visible native edits", async () => {
        const testCase = cases.find(({ name }) => name.startsWith("keyed nested components"))!;
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          await live.setContent(`${Object.values(testCase.definitions).join("\n")}<main>${testCase.invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          await vue.addScriptTag({ path: vueBundles.get(testCase.name)! });
          const prepare = (page: Page) => page.evaluate(() => {
            document.querySelector<HTMLInputElement>('#case li[data-id="b"] input')!.value = "user edit";
          });
          await Promise.all([prepare(live), prepare(vue)]);
          await Promise.all([live, vue].map((page) => page.locator("#case button").click()));
          const state = (page: Page) => page.evaluate(() => ({
            order: Array.from(document.querySelectorAll("#case li"), (row) => row.getAttribute("data-id")),
            edited: document.querySelector<HTMLInputElement>('#case li[data-id="b"] input')!.value,
            label: document.querySelector('#case li[data-id="b"] span')?.textContent,
          }));
          const [liveState, vueState] = await Promise.all([state(live), state(vue)]);
          assert.deepEqual(liveState, { order: ["c", "a", "b"], edited: "user edit", label: "Bee" });
          assert.deepEqual(vueState, liveState, "keyed nested-component behavior differs");
        } finally {
          await Promise.all([live.close(), vue.close()]);
        }
      });

      for (const testCase of cases) {
        it(`${testCase.name} (${testCase.features.join(", ")})`, async () => {
          const live = await browser.newPage({ viewport: { width: 800, height: 600 } });
          const vue = await browser.newPage({ viewport: { width: 800, height: 600 } });
          const errors: string[] = [];
          const releaseStale: Array<() => void> = [];
          let allFirstRequests!: () => void;
          const firstRequests = new Promise<void>((resolve) => { allFirstRequests = resolve; });
          live.on("pageerror", (error) => errors.push(`HTML Next: ${error.message}`));
          vue.on("pageerror", (error) => errors.push(`Vue: ${error.message}`));
          try {
            const style = `<style>html { color-scheme: light; } body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }</style>`;
            if (testCase.mockData !== undefined) {
              await Promise.all([live, vue].map((page) => page.route("https://api.example/**", async (route) => {
                const query = new URL(route.request().url()).searchParams.get("q");
                if (testCase.mockData === "stale" && query === "first") {
                  await new Promise<void>((resolve) => {
                    releaseStale.push(resolve);
                    if (releaseStale.length === 2) allFirstRequests();
                  });
                }
                const body = testCase.mockData === "invalid"
                  ? Number(new URL(route.request().url()).searchParams.get("round")) === 1
                    ? { label: "first", note: "kept" }
                    : { label: 42, note: "second", addedByServer: true }
                  : { label: `Result ${query}` };
                await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
              })));
            }
            await live.setContent(`${style}${Object.values(testCase.definitions).join("\n")}<main>${testCase.invocation}</main>`);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => {
              window.parityEvents = [];
              window.HtmlRuntime.lowerDocument();
              document.querySelector("#case")?.addEventListener("count-change", (event) => window.parityEvents.push((event as CustomEvent).detail));
            });
            await vue.setContent(`${style}<style>${vueStyles.get(testCase.name)}</style><main></main>`);
            await vue.addScriptTag({ path: vueBundles.get(testCase.name)! });
            if (testCase.mockData === "stale") {
              await Promise.race([firstRequests, new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("Both initial data requests did not start")), 5000))]);
            }
            const beforeReady = testCase.beforeReady;
            if (beforeReady !== undefined) await Promise.all([live, vue].map((page) => page.waitForFunction(beforeReady, undefined, { timeout: 5000 })));
            const [beforeLive, beforeVue] = await Promise.all([observe(live, testCase), observe(vue, testCase)]);
            assert.deepEqual(beforeVue.behavior, beforeLive.behavior, "initial browser behavior differs");
            await assertPixelsEqual(vue, beforeVue.pixels, beforeLive.pixels, "initial rendered pixels differ");
            await Promise.all([live, vue].map((page) => page.evaluate(({ selector, script }) => Function("root", script)(document.querySelector(selector)), { selector: testCase.root, script: testCase.action })));
            const afterReady = testCase.afterReady;
            if (afterReady !== undefined) await Promise.all([live, vue].map((page) => page.waitForFunction(afterReady, undefined, { timeout: 5000 })));
            for (const release of releaseStale) release();
            if (testCase.settleAfterMs !== undefined) await new Promise((resolve) => setTimeout(resolve, testCase.settleAfterMs));
            const [afterLive, afterVue] = await Promise.all([observe(live, testCase), observe(vue, testCase)]);
            if (testCase.expectedAfter !== undefined) assert.deepEqual(afterLive.behavior, testCase.expectedAfter, "live-runtime event contract changed");
            assert.deepEqual(afterVue.behavior, afterLive.behavior, "post-interaction browser behavior differs");
            await assertPixelsEqual(vue, afterVue.pixels, afterLive.pixels, "post-interaction rendered pixels differ", live);
            assert.deepEqual(errors, []);
          } finally {
            for (const release of releaseStale) release();
            await Promise.all([live.close(), vue.close()]);
          }
        });
      }
    });
  }

  describe("shared conformance examples", () => {
    for (const [engineName, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      describe(engineName, () => {
        let browser: Browser;
        beforeAll(async () => { browser = await launchParityBrowser(browserType); });
        afterAll(async () => { await browser?.close(); });

        for (const testCase of conformanceCases) {
          const expectation = testCase.expect;
          if ("code" in expectation || knownConversionGaps.has(testCase.name) || knownVueCompileGaps.has(testCase.name)) continue;
          it(testCase.name, async () => {
            const [live, vue] = await Promise.all([
              browser.newPage({ viewport: { width: 800, height: 600 } }),
              browser.newPage({ viewport: { width: 800, height: 600 } }),
            ]);
            try {
              const { definition, invocation } = conformanceScene(testCase.source);
              const base = `<style>html { color-scheme: light; } body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }</style>`;
              await Promise.all([
                (async () => {
                  await live.setContent(`${base}${definition}<main>${invocation}</main>`);
                  await live.addScriptTag({ path: liveBundle });
                  await live.evaluate(() => window.HtmlRuntime.lowerDocument());
                })(),
                (async () => {
                  await vue.setContent(`${base}<style>${corpusStyles.get(testCase.name)}</style><main></main>`);
                  await vue.addScriptTag({ path: corpusBundles.get(testCase.name)! });
                })(),
              ]);
              const program = `
                function snapshot(node) {
                  if (node.nodeType === Node.TEXT_NODE) return { text: node.textContent };
                  return { tag: node.localName, attributes: Array.from(node.attributes).map(a => [a.name, a.value]).sort((x, y) => x[0].localeCompare(y[0])),
                    children: Array.from(node.childNodes).filter(n => !(n.nodeType === Node.TEXT_NODE && n.textContent.trim() === "") && n.nodeType !== Node.COMMENT_NODE && n.nodeType !== Node.PROCESSING_INSTRUCTION_NODE).map(snapshot) };
                }
                const q = (s) => document.querySelector(s);
                const qa = (s) => Array.from(document.querySelectorAll(s));
                ${expectation.probe}`;
              const [liveResult, vueResult] = await Promise.all([
                live.evaluate((script) => Function(script)(), program),
                vue.evaluate((script) => Function(script)(), program),
              ]);
              assert.deepEqual(liveResult, expectation.result, "live runtime characterization changed");
              assert.deepEqual(withoutStylingMarkers(vueResult), withoutStylingMarkers(liveResult), "Vue browser behavior differs");
              const capturePixels = async (page: Page): Promise<Buffer> => {
                await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
                return page.screenshot({ animations: "disabled" });
              };
              const [livePixels, vuePixels] = await Promise.all([capturePixels(live), capturePixels(vue)]);
              await assertPixelsEqual(vue, vuePixels, livePixels, "Vue rendered pixels differ");
              for (const step of expectation.after ?? []) {
                await Promise.all([live, vue].map((page) => page.evaluate((action) => Function(action)(), step.action)));
                await Promise.all([live, vue].map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
                const [afterLivePixels, afterVuePixels] = await Promise.all([capturePixels(live), capturePixels(vue)]);
                const [afterLive, afterVue] = await Promise.all([
                  live.evaluate((script) => Function(script)(), program),
                  vue.evaluate((script) => Function(script)(), program),
                ]);
                assert.deepEqual(afterLive, step.result, "live runtime changed after interaction");
                assert.deepEqual(withoutStylingMarkers(afterVue), withoutStylingMarkers(afterLive), "Vue behavior differs after interaction");
                await assertPixelsEqual(vue, afterVuePixels, afterLivePixels, "Vue pixels differ after interaction");
              }
            } finally {
              await Promise.all([live.close(), vue.close()]);
            }
          });
        }
      });
    }
  });
});

declare global {
  interface Window {
    parityEvents: unknown[];
    HtmlRuntime: { lowerDocument(): void };
    serverRoot: Element | null;
    serverBold: Element | null;
  }
}
