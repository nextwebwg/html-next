// Is nested-component hydration broken before any rendered-form change? Markers off; plain serialization.
import { chromium } from "playwright";
import { build } from "esbuild";
const here = new URL(".", import.meta.url);
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", here).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const browser = await chromium.launch(); const page = await browser.newPage();
await page.setContent(`<!doctype html><body>
<template component="x-card" status="early" summary="t."><article class="card"><div class="body"><slot></slot></div></article></template>
<template component="x-wrap" status="early" summary="t."><section><x-card><b>wrapped</b></x-card></section></template></body>`);
await page.addScriptTag({ content: runtime });
console.log(await page.evaluate(async () => {
  const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const a = document.createElement("div"); a.innerHTML = "<x-wrap></x-wrap>"; document.body.append(a);
  for (let i = 0; i < 5; i += 1) { window.HtmlRuntime.lowerDocument(); await tick(); }
  const b = document.createElement("div"); b.setHTMLUnsafe(a.innerHTML); document.body.append(b);
  window.HtmlRuntime.lowerDocument(); await tick(); await tick();
  return `A: ${a.innerHTML}\nB: ${b.innerHTML}\nsame: ${a.innerHTML === b.innerHTML}`;
}));
await browser.close();
