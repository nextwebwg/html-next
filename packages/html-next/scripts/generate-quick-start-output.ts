/**
 * Writes the Vue, React and Svelte components the quick-start's `counter.html` converts to into
 * docs/guide/quick-start.md, each in its framework's section. `--check` fails instead when the page
 * shows output the converters no longer generate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateReactConversion, generateSvelteConversion, generateVueComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const page = fileURLToPath(new URL("../../../docs/guide/quick-start.md", import.meta.url));
const markdown = await readFile(page, "utf8");
const source = /```html title="counter\.html"\n([\s\S]*?)\n```/.exec(markdown)?.[1];
if (source === undefined) throw new Error("docs/guide/quick-start.md has no counter.html block.");
const definition = parseComponent(source, "counter.html");
const outputs = [
  { framework: "vue", fence: 'vue title="XCounter.vue"', code: generateVueComponent(definition) },
  { framework: "react", fence: 'tsx title="XCounter.tsx"', code: generateReactConversion(definition).component },
  { framework: "svelte", fence: 'svelte title="XCounter.svelte"', code: generateSvelteConversion(definition).component },
];

let updated = markdown;
for (const { framework, fence, code } of outputs) {
  // The first section for each framework is the one under "Write the component".
  const start = updated.indexOf(`::: framework-${framework}\n`);
  const end = updated.indexOf("\n:::\n", start);
  if (start < 0 || end < 0) throw new Error(`docs/guide/quick-start.md has no framework-${framework} section.`);
  const section = updated.slice(start, end);
  const block = `\`\`\`${fence}\n${code.trimEnd()}\n\`\`\``;
  const existing = section.indexOf(`\`\`\`${fence}\n`);
  const replaced = existing < 0 ? `${section.trimEnd()}\n\n${block}\n` : `${section.slice(0, existing)}${block}\n`;
  updated = `${updated.slice(0, start)}${replaced}${updated.slice(end)}`;
}

if (process.argv.includes("--check")) {
  if (updated !== markdown) throw new Error("docs/guide/quick-start.md shows stale converter output; run pnpm generate:quick-start.");
} else if (updated !== markdown) {
  await writeFile(page, updated);
}
