// Oracle v3: path A (authored -> lowered) and path B (serialized rendered form -> hydrated) must build the
// same internal instance (explicit props, prop values, projected nodes per slot), and behave the same
// after the same later change.
import { chromium, firefox, webkit } from "playwright";
import { build } from "esbuild";
const here = new URL(".", import.meta.url);
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", here).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const definitions = `
<template component="x-card" status="early" summary="t."><defs><prop name="tone" type="string" default="info">T.</prop></defs>
  <article class="card"><header><slot name="title">Untitled</slot></header><div class="body"><slot></slot></div></article></template>
<template component="x-adj" status="early" summary="t."><p>Hello <slot></slot>!</p></template>
<template component="x-if" status="early" summary="t."><defs><prop name="open" type="boolean" default="false">O.</prop></defs>
  <div><section $if="open"><slot name="extra">none</slot></section><slot></slot></div></template>
<template component="x-toggle" status="early" summary="t."><defs>
  <state name="open" :value="false"></state>
  <handler name="toggle"><set name="open" :value="not open"></set></handler></defs>
  <div><button type="button" on:click="toggle">More</button><section $if="open"><slot name="extra">none</slot></section><slot></slot></div></template>
<template component="x-list" status="early" summary="t."><defs><prop name="rows" type="list(string)" default="[]">R.</prop></defs>
  <ul><li $each="row of rows" $key="row"><slot :name="format('row-%s', row)">Unnamed</slot></li></ul></template>
<template component="x-wrap" status="early" summary="t."><section><x-card><span slot="title"><slot name="heading"></slot></span><slot></slot></x-card></section></template>
<template component="x-bound" status="early" summary="t."><defs><prop name="tone" type="string" default="info">T.</prop></defs>
  <article :data-tone="tone"><slot></slot></article></template>`;
const cases = [
  { name: "named + default, then prop change", authored: `<x-card><b slot="title">T</b>Body <i>x</i></x-card>`, change: ["attr", "data-tone", "warn"] },
  { name: "text beside template text", authored: `<x-adj>world</x-adj>` },
  { name: "fallback shown", authored: `<x-card>only body</x-card>` },
  { name: "slot under $if, then prop opens it", authored: `<x-if><i slot="extra">E</i>main</x-if>`, change: ["attr", "data-open", "true"] },
  { name: "slot under $if, then a click handler opens it", authored: `<x-toggle><i slot="extra">E</i>main</x-toggle>`, change: ["click"] },
  { name: "$each row added later", authored: `<x-list rows='["a"]'><span slot="row-b">B!</span></x-list>`, change: ["attr", "data-rows", '["a","b"]'] },
  { name: "slot passthrough into nested component", authored: `<x-wrap><em slot="heading">H</em>Inner</x-wrap>` },
  { name: "PENDING decision 2: default prop, template binds data-tone", authored: `<x-bound>x</x-bound>` },
];
const tags = "x-card,x-adj,x-if,x-toggle,x-list,x-wrap,x-bound";
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${definitions}</body>`);
  await page.addScriptTag({ content: runtime });
  const out = await page.evaluate(async ({ cases, tags }) => {
    window.__rangeMarkers = true;
    const R = window.HtmlRuntime;
    const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const settle = async (box) => { for (let i = 0; i < 20 && box.querySelector(tags); i += 1) { R.lowerDocument(); await tick(); } await tick(); };
    const shapes = (box) => [...box.querySelectorAll("[data-component-root]")].map((el) => R.inspectInstance(el));
    const results = [];
    for (const { name, authored, change } of cases) {
      const a = document.createElement("div"); a.setHTMLUnsafe(authored); document.body.append(a); await settle(a);
      const serialized = R.serializeRenderedForm(a);
      const b = document.createElement("div"); b.setHTMLUnsafe(serialized); document.body.append(b);
      R.lowerDocument(); await tick(); await tick();
      const shapeA = JSON.stringify(shapes(a)), shapeB = JSON.stringify(shapes(b));
      const liveA = a.innerHTML, liveB = b.innerHTML;
      if (change) {
        for (const box of [a, b]) {
          if (change[0] === "attr") box.firstElementChild.setAttribute(change[1], change[2]);
          else box.querySelector("button").click();
        }
        await tick(); await tick();
      }
      results.push({
        name, shapeSame: shapeA === shapeB, liveSame: liveA === liveB, afterSame: a.innerHTML === b.innerHTML,
        carrierLeft: !!b.querySelector("template"), serialized, shapeA, shapeB, afterA: a.innerHTML, afterB: b.innerHTML,
      });
      a.remove(); b.remove();
    }
    return results;
  }, { cases, tags });
  for (const r of out) {
    const ok = r.shapeSame && r.liveSame && r.afterSame && !r.carrierLeft;
    console.log(`${ok ? "✓" : "✗"} ${bname.padEnd(8)} ${r.name}${ok ? "" : `  [shape ${r.shapeSame}, live DOM ${r.liveSame}, after change ${r.afterSame}, carrier left ${r.carrierLeft}]`}`);
    if (!ok && bname === "chromium") {
      if (!r.shapeSame) console.log(`    shape A: ${r.shapeA}\n    shape B: ${r.shapeB}`);
      if (!r.afterSame) console.log(`    after A: ${r.afterA}\n    after B: ${r.afterB}`);
      console.log(`    serialized: ${r.serialized}`);
    }
  }
  await browser.close();
}
