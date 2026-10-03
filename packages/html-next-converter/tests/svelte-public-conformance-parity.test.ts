import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { sveltePlugin } from "./helpers/svelte.js";

import { parseComponent } from "@nextwebwg/html-next";
import { cases, type ConformanceCase } from "../../html-next/tests/conformance/cases.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
const baseStyle = "<style>html { color-scheme: light; } body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }</style>";

// Keep every successful public case accounted for as support lands.
const selected = new Set([
  "HTML parser recovery keeps the first duplicate attribute",
  "preserves SVG namespaces and camelCase attributes inside a native root",
  "keeps a single native root when $with scopes the root",
  "lowers to native root with prop :attr, passthrough attrs, and default slot",
  "lets invocation attributes win over template literals and combines class and style",
  "serializes booleans on enumerated attributes as true and false",
  "styles by camel-case props and state with :host-state()",
  "applies a prop default when the invocation omits the prop",
  "coerces number, boolean, enum, and string props",
  "attribute serialization: absent/false remove, true is present-empty, number stringifies, list space-joins",
  "invocation attributes named after Object prototype members pass through",
  "$value renders escaped text (a <b> in data is literal characters)",
  "<template $value> renders inline text with no wrapper element",
  "$html sanitizes: <script>, on* handlers, and javascript: URLs are stripped and do not execute",
  "value semantics: typed equality, invalid runtime arithmetic, boolean and/or",
  "dimensional arithmetic scales numeric parts and preserves written units",
  "$if truthiness: '' / 0 / [] / false are falsy; non-empty string and non-zero are truthy",
  "invalid structural expressions keep the last rendered region until a valid update",
  "initially invalid structural expressions render nothing until a valid update",
  "fault tolerance: a missing nested read removes the attribute / renders empty, never throws",
  "$each with $sort/$limit and the loop object (index/last/count), plus item, i binding",
  "$each $where filters and reindexes the loop",
  "$sort with multiple keys and descending (a,-b)",
  "$match/$when/$else renders only the winning arm",
  "$match selects a row inside <table><tbody>, falling back to $else",
  "a structural <template> produces no wrapper element",
  "$with binds an aliased expression into a child scope",
  "a <style> in a definition moves to <head> and the definition template is removed",
  "an absent required prop lowers with valueMissing validity",
  "an unparseable number prop renders its default and reports badInput",
  "invalid $html expressions retain the last sanitized content",
  "matches :host in :slotted() rules as the component root",
  "bind: renders its initial state; declared on: bindings are consumed",
  "reactive declarations seed once: state initializes, computed evaluates, data is pending",
  ".property binding resolves through the generated DOM contract",
]);
const shared = cases.filter((testCase) => selected.has(testCase.name) && "probe" in testCase.expect);
assert.equal(shared.length, selected.size, "Every selected public case must still exist");
assert.deepEqual(cases.filter((testCase) => "probe" in testCase.expect && !selected.has(testCase.name))
  .map((testCase) => testCase.name), [], "Every public success case must be selected");

