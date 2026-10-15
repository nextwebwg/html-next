/**
 * Measures converted Vue components' converter-owned style scoping against the live runtime's
 * selectors and against Vue's scope attribute (the form converted components used before it):
 *
 * - recalc: a full style recalc of one component region under 1,800 rules, in each selector form;
 * - mount: 1,000 instances of a converted component, with and without the ownership attributes;
 * - bytes: each converted component's minified script and its compiled CSS.
 *
 * Every engine runs serially. Results go to `.benchmark/vue-scoping/results.json`.
 * `pnpm measure:vue-scoping [--engines=chromium,firefox,webkit] [--instances=1000]`
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { compileScript, compileStyle, parse } from "@vue/compiler-sfc";
import { build, transform } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { generateVueComponent, vueControlArtifact, vueHostArtifact, vueHtmlArtifact, vuePropsArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const argument = (name: string, fallback: string): string =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const engines = argument("engines", "chromium,firefox,webkit").split(",");
const instances = Number(argument("instances", "1000"));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const work = join(packageRoot, ".benchmark", "vue-scoping");

// Recalc: 300 groups of six selector shapes over 600 rows of nested markup, with child limits.
const forms = {
  live: (selector: string) => selector,
  vueScopeAttribute: (selector: string) => selector.replace(/(::after)?$/, (pseudo) => `[data-v-1]${pseudo}`),
  converterOwned: (selector: string) => selector.replace(/(::after)?$/, (pseudo) => `:where([data-hn-x])${pseudo}`),
} as const;
type Form = keyof typeof forms;
const shapes = (index: number): readonly string[] => [`.c${index % 50} span`, `.c${index % 50}`, `p.c${index % 50} b`,
  `.panel > .c${index % 50}`, `li:nth-child(${(index % 7) + 1}) .c${index % 50}`, `.c${index % 50}::after`];
const recalcCss = (form: Form): string => `@scope (.x) to ([data-hn]) {\n${Array.from({ length: 300 }, (_, index) =>
  shapes(index).map((selector) => `${forms[form](selector)} { --r${index}: 1; }`).join("\n")).join("\n")}\n}`;
const own = "data-v-1 data-hn-x";
const recalcMarkup = `<ul class="x" data-hn ${own}>${Array.from({ length: 600 }, (_, index) =>
  `<li class="c${index % 50}" ${own}><div class="panel c${(index + 1) % 50}" ${own}><span class="c${(index + 2) % 50}" ${own}>t</span>`
  + `<p class="c${index % 50}" ${own}><b ${own}>b</b></p></div>`
  + (index % 20 === 0 ? `<div class="kid" data-hn><span class="c${index % 50}">k</span></div>` : "") + "</li>").join("")}</ul>`;

// Mount: a converted component with own, sanitized and projected markup and a nested component.
const definitions: Record<string, string> = {
  "x-scope-kid": `<template component="x-scope-kid"><div class="k"><slot></slot></div><style>
    :host { border-left: 1px solid rgb(1, 2, 3); } .k { color: rgb(128, 0, 128); } :slotted(*) { font-weight: 700; }</style></template>`,
  "x-scope-card": `<template component="x-scope-card"><section><div class="panel"><span class="t">own span</span></div>
    <p class="in">own in</p><slot></slot><x-scope-kid class="kk"><b class="in">own, in the kid's slot</b></x-scope-kid></section><style>
    :host { padding-left: 9px; } :host(.on) { padding-right: 9px; } .in { color: rgb(0, 128, 0); } .panel span { color: rgb(0, 100, 0); }
    .in::after { content: "o"; } :slotted(.proj) { color: rgb(0, 0, 255); } b { text-decoration: underline; }</style></template>`,
};
type Variant = "converterOwned" | "vueScopeAttribute";

/** Vue's scope-attribute form of a converter-owned component: no ownership attributes, Vue's own scoping. */
function scopeAttributeForm(source: string, tag: string): string {
  const owner = `data-hn-${tag}`;
  const template = source.slice(source.indexOf("<template>"), source.lastIndexOf("</template>"));
  const style = source.slice(source.indexOf("<style scoped>"));
  let css = style.replaceAll(`:where([${owner}])`, "").replaceAll(`:where(:not([${owner}])):is(`, ":slotted(");
  for (let start = css.indexOf(":global("); start !== -1; start = css.indexOf(":global(")) {
    let depth = 0;
    let end = start + ":global".length;
    for (; end < css.length; end += 1) {
      if (css[end] === "(") depth += 1;
      else if (css[end] === ")" && --depth === 0) break;
    }
    css = css.slice(0, start) + css.slice(start + ":global(".length, end) + css.slice(end + 1);
  }
  return source.slice(0, source.indexOf("<template>"))
    + template.replace(/\s+data-hn(?:-[\w-]+)?(?=[\s>/])/g, "").replace(/ owner="[^"]*"/g, "")
    + source.slice(source.lastIndexOf("</template>"), source.indexOf("<style scoped>")) + css;
}

