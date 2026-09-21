// Q2 for Svelte 5: comments in templates, raw PI via {@html}, and adjacent text around children.
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = await mkdtemp(join(new URL(".", import.meta.url).pathname, ".svelte-"));
async function ssr(name, source, props = {}, options = {}) {
  const { js } = compile(source, { generate: "server", ...options });
  const file = join(dir, `${name}.js`);
  await writeFile(file, js.code);
  const Component = (await import(file)).default;
  return render(Component, { props }).body;
}
const out = {
  commentStripped: await ssr("a", `<p><!--?slot?-->world<!--?slot-end?--></p>`),
  commentPreserved: await ssr("b", `<p><!--?slot?-->world<!--?slot-end?--></p>`, {}, { preserveComments: true }),
  rawHtml: await ssr("c", `<script>let { text } = $props();</script><p>{@html '<?slot name="x"?>'}{text}{@html '<?slot-end?>'}</p>`, { text: "world" }),
  adjacentText: await ssr("d", `<script>let { text } = $props();</script><p>Hello {text}</p>`, { text: "world" }),
};
console.log(JSON.stringify(out, null, 1));