// Converter regressions exercise the new boundaries beyond the shared initial-render cases.
interface ConverterCase extends ConformanceCase {
  readonly passthrough?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly liveSetup?: string;
  readonly hydrationOnlyProbe?: boolean;
  readonly beforeHydration?: string;
  readonly editedResult?: unknown;
}
const regressions: readonly ConverterCase[] = [
  {
    name: "native form bindings retain authored defaults, typed state and pre-hydration edits",
    source: `<template component="x-edited-form" status="early" summary="Edited controls."><defs>
      <state name="form" type="object({ text: string, number: number, checked: boolean, choice: string, choices: list(string) })" value="{ text: 'Ready', number: 4, checked: false, choice: 'b', choices: ['b'] }"></state>
      <state name="ticks" type="number" value="0"></state>
      <handler name="unrelated"><set name="ticks" expr:value="ticks + 1"></set></handler>
      <handler name="change"><set name="form.text" value="New"></set><set name="form.checked" expr:value="true"></set>
        <set name="form.choice" value="a"></set><set name="form.choices" expr:value="['a']"></set></handler>
    </defs><form><input class="text" name="text" value="authored" bind:value="form.text">
      <textarea name="area" bind:value="form.text">default area</textarea>
      <input class="number" type="number" bind:value="form.number">
      <input class="checked" type="checkbox" name="check" checked bind:checked="form.checked">
      <input class="readonly" value="original" .value="form.text">
      <select name="single" bind:value="form.choice"><option value="a" selected>A</option><option value="b">B</option></select>
      <select name="multiple" multiple bind:value="form.choices"><option value="a" selected>A</option><option value="b">B</option></select>
      <button type="button" class="unrelated" on:click="unrelated">Unrelated</button>
      <button type="button" class="change" on:click="change">Change</button>
      <output $value="concat(form.text, '/', form.checked, '/', form.choice, '/', join(form.choices, ','), '/', ticks)"></output>
    </form></template><x-edited-form></x-edited-form>`,
    hydrationOnlyProbe: true,
    beforeHydration: `const e = document.querySelector('input.text'); e.value = 'Edited'; e.focus(); e.setSelectionRange(1, 3); document.querySelector('textarea').value = 'Edited area'; document.querySelector('input.checked').checked = true;`,
    editedResult: ["Edited", "authored", "Edited area", "default area", true, true, "Ready", "original", "b", ["b"], "Ready/false/b/b/0", true, 1, 3],
    expect: { probe: `const input = q('input.text'), area = q('textarea'), check = q('input.checked'), read = q('input.readonly'); return [input.value, input.defaultValue, area.value, area.defaultValue, check.checked, check.defaultChecked, read.value, read.defaultValue, q('select[name=single]').value, Array.from(q('select[multiple]').selectedOptions, e => e.value), q('output').textContent, document.activeElement === input, input.selectionStart, input.selectionEnd];`,
      result: ["Ready", "authored", "Ready", "default area", false, true, "Ready", "original", "b", ["b"], "Ready/false/b/b/0", false, 5, 5], after: [
        { action: `document.querySelector('button.unrelated').click();`, result: ["Edited", "authored", "Edited area", "default area", true, true, "Ready", "original", "b", ["b"], "Ready/false/b/b/1", true, 1, 3] },
        { action: `document.querySelector('button.change').click();`, result: ["New", "authored", "New", "default area", true, true, "New", "original", "a", ["a"], "New/true/a/a/1", true, 3, 3] },
        { action: `document.querySelector('form').reset();`, result: ["authored", "authored", "default area", "default area", true, true, "original", "original", "a", ["a"], "New/true/a/a/1", true, 8, 8] },
      ] },
  },

  {
    name: "nested native and generic bindings use native input types and destination checks",
    source: `<template component="x-binding-types" status="early" summary="Binding types."><defs>
      <state name="form" type="object({ text: string, number: number, checked: boolean, choice: string, choices: list(string) })" value="{ text: 'Ready', number: 4, checked: false, choice: 'b', choices: ['b'] }"></state>
      <state name="items" type="list(string)" value="['a', 'b']"></state>
      <handler name="remove"><set name="items" expr:value="['a']"></set></handler>
      <handler name="restore"><set name="items" expr:value="['a', 'b']"></set></handler>
    </defs><section><input class="number" type="number" bind:value="form.number">
      <input class="range" type="range" min="0" max="10" bind:value="form.number">
      <input class="check" type="checkbox" bind:checked="form.checked">
      <input class="radio" type="radio" bind:checked="form.checked">
      <input class="text" bind:value="form.text">
      <output class="generic" bind:value="form.text"></output>
      <select class="choice" bind:value="form.choice"><option $each="item of items" from:value="item" $value="item"></option></select>
      <select class="multiple" multiple bind:value="form.choices"><option value="a">A</option><option value="b">B</option></select>
      <button class="remove" on:click="remove">Remove</button><button class="restore" on:click="restore">Restore</button>
      <p $value="concat(form.text, '/', form.number, '/', form.checked, '/', form.choice, '/', join(form.choices, ','))"></p>
    </section></template><x-binding-types></x-binding-types>`,
    expect: { probe: `return [q('input.number').value, q('input.range').value, q('input.check').checked, q('input.radio').checked, q('input.text').value, q('output').getAttribute('value'), q('select.choice').value, Array.from(q('select.multiple').selectedOptions, e => e.value), q('p').textContent];`,
      result: ["4", "4", false, false, "Ready", "Ready", "b", ["b"], "Ready/4/false/b/b"], after: [
        { action: `const e = document.querySelector('input.number'); e.value = '7'; e.dispatchEvent(new Event('input', { bubbles: true }));`, result: ["7", "7", false, false, "Ready", "Ready", "b", ["b"], "Ready/7/false/b/b"] },
        { action: `const e = document.querySelector('input.check'); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true }));`, result: ["7", "7", true, true, "Ready", "Ready", "b", ["b"], "Ready/7/true/b/b"] },
        { action: `const e = document.querySelector('input.radio'); e.checked = false; e.dispatchEvent(new Event('change', { bubbles: true }));`, result: ["7", "7", true, false, "Ready", "Ready", "b", ["b"], "Ready/7/true/b/b"] },
        { action: `const e = document.querySelector('output'); e.value = 'Generic'; e.dispatchEvent(new Event('input', { bubbles: true }));`, result: ["7", "7", true, false, "Generic", "Generic", "b", ["b"], "Generic/7/true/b/b"] },
        { action: `const e = document.querySelector('select.multiple'); for (const o of e.options) o.selected = true; e.dispatchEvent(new Event('change', { bubbles: true }));`, result: ["7", "7", true, false, "Generic", "Generic", "b", ["a", "b"], "Generic/7/true/b/a,b"] },
        { action: `document.querySelector('button.remove').click();`, result: ["7", "7", true, false, "Generic", "Generic", "", ["a", "b"], "Generic/7/true/b/a,b"] },
        { action: `document.querySelector('button.restore').click();`, result: ["7", "7", true, false, "Generic", "Generic", "b", ["a", "b"], "Generic/7/true/b/a,b"] },
      ] },
  },

  {
    name: "native property bindings preserve setters and retain invalid results",
    source: `<template component="x-native-properties" status="early" summary="Native properties."><defs>
      <state name="count" type="number" value="1"></state><state name="disabled" type="boolean" value="false"></state>
      <state name="label" type="string" value="Ready"></state>
      <handler name="invalid"><set name="count" expr:value="0"></set><set name="disabled" expr:value="true"></set></handler>
      <handler name="valid"><set name="count" expr:value="2"></set><set name="disabled" expr:value="false"></set></handler>
    </defs><section><p class="content" .textContent="40px / count"></p>
      <button class="bound" .disabled="disabled" .title="40px / count">Bound</button>
      <div class="scroll" style="height: 20px; overflow: auto" .scrollTop="20 / count"><div style="height: 200px"></div></div>
      <input class="generic" value="Authored" bind:title="label"><output $value="label"></output>
      <button class="invalid" on:click="invalid">Invalid</button><button class="valid" on:click="valid">Valid</button>
    </section></template><x-native-properties></x-native-properties>`,
    hydrationOnlyProbe: true,
    expect: { probe: `return [q('p.content').textContent, q('p.content').childElementCount, q('button.bound').disabled, q('button.bound').title, q('div.scroll').scrollTop, q('input.generic').getAttribute('title'), q('output').textContent];`,
      result: ["40px", 0, false, "40px", 0, "Ready", "Ready"], after: [
        { action: `document.querySelector('button.invalid').click();`, result: ["40px", 0, true, "40px", 0, "Ready", "Ready"] },
        { action: `document.querySelector('button.valid').click();`, result: ["20px", 0, false, "20px", 10, "Ready", "Ready"] },
        { action: `const e = document.querySelector('input.generic'); e.value = 'Edited'; e.dispatchEvent(new Event('input', { bubbles: true }));`, result: ["20px", 0, false, "20px", 10, "Edited", "Edited"] },
      ] },
  },

  {
    name: "named and dynamic slot snippets preserve projection and fallbacks",
    dependencies: { "panel.html": `<template component="x-panel" status="early" summary="Panel."><defs>
      <state name="slotName" value="title"></state><handler name="rotate"><set name="slotName" value="secondary"></set></handler>
      </defs><section><header><slot from:name="slotName"><b>Untitled</b></slot></header><main><slot><i>Empty</i></slot></main>
        <button class="rotate" on:click="rotate">Rotate</button></section>
      <style>:host { display: block; background: rgb(238 244 250); padding: 4px; } header { color: rgb(32 48 64); }
        h2 { font-style: italic; } :slotted(h2) { color: rgb(200 20 30); }</style></template>` },
    source: `<template component="x-slot-app" status="early" summary="Slot app."><defs>
      <state name="heading" value="Title"></state><handler name="rename"><set name="heading" value="Changed"></set></handler>
      </defs><article><x-panel><h2 slot="title" $value="heading"></h2><h3 slot="secondary">Second</h3><p>Body</p></x-panel>
        <x-panel></x-panel><button class="rename" on:click="rename">Rename</button></article></template><x-slot-app></x-slot-app>`,
    expect: { probe: `return [qa('section header').map(e => e.textContent.trim()), qa('section main').map(e => e.textContent.trim()), q('h2') ? getComputedStyle(q('h2')).color : null, q('h2') ? getComputedStyle(q('h2')).fontStyle : null, qa('x-panel, slot').length];`,
      result: [["Title", "Untitled"], ["Body", "Empty"], "rgb(200, 20, 30)", "normal", 0], after: [
        { action: `document.querySelector('button.rename').click();`, result: [["Changed", "Untitled"], ["Body", "Empty"], "rgb(200, 20, 30)", "normal", 0] },
        { action: `document.querySelector('button.rotate').click();`, result: [["Changed", "Untitled"], ["Body", "Empty"], "rgb(200, 20, 30)", "normal", 0] },
      ] },
  },
  {
    name: "scoped slot snippets keep child row names and parent expressions separate",
    dependencies: { "rows.html": `<template component="x-rows" status="early" summary="Rows."><defs>
      <state name="rows" type="list(unknown)" value="[{ id: 'a', name: 'Ada' }]"></state>
      <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
      </defs><div><button class="add" on:click="add">Add</button><ul>
        <slot name="row" $each="row of rows" $key="row.id" from:item="row" from:index="loop.index"><li>Missing</li></slot>
      </ul></div><style>:host { display: block; background: rgb(238 244 250); padding: 4px; } li { font-weight: bold; }
        :slotted(li) { color: rgb(32 48 64); }</style></template>` },
    source: `<template component="x-scoped-app" status="early" summary="Scoped app."><defs>
      <state name="item" type="object" value="{ name: 'Parent' }"></state><state name="heading" value="Team"></state>
      <handler name="rename"><set name="heading" value="Group"></set></handler></defs>
      <article><button class="rename" on:click="rename">Rename</button><output $value="item.name"></output>
        <x-rows><template slot="row"><li .title="item.name"><b $value="item.name"></b><em $value="heading"></em><small $value="index"></small><input .value="item.name"></li></template></x-rows>
        <x-rows></x-rows></article></template><x-scoped-app></x-scoped-app>`,
    expect: { probe: `return [q('output').textContent, qa('ul').map(e => Array.from(e.querySelectorAll('li'), e => e.textContent)), qa('ul')[0] ? Array.from(qa('ul')[0].querySelectorAll('li'), e => [e.title, e.querySelector('input').value, getComputedStyle(e).color, getComputedStyle(e).fontWeight]) : []];`,
      result: ["Parent", [["AdaTeam0"], ["Missing"]], [["Ada", "Ada", "rgb(32, 48, 64)", "400"]]], after: [
        { action: `document.querySelector('button.rename').click();`, result: ["Parent", [["AdaGroup0"], ["Missing"]], [["Ada", "Ada", "rgb(32, 48, 64)", "400"]]] },
        { action: `document.querySelector('button.add').click();`, result: ["Parent", [["AdaGroup0", "BeaGroup1"], ["Missing"]], [["Ada", "Ada", "rgb(32, 48, 64)", "400"], ["Bea", "Bea", "rgb(32, 48, 64)", "400"]]] },
      ] },
  },

  {
    name: "scoped slot snippets retain each invalid prop independently per row",
    dependencies: { "measures.html": `<template component="x-measures" status="early" summary="Measured rows."><defs>
      <state name="rows" type="list(object({ id: string, width: length }))" value="[{ id: 'a', width: '8px' }, { id: 'b', width: '4px' }]"></state>
      <handler name="invalidate"><set name="rows.0.width" value="1rem"></set></handler>
      <handler name="restore"><set name="rows.0.width" value="2px"></set><set name="rows.1.width" value="6px"></set></handler>
      </defs><section><button class="invalidate" on:click="invalidate">Invalidate</button><button class="restore" on:click="restore">Restore</button>
        <slot name="measure" $each="row of rows" $key="row.id" from:item="min(row.width, 5px)" from:index="loop.index"></slot></section></template>` },
    source: `<template component="x-measure-app" status="early" summary="Measure app."><div><x-measures>
      <template slot="measure"><span .title="item" $value="concat(item, '/', index)"></span><input .value="item"></template>
      </x-measures></div></template><x-measure-app></x-measure-app>`,
    expect: { probe: `return [qa('span').map(e => [e.textContent, e.title]), qa('input').map(e => e.value)];`,
      result: [[["5px/0", "5px"], ["4px/1", "4px"]], ["5px", "4px"]], after: [
        { action: `document.querySelector('button.invalidate').click();`, result: [[["5px/0", "5px"], ["4px/1", "4px"]], ["5px", "4px"]] },
        { action: `document.querySelector('button.restore').click();`, result: [[["2px/0", "2px"], ["5px/1", "5px"]], ["2px", "5px"]] },
      ] },
  },

  {
    name: "delegated component roots share native attributes, refs and declared events",
    dependencies: { "base.html": `<template component="x-base-button" status="early" summary="Base button.">
      <button type="button" class="base" style="padding: 4px"><slot></slot></button>
      <style>:host { border: 2px solid rgb(20 70 130); padding: 4px; font: 16px/24px Arial, sans-serif; }</style></template>` },
    source: `<template component="x-primary" status="early" summary="Primary button."><defs>
      <prop name="label" type="string" required>Label.</prop><state name="active" type="boolean" value="false"></state>
      <event name="change" type="boolean" composed="false" cancelable="true">Change.</event>
      <handler name="toggle"><set name="active" expr:value="active = false"></set><dispatch event="change" expr:value="active"></dispatch><focus ref="root"></focus></handler>
      </defs><x-base-button $ref="root" class="primary" style="padding: 6px" class:active="active" from:data-active="active" on:click="toggle"><slot></slot></x-base-button>
      <style>:host { color: rgb(170 20 20); } :host(.active) { background: rgb(230 240 250); }</style></template>
      <x-primary id="case" class="outside active" label="Ready">Go</x-primary>`,
    hydrationOnlyProbe: true,
    expect: { probe: `const e = q('#case'); return [e.localName, e.getAttribute('data-component'), e.className, e.getAttribute('data-active'), getComputedStyle(e).padding, e.textContent.trim(), e.getAttribute('data-label'), e.validity.valid, document.activeElement === e, window.changes ?? []];`,
      result: ["button", "x-primary x-base-button", "base primary outside", null, "6px", "Go", "Ready", true, false, []], after: [
        { action: `window.changes = []; const e = document.querySelector('#case'); e.addEventListener('change', e => window.changes.push([e.detail, e.bubbles, e.composed, e.cancelable])); e.click();`, result: ["button", "x-primary x-base-button", "base primary outside active", "", "6px", "Go", "Ready", true, true, [[true, true, false, true]]] },
        { action: `document.querySelector('#case').click();`, result: ["button", "x-primary x-base-button", "base primary outside", null, "6px", "Go", "Ready", true, true, [[true, true, false, true], [false, true, false, true]]] },
      ] },
  },

  {
    name: "guarded nested handlers preserve types and sequential computed reads",
    source: `<template component="x-handler-path" status="early" summary="Nested handlers."><defs>
      <state name="form" type="object({ rows: list(object({ name: string })), index: number })" value="{ rows: [{ name: 'Ada' }, { name: 'Bea' }], index: 1 }"></state>
      <state name="count" type="number" value="0"></state>
      <computed name="next" from="count + 1"></computed>
      <handler name="rename"><set name="form.rows[form.index].name" value="Ann"></set><set name="form.index" expr:value="0"></set>
        <set name="form.rows[form.index].name" value="Zoe" $if="form.index = 0"></set>
        <set name="count" expr:value="next"></set><set name="count" expr:value="next"></set></handler>
      <handler name="wrong"><set name="count" expr:value="concat(count)"></set><set name="form.rows[0].name" expr:value="7"></set>
        <set name="form.rows[9].name" value="Missing"></set><set name="count" expr:value="99" $if="false"></set></handler>
    </defs><section><output $value="concat(form.rows[0].name, '/', form.rows[1].name, '/', count)"></output>
      <button class="rename" on:click="rename">Rename</button><button class="wrong" on:click="wrong">Invalid</button>
    </section></template><x-handler-path></x-handler-path>`,
    expect: { probe: `return q('output').textContent;`, result: "Ada/Bea/0", after: [
      { action: `document.querySelector('button.rename').click();`, result: "Zoe/Ann/2" },
      { action: `document.querySelector('button.wrong').click();`, result: "Zoe/Ann/2" },
    ] },
  },
  {
    name: "native filtered events dispatch declared detail and run ref actions",
    source: `<template component="x-native-actions" status="early" summary="Native events."><defs>
      <state name="count" type="number" value="0"></state>
      <event name="change" type="number" bubbles="true" cancelable="true">Count.</event>
      <handler name="send"><set name="count" expr:value="count + 1"></set><dispatch event="change" expr:value="count"></dispatch>
        <focus ref="field"></focus><validate ref="field"></validate></handler>
    </defs><section><input $ref="field" required><output $value="count"></output>
      <button class="send" on:click.self.prevent="send">Send<span>Nested</span></button>
      <button class="key" on:keydown.enter.once="send">Key</button></section></template><x-native-actions></x-native-actions>`,
    expect: { probe: `const e = q('section'); return [q('output').textContent, e.getAttribute('data-detail'), e.getAttribute('data-invalid'), document.activeElement === q('input')];`,
      result: ["0", null, null, false], after: [
        { action: `const e = document.querySelector('section'); e.addEventListener('change', (event) => { e.setAttribute('data-detail', String(event.detail) + '/' + event.bubbles + '/' + event.cancelable); event.preventDefault(); }); e.querySelector('input').addEventListener('invalid', (event) => { e.setAttribute('data-invalid', 'yes'); event.preventDefault(); }); e.querySelector('button span').click();`, result: ["0", null, null, false] },
        { action: `document.querySelector('button.send').click();`, result: ["1", "1/true/true", "yes", true] },
        { action: `const e = document.querySelector('button.key'); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`, result: ["2", "2/true/true", "yes", true] },
      ] },
  },

  {
    name: "generic bindings reflect attributes and update before declared input handlers",
    source: `<template component="x-output" status="early" summary="Bound output."><defs>
      <state name="value" value="x"></state><state name="last" value="-"></state>
      <handler name="record"><set name="last" expr:value="value"></set></handler>
      <handler name="change"><set name="value" value="y"></set></handler>
      <handler name="clear"><set name="value" expr:value="null"></set></handler>
    </defs><div><output bind:value="value" on:input="record"></output><span $value="last"></span>
      <button class="change" on:click="change">Change</button><button class="clear" on:click="clear">Clear</button>
    </div></template><x-output></x-output>`,
    expect: {
      probe: `const e = q('output'); return [e.getAttribute('value'), e.value, q('span').textContent];`,
      result: ["x", "", "-"],
      after: [
        { action: `document.querySelector('button.change').click();`, result: ["y", "", "-"] },
        { action: `const e = document.querySelector('output'); e.value = 'typed'; e.dispatchEvent(new Event('input', { bubbles: true }));`, result: ["typed", "typed", "typed"] },
        { action: `document.querySelector('button.clear').click();`, result: [null, "typed", "typed"] },
      ],
    },
  },
  {
    name: "generic bindings read the value attribute when the element has no value property",
    source: `<template component="x-generic" status="early" summary="Generic input."><defs>
      <state name="value" value="x"></state>
    </defs><div><i bind:value="value"></i><span $value="value"></span></div></template><x-generic></x-generic>`,
    expect: {
      probe: `return [q('i').getAttribute('value'), q('span').textContent];`, result: ["x", "x"],
      after: [{ action: `const e = document.querySelector('i'); e.setAttribute('value', 'updated'); e.dispatchEvent(new Event('input', { bubbles: true }));`, result: ["updated", "updated"] }],
    },
  },
  {
    name: "generic root bindings override authored and invocation value attributes",
    source: `<template component="x-root-output" status="early" summary="Bound root."><defs>
      <state name="value" value="x"></state>
    </defs><output value="authored" bind:value="value"></output></template><x-root-output value="incoming"></x-root-output>`,
    expect: { probe: `return [q('output').getAttribute('value'), q('output').textContent];`, result: ["x", ""] },
  },
  {
    name: "generic root bindings preserve a native consumer input callback",
    source: `<template component="x-input-callback" status="early" summary="Input callback."><defs>
      <state name="value" value="x"></state>
    </defs><output bind:value="value"></output></template><x-input-callback></x-input-callback>`,
    passthrough: `oninput={(event) => event.currentTarget.setAttribute('data-observed', 'called')}`,
    liveSetup: `document.querySelector('output').addEventListener('input', (event) => event.currentTarget.setAttribute('data-observed', 'called'));`,
    expect: {
      probe: `const e = q('output'); return [e.getAttribute('value'), e.getAttribute('data-observed')];`, result: ["x", null],
      after: [{ action: `const e = document.querySelector('output'); e.value = 'typed'; e.dispatchEvent(new Event('input', { bubbles: true }));`, result: ["typed", "called"] }],
    },
  },
  {
    name: "reflected disabled properties update without leaving a directive attribute",
    source: `<template component="x-disabled" status="early" summary="Disabled property."><defs>
      <state name="disabled" type="boolean" value="true"></state>
      <handler name="enable"><set name="disabled" expr:value="false"></set></handler>
    </defs><div><button class="target" disabled .disabled="disabled">Target</button>
      <button class="enable" on:click="enable">Enable</button></div></template><x-disabled></x-disabled>`,
    expect: {
      probe: `const e = q('button.target'); return [e.disabled, e.hasAttribute('disabled'), e.hasAttribute('.disabled')];`,
      result: [true, true, false], after: [{ action: `document.querySelector('button.enable').click();`, result: [false, false, false] }],
    },
  },
  {
    name: "slot styling excludes authored fallback and sanitized HTML while reaching projected descendants",
    source: `<template component="x-styled-slot" status="early" summary="Styled projection.">
      <div><p class="owned">Owned</p><section><slot><p>Fallback</p></slot></section>
        <aside $html="'&lt;p&gt;&lt;span&gt;HTML&lt;/span&gt;&lt;/p&gt;'"></aside></div>
      <style>p { color: rgb(1, 2, 3); } span { font-weight: bold; }
        :slotted(p) { color: rgb(5, 6, 7); } :slotted(span) { font-style: italic; }</style>
    </template><x-styled-slot id="projected"><p><span>Projected</span></p></x-styled-slot><x-styled-slot id="fallback"></x-styled-slot>`,
    expect: {
      probe: `const style = (s) => getComputedStyle(q(s)); return [style('#projected > p').color, style('#projected section p').color,
        style('#projected section span').fontStyle, style('#projected section span').fontWeight,
        style('#projected aside p').color, style('#projected aside span').fontStyle,
        style('#projected aside span').fontWeight, style('#fallback section p').color];`,
      result: ["rgb(1, 2, 3)", "rgb(5, 6, 7)", "italic", "400", "rgb(1, 2, 3)", "normal", "700", "rgb(1, 2, 3)"],
    },
  },
];
const successful: readonly ConverterCase[] = [...shared, ...regressions];