async function mountBundle(variant: Variant): Promise<{ js: string; css: string; components: Record<string, { min: number; gzip: number }> }> {
  const directory = join(work, variant);
  await mkdir(join(directory, "vue"), { recursive: true });
  for (const { path, content } of [vueHostArtifact(), vueHtmlArtifact(), vueControlArtifact(), vuePropsArtifact()]) {
    await writeFile(join(directory, path), content);
  }
  const css: string[] = [];
  const imports: string[] = [];
  const components: Record<string, { min: number; gzip: number }> = {};
  for (const [tag, source] of Object.entries(definitions)) {
    const definition = parseComponent(source, `${tag}.html`);
    const name = definition.contract.name;
    const generated = generateVueComponent(definition);
    const sfc = variant === "converterOwned" ? generated : scopeAttributeForm(generated, tag);
    const { descriptor } = parse(sfc, { filename: `${name}.vue` });
    const id = `data-v-${tag}`;
    const script = compileScript(descriptor, { id, inlineTemplate: true });
    await writeFile(join(directory, "vue", `${name}.ts`), script.content.replace(/from (['"])(\.\/[^'"\n]+)\.vue\1/g, "from $1$2$1"));
    const minified = (await transform(script.content, { loader: "ts", minify: true })).code;
    components[name] = { min: minified.length, gzip: gzipSync(minified).length };
    for (const style of descriptor.styles) css.push(compileStyle({ source: style.content, filename: `${name}.vue`, id, scoped: style.scoped === true }).code);
    imports.push(`import ${name} from "./vue/${name}";`, `${name}.__scopeId = "${id}";`);
  }
  const entry = join(directory, "entry.ts");
  await writeFile(entry, `import { createApp, h } from "vue";\n${imports.join("\n")}
const runs = [];
for (let run = 0; run < 12; run += 1) {
  const host = document.createElement("main");
  document.body.append(host);
  const start = performance.now();
  const app = createApp({ render: () => h("div", {}, Array.from({ length: ${instances} }, (_, index) =>
    h(XScopeCard, { key: index, class: "chip" }, { default: () => [h("span", { class: "proj" }, "p"), h("i", {}, "q")] }))) });
  app.mount(host);
  document.body.offsetWidth;
  runs.push(performance.now() - start);
  app.unmount();
  host.remove();
}
runs.sort((a, b) => a - b);
window.mountMedian = runs[6];
`);
  const outfile = join(directory, "bundle.js");
  await build({ entryPoints: [entry], outfile, bundle: true, minify: true, format: "iife", platform: "browser", target: ["es2022"], logLevel: "error",
    nodePaths: [join(packageRoot, "node_modules")], alias: { "@nextwebwg/html-next/validation": join(packageRoot, "src/validation.ts") },
    define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "false", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" } });
  return { js: await readFile(outfile, "utf8"), css: css.join("\n"), components };
}

const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const types: Record<string, BrowserType> = { chromium, firefox, webkit };
const bundles = { converterOwned: await mountBundle("converterOwned"), vueScopeAttribute: await mountBundle("vueScopeAttribute") };
const results: Record<string, { recalc: Record<Form, number>; mount: Record<Variant, number> }> = {};
for (const engine of engines) {
  const browser = await types[engine]!.launch();
  const recalc = {} as Record<Form, number>;
  for (const form of Object.keys(forms) as Form[]) {
    const page = await browser.newPage();
    await page.setContent(`<style id="s"></style>${recalcMarkup}`);
    recalc[form] = median(await page.evaluate((text) => {
      const style = document.getElementById("s")!;
      const last = document.querySelector(".x li:last-child b")!;
      const runs: number[] = [];
      for (let run = 0; run < 25; run += 1) {
        style.textContent = "";
        getComputedStyle(last).getPropertyValue("--r0");
        void document.body.offsetWidth;
        const start = performance.now();
        style.textContent = `${text}\n/* ${run} */`;
        void document.body.offsetWidth;
        getComputedStyle(last).getPropertyValue("--r0");
        runs.push(performance.now() - start);
      }
      return runs;
    }, recalcCss(form)));
    await page.close();
  }
  const mount = {} as Record<Variant, number>;
  for (const variant of ["vueScopeAttribute", "converterOwned"] as const) {
    const page = await browser.newPage();
    await page.setContent(`<style>${bundles[variant].css}</style>`);
    await page.addScriptTag({ content: bundles[variant].js });
    mount[variant] = await page.evaluate(() => (window as unknown as { mountMedian: number }).mountMedian);
    await page.close();
  }
  await browser.close();
  results[engine] = { recalc, mount };
  const change = (after: number, before: number): string => `${after >= before ? "+" : ""}${((after / before - 1) * 100).toFixed(0)}%`;
  console.log(`${engine}: recalc ms live ${recalc.live.toFixed(1)}, Vue scope attribute ${recalc.vueScopeAttribute.toFixed(1)}, converter-owned ${recalc.converterOwned.toFixed(1)} (${change(recalc.converterOwned, recalc.vueScopeAttribute)}); `
    + `mount ${instances} ms Vue scope attribute ${mount.vueScopeAttribute.toFixed(1)}, converter-owned ${mount.converterOwned.toFixed(1)} (${change(mount.converterOwned, mount.vueScopeAttribute)})`);
}
const bytes = Object.fromEntries((Object.keys(bundles) as Variant[]).map((variant) => [variant, {
  components: bundles[variant].components,
  css: { raw: bundles[variant].css.length, gzip: gzipSync(bundles[variant].css).length },
  bundle: { raw: bundles[variant].js.length, gzip: gzipSync(bundles[variant].js).length },
}]));
console.log(JSON.stringify(bytes));
await writeFile(join(work, "results.json"), `${JSON.stringify({ instances, results, bytes }, null, 2)}\n`);
