// Adversarial review: consumer attributes that collide with the prop record on the lowered root.
import { chromium } from "playwright";
import { build } from "esbuild";
const runtime = (await build({ entryPoints: [new URL("../../src/runtime.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const b = await chromium.launch(); const p = await b.newPage();
await p.setContent(`<!doctype html><body><template component="x-card" status="early" summary="t."><defs><prop name="tone" type="string" default="info">T.</prop></defs><article class="card" style="color:blue"><slot></slot></article></template>
<x-card id="a" tone="warn" data-tone="mine">1</x-card>
<x-card id="b" data-tone="mine">2</x-card>
<x-card id="c" class="card mine" style="color:red">3</x-card>
<x-card id="d" data-component-root="evil">4</x-card>`);
await p.addScriptTag({ content: runtime });
console.log(await p.evaluate(async () => { HtmlRuntime.lowerDocument(); await new Promise((r) => setTimeout(r, 100));
  return ["a", "b", "c", "d"].map((id) => document.getElementById(id)?.outerHTML ?? `${id}: missing`).join("\n"); }));
await b.close();
