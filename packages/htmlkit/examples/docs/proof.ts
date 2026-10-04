import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseComponent } from "@nextwebwg/html-next";
import { Marked } from "marked";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { buildApplication, type BuildResult } from "../../src/index.js";
import { escapeHTML } from "../../src/document.js";

const counter = `<template component="proof-counter" controller="./counter.ts"><defs>
<prop name="step" type="number" default="1">Increment amount.</prop>
<state name="count" type="number" value="0"></state></defs>
<section><button type="button" $ref="increment">Increment</button> <output $value="count"></output></section>
<style>:host { padding: 1rem; border: 1px solid #ccd8e1; border-radius: .5rem; } button { font: inherit; } output { margin-left: 1rem; }</style></template>`;

// Markdown text is content, not HTML Next expressions. Escape its text nodes with the
// component language's literal-text escape after HTML parsing, including code examples.
function literalContent(html: string): string {
  const fragment = parseFragment(html);
  const visit = (node: DefaultTreeAdapterMap["node"]): void => {
    if (node.nodeName === "#text" && "value" in node) node.value = node.value.replace(/\\/g, "\\\\").replace(/{/g, "\\{");
    if ("childNodes" in node && !("tagName" in node && node.tagName === "style")) node.childNodes.forEach(visit);
  };
  visit(fragment);
  return serialize(fragment);
}

export async function buildDocsProof(root: string, contentRoot: string, base = "/"): Promise<BuildResult> {
  const write = async (file: string, contents: string) => {
    const path = join(root, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents);
  };
  const guides = (await readdir(contentRoot)).filter(file => file.endsWith(".md")).sort();
  const navigation = [{ label: "Overview", href: base }, ...guides.map(file => ({ label: basename(file, ".md"), href: `${base}guide/${basename(file, ".md")}/` })),
    { label: "Counter reference", href: base + "reference/counter/" }];
  await write("package.json", '{"name":"htmlkit-docs-proof","private":true,"type":"module"}\n');
  await write("app/layouts/default.html", `<template component="proof-shell" controller="./shell.ts"><title>HTMLKit documentation proof</title><meta name="description" content="HTML Next application documentation."><defs>
    <prop name="links" type="list(object({ label: string, href: string }))" required>Navigation</prop>
    <state name="dark" type="boolean" value="false"></state></defs>
    <main><header><strong>HTMLKit</strong><button type="button" $ref="theme">Toggle theme</button></header>
    <div class="columns"><nav aria-label="Documentation"><label>Find a page <input type="search" $ref="search"></label>
      <ul><li $each="link of links"><a from:href="link.href" $value="link.label"></a></li></ul></nav>
      <div class="content"><slot name="page"></slot></div></div></main>
    <style>:host { color: #183047; background: #fff; min-height: 100vh; padding: 2rem; font: 1rem/1.65 system-ui; }
      :host-state([dark]) { color: #e1ebf4; background: #142638; } header { display: flex; justify-content: space-between; border-bottom: 1px solid #9aaebf; padding-bottom: 1rem; }
      .columns { display: grid; grid-template-columns: 14rem minmax(0, 1fr); gap: 3rem; max-width: 80rem; margin: 2rem auto; } input, button { font: inherit; padding: .4rem; } ul { padding-left: 1rem; } a { color: #2785d7; }
      @media (max-width: 640px) { .columns { display: block; } }</style></template>`);
  await write("app/layouts/default.server.ts", `export const load = () => ({ props: { links: ${JSON.stringify(navigation)} } });`);
  await write("app/layouts/shell.ts", `export default function(host) {
    const theme = () => { host.state.dark = !host.state.dark; };
    const search = () => { const query = host.refs.search.value.toLowerCase(); for (const item of host.root.querySelectorAll('nav li')) item.hidden = !item.textContent.toLowerCase().includes(query); };
    host.refs.theme.addEventListener('click', theme); host.refs.search.addEventListener('input', search);
    return () => { host.refs.theme.removeEventListener('click', theme); host.refs.search.removeEventListener('input', search); };
  }`);
  await write("app/components/counter.html", counter);
  await write("app/components/counter.ts", `export default function(host) {
    const click = () => { host.state.count += host.props.step.value; };
    host.refs.increment.addEventListener('click', click);
    return () => host.refs.increment.removeEventListener('click', click);
  }`);
  await write("app/pages/index.html", `<template component="page-proof-home"><title>Overview · HTMLKit</title><meta name="description" content="An application platform exercised by documentation."><article><h1>Application platform, exercised by documentation</h1>
    <p>This consumer builds existing Markdown guides, component metadata, searchable navigation, a theme controller, and a working HTML Next example.</p>
    <p>HTMLKit supplies routing, loaders, rendering, and delivery. This application owns its content and presentation.</p></article></template>`);
  for (const file of guides) {
    const slug = basename(file, ".md");
    const ids = new Map<string, number>();
    const markdown = new Marked({ renderer: {
      link({ href, title, tokens }) {
        let target = href;
        if (href.startsWith("/html-next/")) {
          const [pathname, hash] = href.split("#", 2);
          const name = basename(pathname!.replace(/\/$/, ""));
          const guide = name === "html-next" ? "index" : name;
          target = guides.includes(`${guide}.md`) ? `${base}guide/${guide}/${hash === undefined ? "" : "#" + hash}` : "https://nextwebwg.org" + href;
        } else if (href.startsWith("/") && !href.startsWith("//")) target = "https://nextwebwg.org" + href;
        return `<a href="${escapeHTML(target)}"${title == null ? "" : ` title="${escapeHTML(title)}"`}>${this.parser.parseInline(tokens)}</a>`;
      },
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const stem = text.replace(/<[^>]*>/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "heading";
        const count = ids.get(stem) ?? 0; ids.set(stem, count + 1);
        const id = count === 0 ? stem : `${stem}-${count}`;
        return `<h${depth} id="${id}"><a href="#${id}">${text}</a></h${depth}>`;
      },
    } });
    const body = literalContent(await markdown.parse(await readFile(join(contentRoot, file), "utf8")));
    await write(`app/pages/guide/${slug}.html`, `<template component="page-proof-guide-${slug}"><title>${escapeHTML(slug)} · HTMLKit</title><article>${body}</article>
      <style>pre { overflow: auto; padding: 1rem; background: #eef4f8; color: #183047; } a { color: #2785d7; }</style></template>`);
  }
  const definition = parseComponent(counter);
  const rows = Object.entries(definition.contract.props).map(([name, prop]) =>
    `<tr><td>${escapeHTML(name)}</td><td>${escapeHTML(String(prop.type))}</td><td>${escapeHTML(prop.description)}</td></tr>`).join("");
  await write("app/pages/reference/counter.html", `<link rel="component" href="../../components/counter.html">
    <template component="page-proof-reference"><title>Counter reference · HTMLKit</title><meta name="description" content="Generated component contract and live counter."><article><h1 id="counter">Counter reference</h1>
      <table><caption>Generated from the component contract</caption><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>
      <h2 id="example">Live example</h2><proof-counter step="2"></proof-counter>
      <h2>Source</h2>${literalContent(`<pre><code>${escapeHTML(counter)}</code></pre>`)}</article>
      <style>pre { overflow: auto; padding: 1rem; background: #eef4f8; color: #183047; } table { border-collapse: collapse; } th, td { text-align: left; padding: .4rem .8rem; }</style></template>`);
  await write("public/search.json", JSON.stringify(navigation));
  return buildApplication({ root, base });
}