type HtmlNode = {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly sourceCodeLocation?: { readonly startOffset: number; readonly endOffset: number };
};

function scene(source: string): { readonly definition: string; readonly invocation: string } {
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes as readonly HtmlNode[];
  const carrier = nodes.find((node) => node.tagName === "template" && node.attrs?.some((attribute) => attribute.name === "component"));
  assert.ok(carrier?.sourceCodeLocation, "the shared case must contain a component definition");
  return {
    definition: source.slice(carrier.sourceCodeLocation.startOffset, carrier.sourceCodeLocation.endOffset),
    invocation: source.slice(carrier.sourceCodeLocation.endOffset),
  };
}

function consumer(invocation: string, tag: string, name: string, props: Readonly<Record<string, { readonly type: unknown }>>,
  passthrough = ""): string {
  const nodes = parseFragment(invocation).childNodes as readonly HtmlNode[];
  const render = (node: HtmlNode): string => {
    if (node.nodeName === "#text") return node.value?.trim() === "" ? "" : `{${JSON.stringify(node.value)}}`;
    if (node.tagName === undefined) return "";
    const component = node.tagName === tag;
    const attributes = (node.attrs ?? []).map(({ name: attribute, value }) => {
      const prop = component ? Object.keys(props).find((key) => key.toLowerCase() === attribute) : undefined;
      const type = prop === undefined ? undefined : props[prop]?.type;
      const typed = type === "number" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value)
        : type === "boolean" ? value !== "false" : value;
      return `${prop ?? attribute}={${JSON.stringify(typed)}}`;
    }).join(" ");
    const element = component ? name : node.tagName;
    const open = `<${element}${attributes === "" ? "" : ` ${attributes}`}${!component || passthrough === "" ? "" : ` ${passthrough}`}`;
    const children = (node.childNodes ?? []).map(render).join("");
    if (children === "") return `${open} />`;
    return `${open}>${children}</${element}>`;
  };
  const markup = nodes.map(render).join("");
  assert.notEqual(markup, "", "the shared case must invoke a component");
  return markup;
}

function withoutStylingMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStylingMarkers);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "attributes" && Array.isArray(entry)
      ? entry.filter((attribute) => Array.isArray(attribute) && !["data-slotted", "data-html-next-owner"].includes(attribute[0]))
      : withoutStylingMarkers(entry),
  ]));
}


async function capturePixels(page: Page): Promise<Buffer> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return page.screenshot({ animations: "disabled" });
}

describe.skipIf(!enabled)("public Svelte converter shared conformance parity", () => {
  let directory = "";
  let liveBundle = "";
  const artifacts = new Map<string, { readonly bundle: string; readonly css: string; readonly server: string; readonly serverError?: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-public-conformance-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime",
      platform: "browser", target: ["es2022"] });
    for (const [index, testCase] of successful.entries()) {
      const { definition, invocation } = scene(testCase.source);
      const parsed = parseComponent(definition, testCase.name);
      for (const mode of ["application", "library"] as const) {
        const caseDirectory = join(directory, String(index), mode);
        await mkdir(caseDirectory, { recursive: true });
        const links = Object.keys(testCase.dependencies ?? {}).map((file) => `<link rel="component" href="./${file}">`).join("");
        for (const [file, source] of Object.entries(testCase.dependencies ?? {})) await writeFile(join(caseDirectory, file), source);
        await writeFile(join(caseDirectory, "component.html"), links + definition);
        const outDirectory = join(caseDirectory, "out");
        const manifest = await convertComponents({ mode, target: "svelte", entries: ["component.html"], root: caseDirectory, outDirectory });
        assert.equal(manifest.components.length, 1 + Object.keys(testCase.dependencies ?? {}).length);
        const component = manifest.components.find((entry) => entry.tag === parsed.contract.tag)!;
        const wrapper = join(outDirectory, "App.svelte");
        await writeFile(wrapper, `<script>import ${component.name} from "./${component.artifact}";</script>\n${consumer(invocation, parsed.contract.tag, component.name, parsed.contract.props, testCase.passthrough)}`);
        const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
          .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
        const browserEntry = join(outDirectory, "browser.ts");
        const bundle = join(outDirectory, "svelte.js");
        await writeFile(browserEntry, `import { mount, hydrate } from "svelte";\nimport App from "./App.svelte";\nconst target = document.querySelector("main")!;\nif (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
        await build({ entryPoints: [browserEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [nodeModules], plugins: [sveltePlugin("client")] });
        const serverEntry = join(outDirectory, "server.ts");
        const serverBundle = join(outDirectory, "server.mjs");
        await writeFile(serverEntry, `import { render } from "svelte/server";\nimport App from "./App.svelte";\nexport const html = render(App).body;`);
        await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
          packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
        let server = "";
        let serverError: string | undefined;
        try { server = (await import(pathToFileURL(serverBundle).href) as { html: string }).html; }
        catch (error) { serverError = String(error); }
        artifacts.set(`${index}:${mode}`, { bundle, css, server, ...(serverError === undefined ? {} : { serverError }) });
      }
    }
  }, 120_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      describe(`${engine} ${mode}`, () => {
        let browser: Browser;
        beforeAll(async () => { browser = await launchParityBrowser(browserType); });
        afterAll(async () => { await browser?.close(); });

        for (const [index, testCase] of successful.entries()) {
          it(testCase.name, async () => {
            const [live, svelte, hydrated] = await Promise.all([browser.newPage({ viewport: { width: 800, height: 600 } }),
              browser.newPage({ viewport: { width: 800, height: 600 } }), browser.newPage({ viewport: { width: 800, height: 600 } })]);
            const errors: string[] = [];
            const warnings: string[] = [];
            try {
              const { definition, invocation } = scene(testCase.source);
              const output = artifacts.get(`${index}:${mode}`)!;
              assert.equal(output.serverError, undefined, `Svelte server rendering failed: ${output.serverError}`);
              for (const page of [live, svelte, hydrated]) page.on("pageerror", (error) => errors.push(error.message));
              hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
              await live.setContent(`${baseStyle}${Object.values(testCase.dependencies ?? {}).join("")}${definition}<main>${invocation}</main>`);
              await live.addScriptTag({ path: liveBundle });
              await live.evaluate(() => window.HtmlRuntime.lowerDocument());
              if (testCase.liveSetup !== undefined) await live.evaluate((script) => Function(script)(), testCase.liveSetup);
              await svelte.setContent(`${baseStyle}<style>${output.css}</style><main></main>`);
              await svelte.addScriptTag({ path: output.bundle });
              await hydrated.setContent(`${baseStyle}<style>${output.css}</style><main>${output.server}</main>`);
              assert.ok("probe" in testCase.expect);
              const program = `
                function snapshot(node) {
                  if (node.nodeType === Node.TEXT_NODE) return { text: node.textContent };
                  return { tag: node.localName, attributes: Array.from(node.attributes).map(a => [a.name, a.value]).sort((x, y) => x[0].localeCompare(y[0])),
                    children: Array.from(node.childNodes).filter(n => !(n.nodeType === Node.TEXT_NODE && n.textContent.trim() === "") && n.nodeType !== Node.COMMENT_NODE && n.nodeType !== Node.PROCESSING_INSTRUCTION_NODE).map(snapshot) };
                }
                const q = (s) => document.querySelector(s);
                const qa = (s) => Array.from(document.querySelectorAll(s));
                ${testCase.expect.probe}`;
              const requiresHydration = testCase.hydrationOnlyProbe === true || testCase.expect.probe.includes(".validity.");
              try {
                await svelte.waitForFunction(() => document.querySelector("main")?.childElementCount !== 0, undefined, { timeout: 3_000 });
              } catch (error) {
                assert.fail(`Svelte produced no root: ${String(error)}; errors=${errors.join(" | ")}; html=${await svelte.locator("main").innerHTML()}; server=${output.server}`);
              }
              const [liveResult, svelteResult, serverResult] = await Promise.all([
                live.evaluate((script) => Function(script)(), program),
                svelte.evaluate((script) => Function(script)(), program),
                requiresHydration ? Promise.resolve(undefined) : hydrated.evaluate((script) => Function(script)(), program),
              ]);
              assert.deepEqual(liveResult, testCase.expect.result, "live runtime characterization changed");
              assert.deepEqual(withoutStylingMarkers(svelteResult), withoutStylingMarkers(liveResult), "public Svelte browser behavior differs");
              if (!requiresHydration) assert.deepEqual(withoutStylingMarkers(serverResult), withoutStylingMarkers(liveResult), "public Svelte server behavior differs");
              await assertPixelsEqual(svelte, await capturePixels(svelte), await capturePixels(live), "public Svelte rendered pixels differ", live);
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Svelte server-rendered pixels differ", live);
              if (testCase.beforeHydration !== undefined) {
                await Promise.all([live, svelte, hydrated].map((page) => page.evaluate((action) => Function(action)(), testCase.beforeHydration!)));
              }
              await hydrated.addScriptTag({ path: output.bundle });
              const hydratedResult = await hydrated.evaluate((script) => Function(script)(), program);
              assert.deepEqual(withoutStylingMarkers(hydratedResult), withoutStylingMarkers(testCase.editedResult ?? liveResult), "public Svelte hydrated behavior differs");
              if (testCase.editedResult !== undefined) {
                assert.deepEqual(await live.evaluate((script) => Function(script)(), program), testCase.editedResult, "native edit characterization differs");
                assert.deepEqual(await svelte.evaluate((script) => Function(script)(), program), testCase.editedResult, "client native edit differs");
              }
              await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "public Svelte hydrated pixels differ", live);
              for (const step of testCase.expect.after ?? []) {
                await Promise.all([live, svelte, hydrated].map((page) => page.evaluate((action) => Function(action)(), step.action)));
                await Promise.all([live, svelte, hydrated].map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
                const [liveAfter, svelteAfter, hydratedAfter] = await Promise.all([live, svelte, hydrated].map((page) => page.evaluate((script) => Function(script)(), program)));
                assert.deepEqual(liveAfter, step.result, "live runtime changed after interaction");
                assert.deepEqual(withoutStylingMarkers(svelteAfter), withoutStylingMarkers(liveAfter), "Svelte browser behavior differs after interaction");
                assert.deepEqual(withoutStylingMarkers(hydratedAfter), withoutStylingMarkers(liveAfter), "Svelte hydrated behavior differs after interaction");
                await assertPixelsEqual(svelte, await capturePixels(svelte), await capturePixels(live), "Svelte pixels differ after interaction", live);
                await assertPixelsEqual(hydrated, await capturePixels(hydrated), await capturePixels(live), "Svelte hydrated pixels differ after interaction", live);
              }
              assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), [], "Svelte reported a hydration mismatch");
              assert.deepEqual(errors, []);
            } finally {
              await Promise.all([live.close(), svelte.close(), hydrated.close()]);
            }
          });
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
