// Behavioural equivalence: path A (authored -> lowered) vs path B (serialized rendered form -> hydrated).
// After the same later state change, both components must produce the same DOM.
import { chromium, firefox, webkit } from "playwright";
import { build } from "esbuild";
const here = new URL(".", import.meta.url);
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", here).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const definitions = `
<template component="x-if" status="early" summary="t."><defs><prop name="open" type="boolean" default="false">O.</prop></defs>
  <div><section $if="open"><slot name="extra">none</slot></section><slot></slot></div></template>
<template component="x-list" status="early" summary="t."><defs><prop name="rows" type="list(string)" default="[]">R.</prop></defs>
  <ul><li $each="row of rows" $key="row"><slot :name="format('row-%s', row)">Unnamed</slot></li></ul></template>`;
const cases = [
  { name: "slot under $if, then open", authored: `<x-if><i slot="extra">E</i>main</x-if>`, change: ["data-open", "true"] },
  { name: "$each row added later", authored: `<x-list rows='["a"]'><span slot="row-b">B!</span></x-list>`, change: ["data-rows", '["a","b"]'] },
];
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${definitions}</body>`);
  await page.addScriptTag({ content: runtime });
  const out = await page.evaluate(async (cases) => {
    window.__rangeMarkers = true;
    const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const results = [];
    for (const { name, authored, change } of cases) {
      const a = document.createElement("div"); a.setHTMLUnsafe(authored); document.body.append(a);
      window.HtmlRuntime.lowerDocument(); await tick();
      const b = document.createElement("div"); b.setHTMLUnsafe(a.innerHTML); document.body.append(b);   // server round trip
      window.HtmlRuntime.lowerDocument(); await tick();                                               // hydrate B
      for (const box of [a, b]) box.firstElementChild.setAttribute(...change);
      await tick();
      results.push({ name, same: a.innerHTML === b.innerHTML, A: a.innerHTML, B: b.innerHTML });
      a.remove(); b.remove();
    }
    return results;
  }, cases);
  for (const r of out) {
    console.log(`${r.same ? "✓" : "✗"} ${bname.padEnd(8)} ${r.name}`);
    if (!r.same) console.log(`    A: ${r.A}\n    B: ${r.B}`);
  }
  await browser.close();
}
