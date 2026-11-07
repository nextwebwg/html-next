import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

/** Hot modules share the generated runtime, matching a bundler's split development output. */
export async function attributeForwardingHotFiles(): Promise<Record<string, string>> {
  const roots = ['<button title="Template">Initial</button>', '<article $attributes title="Template">Before</article>',
    '<section title="Template" $attributes>After</section>', '<aside title="Final">Hidden</aside>', '<footer $attributes>Restored</footer>'];
  const definitions = roots.map(root => parseComponent(`<template component="x-subject">${root}</template>`, "https://attributes-hot.example/subject.html"));
  const parent = parseComponent(`<template component="x-page"><defs><state name="caller" type="string" value="Caller"></state><state name="note" type="string" value="Note"></state></defs><main><x-subject from:title="$caller" from:data-note="$note" __proto__="Prototype"></x-subject></main></template>`, "https://attributes-hot.example/page.html");
  const invocations = new Map([["x-subject", { module: "./subject0.js", definition: definitions[0]! }]]);
  const moduleSource = (definition: typeof parent) => generateComponent(definition, { hot: true, invocations }).find(artifact => artifact.path === `vanilla/${definition.contract.name}.js`)!.content;
  const modules = Object.fromEntries(definitions.map((definition, index) => [`subject${index}.js`, moduleSource(definition)]));
  modules["page.js"] = moduleSource(parent);
  modules["scenario.js"] = `import { createXPage } from './page.js';
import { generatedHost } from '@nextwebwg/html-next/generated-runtime';
export async function run() {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const page = createXPage(); document.body.append(page); await settle();
  const snapshots = [];
  const snapshot = () => { const root = page.firstElementChild; snapshots.push({ tag: root.localName, title: root.getAttribute('title'), note: root.getAttribute('data-note'), prototype: root.getAttribute('__proto__'), page: root.getAttribute('data-page'), className: root.getAttribute('class') }); };
  snapshot();
  page.firstElementChild.setAttribute('data-page', 'Page'); page.firstElementChild.classList.add('page-owned');
  await import('./subject1.js'); await settle(); snapshot();
  await import('./subject2.js'); await settle(); snapshot();
  generatedHost(page).state.caller = 'Changed'; generatedHost(page).state.note = 'Changed'; await settle(); snapshot();
  await import('./subject3.js'); await settle(); snapshot();
  generatedHost(page).state.note = 'Later'; await settle(); snapshot();
  await import('./subject4.js'); await settle(); snapshot();
  return snapshots;
}`;
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const result = await build({ entryPoints: ["scenario.js"], outdir: "/out", entryNames: "[name]", chunkNames: "[name]-[hash]", splitting: true,
    bundle: true, format: "esm", write: false, platform: "browser", target: ["es2022"],
    alias: { "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts` },
    plugins: [{ name: "hot-attributes", setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
      builder.onResolve({ filter: /^\.?\/?[a-z0-9]+\.js$/ }, args => {
        const path = args.path.replace(/^\.?\//, "");
        return Object.hasOwn(modules, path) ? { path, namespace: "hot" } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "hot" }, args => ({ contents: modules[args.path]!, loader: "js", resolveDir: source }));
    } }],
  });
  return Object.fromEntries(result.outputFiles.map(file => [file.path.slice("/out".length), file.text]));
}
