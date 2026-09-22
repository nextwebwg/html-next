// Adversarial review: round-trip cases the P12 oracle does not cover, plus the PI form it never writes.
import { chromium, firefox, webkit } from "playwright";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
const here = new URL(".", import.meta.url);
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", here).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const reader = await readFile(new URL("reader.js", here), "utf8");

const definitions = `
<template component="x-card" status="early" summary="t."><article class="card"><header><slot name="title">Untitled</slot></header><div class="body"><slot></slot></div></article></template>
<template component="x-named" status="early" summary="t."><p><slot name="fallback"></slot>|<slot name="b"></slot></p></template>
<template component="x-nestfb" status="early" summary="t."><p><slot name="a"><slot name="b">bf</slot></slot></p></template>
<template component="x-fbcomp" status="early" summary="t."><p><slot name="t"><x-card>fb</x-card></slot></p></template>
<template component="x-wrap" status="early" summary="t."><section><x-card><span slot="title"><slot name="heading"></slot></span><slot></slot></x-card></section></template>
<template component="x-deleg" status="early" summary="t."><x-card><b slot="title">D</b><slot></slot></x-card></template>
<template component="x-if" status="early" summary="t."><defs><prop name="open" type="boolean" default="false">O.</prop></defs>
  <div><section $if="open"><slot name="extra"></slot></section><slot></slot></div></template>`;
const cases = {
  "slot literally named 'fallback'": `<x-named><i slot="fallback">F</i><i slot="b">B</i></x-named>`,
  "consumer data-* on root": `<x-card data-testid="t1">x</x-card>`,
  "slot in fallback of slot": `<x-nestfb><i slot="b">B</i></x-nestfb>`,
  "component in fallback": `<x-fbcomp></x-fbcomp>`,
  "delegated root": `<x-deleg>body</x-deleg>`,
  "consumer comment that looks like a marker": `<x-card>a<!--?slot-end?-->b</x-card>`,
  "same-tag passthrough nested": `<x-wrap><em slot="heading">H1</em><x-wrap><em slot="heading">H2</em>in</x-wrap>out</x-wrap>`,
  "content for slot hidden by $if": `<x-if><i slot="extra">E</i>main</x-if>`,
};
const out = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${definitions}</body>`);
  await page.addScriptTag({ content: runtime }); await page.addScriptTag({ content: reader });
  out[bname] = await page.evaluate(async (cases) => {
    window.__rangeMarkers = true; window.HtmlRuntime.lowerDocument();
    const lower = async (html) => {
      const box = document.createElement("div"); box.innerHTML = html; document.body.append(box);
      window.HtmlRuntime.lowerDocument(); await new Promise((r) => setTimeout(r, 100));
      window.HtmlRuntime.lowerDocument(); await new Promise((r) => setTimeout(r, 100)); // settle nested roots (the P12 harness reads after one 0ms tick)
      const s = box.innerHTML; box.remove(); return s;
    };
    const recover = (html) => { const d = document.createElement("div"); d.setHTMLUnsafe(html); return window.RenderedForm.recover(d); };
    const res = {};
    for (const [name, authored] of Object.entries(cases)) {
      const rendered = await lower(authored);
      const recovered = recover(rendered);
      // The server-emitted PI text form (what the doc proposes), not the comment form the writer produces.
      const piText = rendered.replace(/<!--\?(.*?)\?-->/g, "<?$1?>");
      const piRecovered = recover(piText);
      const rerendered = await lower(recovered);
      res[name] = { authored, recovered, piSame: piRecovered === recovered, rerenderSame: rerendered === rendered, rendered };
    }
    return res;
  }, cases);
  await browser.close();
}
for (const name of Object.keys(cases)) {
  const c = out.chromium[name];
  const agree = ["firefox", "webkit"].every((b) => out[b][name].recovered === c.recovered);
  console.log(`\n# ${name}${agree ? "" : "  (ENGINES DISAGREE)"}\n  authored : ${c.authored}\n  recovered: ${c.recovered}\n  PI form same: ${c.piSame}  rerender same: ${c.rerenderSame}\n  rendered : ${c.rendered}`);
}
