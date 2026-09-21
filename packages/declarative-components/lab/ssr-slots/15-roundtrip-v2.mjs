// Draft-2 oracle: authored -> lowered (settled) -> serialized -> parsed -> recovered -> compared -> re-rendered.
// Chromium reads real PIs; Firefox and WebKit read the comments their parsers make of them.
import { chromium, firefox, webkit } from "playwright";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
const here = new URL(".", import.meta.url);
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", here).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const reader = await readFile(new URL("reader.js", here), "utf8");

const definitions = `
<template component="x-card" status="early" summary="t."><defs><prop name="tone" type="string" default="info">T.</prop></defs>
  <article class="card"><header><slot name="title">Untitled</slot></header><div class="body"><slot></slot></div></article></template>
<template component="x-two" status="early" summary="t."><p>Hello <slot name="a"></slot><slot name="b">B-fallback</slot> tail</p></template>
<template component="x-adj" status="early" summary="t."><p>Hello <slot></slot>!</p></template>
<template component="x-wrap" status="early" summary="t."><section><x-card><span slot="title"><slot name="heading"></slot></span><slot></slot></x-card></section></template>
<template component="x-list" status="early" summary="t."><defs><prop name="rows" type="list(string)" default="[]">R.</prop></defs>
  <ul><li $each="row of rows" $key="row"><slot :name="format('row-%s', row)">Unnamed</slot></li></ul></template>
<template component="x-named" status="early" summary="t."><p><slot name="fallback"></slot>|<slot name="b"></slot></p></template>
<template component="x-deleg" status="early" summary="t."><x-card><b slot="title">D</b><slot></slot></x-card></template>
<template component="x-if" status="early" summary="t."><defs><prop name="open" type="boolean" default="false">O.</prop></defs>
  <div><section $if="open"><slot name="extra"></slot></section><slot></slot></div></template>
<template component="x-bound" status="early" summary="t."><defs><prop name="tone" type="string" default="info">T.</prop></defs>
  <article :data-tone="tone"><slot></slot></article></template>`;
