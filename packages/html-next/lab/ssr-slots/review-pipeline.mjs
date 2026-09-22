// Adversarial review: what common HTML pipelines do to the rendered form, and what the reader recovers after.
// Needs dompurify, html-minifier-terser, sanitize-html in /tmp/review-deps (npm i there).
import { chromium, firefox, webkit } from "playwright";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as parse5 from "parse5";
const req = createRequire("/tmp/review-deps/");
const { minify } = req("html-minifier-terser");
const sanitizeHtml = req("sanitize-html");
const purify = await readFile(req.resolve("dompurify/dist/purify.js"), "utf8");
const reader = await readFile(new URL("reader.js", import.meta.url), "utf8");

// Server output in the proposed PI text form: text beside template text, and a fallback slot.
const pi = `<p data-component="x-adj" data-component-root="x-adj">Hello <?slot?>world<?slot-end?>!</p>` +
  `<article data-component-root="x-card" data-tone="warn"><header data-component="x-card"><?slot name="title" fallback?>Untitled<?slot-end?></header><div data-component="x-card"><?slot?><b>Body</b><?slot-end?></div></article>`;
const node = {
  parse5: parse5.serialize(parse5.parseFragment(pi)),
  minifierDefaults: await minify(pi, {}),
  minifierTypical: await minify(pi, { collapseWhitespace: true, removeComments: true }),
  sanitizeHtml: sanitizeHtml(pi, { allowedAttributes: false, allowedTags: false }),
};
for (const [k, v] of Object.entries(node)) console.log(`node ${k.padEnd(17)} ${v}`);

for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent("<!doctype html><body>");
  await page.addScriptTag({ content: purify }); await page.addScriptTag({ content: reader });
  const r = await page.evaluate(({ pi, node }) => {
    const rec = (html) => { const d = document.createElement("div"); d.setHTMLUnsafe(html); return window.RenderedForm.recover(d); };
    const viaInner = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.innerHTML; };
    const out = { baseline: rec(pi) };
    out.innerHTMLTwice = rec(viaInner(viaInner(pi)));
    out.dompurify = rec(DOMPurify.sanitize(pi));
    out.dompurifyCommentForm = rec(DOMPurify.sanitize(viaInner(pi).replace(/<\?(.*?)\?>/g, "<!--?$1?-->")));
    if ("setHTML" in Element.prototype) { const d = document.createElement("div"); d.setHTML(pi); out.sanitizerAPI = window.RenderedForm.recover(d); }
    out.textAfterStrip = (() => { const d = document.createElement("div"); d.setHTMLUnsafe(node.minifierTypical); return [...d.firstChild.childNodes].map((n) => n.nodeType).join(","); })();
    for (const [k, v] of Object.entries(node)) out[`node:${k}`] = rec(v);
    return out;
  }, { pi, node });
  console.log(`\n${bname}`); for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(22)} ${v}`);
  await browser.close();
}
