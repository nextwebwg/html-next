// Q5 oracle: authored -> lowered (with range markers) -> serialized -> parsed -> recovered -> compared.
import { chromium, firefox, webkit } from "playwright";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
const here = new URL(".", import.meta.url);
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", here).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const reader = await readFile(new URL("reader.js", here), "utf8");

const definitions = `
<template component="x-card" status="early" summary="t."><defs><prop name="tone" type="string" default="info">T.</prop></defs>
  <article class="card" :data-tone="tone"><header><slot name="title">Untitled</slot></header><div class="body"><slot></slot></div></article></template>
<template component="x-two" status="early" summary="t."><p>Hello <slot name="a"></slot><slot name="b">B-fallback</slot> tail</p></template>
<template component="x-adj" status="early" summary="t."><p>Hello <slot></slot>!</p></template>
<template component="x-wrap" status="early" summary="t."><section><x-card><span slot="title"><slot name="heading"></slot></span><slot></slot></x-card></section></template>
<template component="x-list" status="early" summary="t."><defs><prop name="rows" type="list(string)" default="[]">R.</prop></defs>
  <ul><li $each="row of rows" $key="row"><slot :name="format('row-%s', row)">Unnamed</slot></li></ul></template>`;
const slotsOf = { "x-card": () => ["title", ""], "x-two": () => ["a", "b"], "x-adj": () => [""], "x-wrap": () => ["heading", ""],
  "x-list": (el) => JSON.parse(el.getAttribute("rows") ?? "[]").map((row) => `row-${row}`) };
const cases = {
  "default text": `<x-card>Hi</x-card>`,
  "named + default": `<x-card><b slot="title">T</b>Body <i>text</i></x-card>`,
  "fallback shown": `<x-two><i slot="a">A</i></x-two>`,
  "stray default into no default slot": `<x-two>stray</x-two>`,
  "text beside template text": `<x-adj>world</x-adj>`,
  "empty": `<x-card></x-card>`,
  "slot passthrough into nested": `<x-wrap><em slot="heading">H</em>Inner</x-wrap>`,
  "same tag nested in projection": `<x-card><x-card><b slot="title">Inner</b>deep</x-card>outer</x-card>`,
  "keyed dynamic slot names": `<x-list rows='["a","b"]'><span slot="row-b">B!</span></x-list>`,
  "explicit prop equal to default": `<x-card tone="info">x</x-card>`,
  "explicit prop": `<x-card tone="warn">x</x-card>`,
  "consumer attributes on root": `<x-card id="c1" class="mine">x</x-card>`,
};
const results = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${definitions}</body>`);
  await page.addScriptTag({ content: runtime }); await page.addScriptTag({ content: reader });
  const out = await page.evaluate(async ({ cases, slotsSource }) => {
    const slotsOf = eval(`(${slotsSource})`);
    window.__rangeMarkers = true;
    window.HtmlRuntime.lowerDocument();
    const canonical = (html) => {
      const doc = new DOMParser().parseFromString(`<body>${html}`, "text/html");
      const walk = (node) => {
        if (node.nodeType === 3) return node.data;
        if (node.nodeType !== 1) return "";
        const attrs = [...node.attributes].map((a) => `${a.name}=${a.value}`).sort().join(" ");
        const known = slotsOf[node.localName];
        if (!known) return `<${node.localName} ${attrs}>${[...node.childNodes].map(walk).join("")}</${node.localName}>`;
        const allowed = new Set(known(node)); const slots = {};
        for (const child of node.childNodes) {
          const name = child.nodeType === 1 ? child.getAttribute("slot") ?? "" : "";
          if (allowed.has(name)) (slots[name] ??= []).push(walk(child));
        }
        return `<${node.localName} ${attrs}>${JSON.stringify(Object.keys(slots).sort().map((k) => [k, slots[k].join("")]))}</${node.localName}>`;
      };
      return [...doc.body.childNodes].map(walk).join("");
    };
    const lower = async (html) => {
      const box = document.createElement("div"); box.innerHTML = html; document.body.append(box);
      window.HtmlRuntime.lowerDocument(); await new Promise((r) => setTimeout(r, 0));
      const rendered = box.innerHTML; box.remove(); return rendered;
    };
    const results = {};
    for (const [name, authored] of Object.entries(cases)) {
      const rendered = await lower(authored);
      const parsed = document.createElement("div"); parsed.setHTMLUnsafe(rendered);   // fresh nodes, no runtime state
      const recovered = window.RenderedForm.recover(parsed);
      const same = canonical(recovered) === canonical(authored);
      const rerendered = await lower(recovered);
      results[name] = same && rerendered === rendered ? "ok"
        : { recoveredMatches: same, rerenderMatches: rerendered === rendered, authored, recovered, rendered, ...(rerendered === rendered ? {} : { rerendered }) };
    }
    return results;
  }, { cases, slotsSource: `{${Object.entries(slotsOf).map(([k, f]) => `"${k}": ${f.toString()}`).join(",")}}` });
  results[bname] = out;
  await browser.close();
}
const names = Object.keys(cases);
for (const name of names) {
  const row = Object.fromEntries(Object.entries(results).map(([b, r]) => [b, r[name]]));
  const allOk = Object.values(row).every((v) => v === "ok");
  console.log(`${allOk ? "✓" : "✗"} ${name}`);
  if (!allOk) console.log(JSON.stringify(row.chromium, null, 1).split("\n").map((l) => "    " + l).join("\n"));
}