const tags = ["x-card", "x-two", "x-adj", "x-wrap", "x-list", "x-named", "x-deleg", "x-if", "x-bound"];
const slotsOf = {
  "x-card": () => ["title", ""], "x-two": () => ["a", "b"], "x-adj": () => [""], "x-wrap": () => ["heading", ""],
  "x-list": (el) => JSON.parse(el.getAttribute("rows") ?? "[]").map((row) => `row-${row}`),
  "x-named": () => ["fallback", "b"], "x-deleg": () => [""], "x-if": () => ["extra", ""], "x-bound": () => [""],
};
const cases = [
  ["default text", `<x-card>Hi</x-card>`],
  ["named + default", `<x-card><b slot="title">T</b>Body <i>text</i></x-card>`],
  ["fallback shown", `<x-two><i slot="a">A</i></x-two>`],
  ["stray default into no default slot", `<x-two>stray</x-two>`],
  ["text beside template text", `<x-adj>world</x-adj>`],
  ["empty", `<x-card></x-card>`],
  ["slot passthrough into nested (settled)", `<x-wrap><em slot="heading">H</em>Inner</x-wrap>`],
  ["same tag nested in projection", `<x-card><x-card><b slot="title">Inner</b>deep</x-card>outer</x-card>`],
  ["same-tag passthrough nested", `<x-wrap><em slot="heading">H1</em><x-wrap><em slot="heading">H2</em>in</x-wrap>out</x-wrap>`],
  ["keyed dynamic slot names", `<x-list rows='["a","b"]'><span slot="row-b">B!</span></x-list>`],
  ["explicit prop", `<x-card tone="warn">x</x-card>`],
  ["slot literally named 'fallback'", `<x-named><i slot="fallback">F</i><i slot="b">B</i></x-named>`],
  ["slot name needing escapes", `<x-list rows='["a>b&c\\"d"]'><span slot='row-a>b&c"d'>E</span></x-list>`],
  ["delegated root", `<x-deleg>body</x-deleg>`],
  ["consumer comment that looks like a marker", `<x-card>a<!--?end?-->b</x-card>`],
  ["page partial-update range inside slot content", `<x-card>a<?start name="p"?>b<?end?>c</x-card>`],
  ["markers stripped by a sanitizer are detected", null],
  ["PENDING decision 1: content for slot hidden by $if", `<x-if><i slot="extra">E</i>main</x-if>`],
  ["PENDING decision 2: default prop on template binding data-tone", `<x-bound>x</x-bound>`],
];
const results = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${definitions}</body>`);
  await page.addScriptTag({ content: runtime }); await page.addScriptTag({ content: reader });
  results[bname] = await page.evaluate(async ({ cases, tags, slotsSource }) => {
    const slotsOf = eval(`(${slotsSource})`);
    window.__rangeMarkers = true;
    const selector = tags.join(",");
    const settle = async (box) => {
      for (let pass = 0; pass < 20 && box.querySelector(selector); pass += 1) {
        window.HtmlRuntime.lowerDocument();
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      }
      if (box.querySelector(selector)) throw new Error("lowering did not settle");
    };
    const lower = async (html) => {
      const box = document.createElement("div"); box.setHTMLUnsafe(html); document.body.append(box);
      await settle(box);
      const rendered = box.innerHTML; box.remove(); return rendered;
    };
    const canonical = (html) => {
      const doc = document.implementation.createHTMLDocument("");
      doc.body.setHTMLUnsafe(html);
      const walk = (node) => {
        if (node.nodeType === 3) return node.data;
        if (node.nodeType === 8) return `<!--${node.data}-->`;
        if (node.nodeType === 7) return `<?${node.target} ${node.data}?>`;
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
    const out = {};
    for (const [name, authored] of cases) {
      if (authored === null) continue;
      try {
        const rendered = await lower(authored);
        const parsed = document.createElement("div"); parsed.setHTMLUnsafe(rendered);
        const recovered = window.RenderedForm.recover(parsed);
        const same = canonical(recovered) === canonical(authored);
        const rerendered = await lower(recovered);
        out[name] = same && rerendered === rendered ? "ok" : { same, rerender: rerendered === rendered, authored, recovered, rendered };
      } catch (error) { out[name] = { error: String(error.message ?? error) }; }
    }
    // Integrity: a sanitizer that strips every marker must make recovery fail, not return an empty component.
    {
      const rendered = await lower(`<x-card><b slot="title">T</b>Body</x-card>`);
      const parsed = document.createElement("div"); parsed.setHTMLUnsafe(rendered);
      const walker = document.createTreeWalker(parsed, 0x80 | 0x40); const strip = [];
      while (walker.nextNode()) strip.push(walker.currentNode);
      strip.forEach((node) => node.remove());
      try { out["markers stripped by a sanitizer are detected"] = { recovered: window.RenderedForm.recover(parsed) }; }
      catch (error) { out["markers stripped by a sanitizer are detected"] = /HR005/.test(error.message) ? "ok" : { error: error.message }; }
    }
    return { piParsing: window.RenderedForm.piParsing, out };
  }, { cases, tags, slotsSource: `{${Object.entries(slotsOf).map(([k, f]) => `"${k}": ${f.toString()}`).join(",")}}` });
  await browser.close();
}
console.log(Object.entries(results).map(([b, r]) => `${b}: PI parsing ${r.piParsing}`).join(" | "));
for (const [name] of cases) {
  const row = Object.fromEntries(Object.entries(results).map(([b, r]) => [b, r.out[name]]));
  const ok = Object.values(row).every((v) => v === "ok");
  const which = ok ? "" : ` [fails in: ${Object.entries(row).filter(([, v]) => v !== "ok").map(([b]) => b).join(", ")}]`;
  console.log(`${ok ? "✓" : "✗"} ${name}${which}`);
  if (!ok) console.log("    " + JSON.stringify(Object.values(row).find((v) => v !== "ok")));
}
