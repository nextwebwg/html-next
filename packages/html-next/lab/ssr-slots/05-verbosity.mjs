// R9: how much of a lowered component-library docs page is the provenance record.
import { chromium } from "playwright";
const url = process.argv[2];
if (!url) throw new Error("Usage: node 05-verbosity.mjs <URL of a lowered page>");
const browser = await chromium.launch(); const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle" });
const r = await page.evaluate(() => {
  const roots = [...document.querySelectorAll("[data-component-root]")];
  const outer = roots.filter((root) => !root.parentElement?.closest("[data-component-root]"));
  const html = outer.map((root) => root.outerHTML).join("");
  const attrBytes = (re) => (html.match(re) ?? []).join("").length;
  return {
    componentRoots: roots.length,
    componentMarkupBytes: html.length,
    dataComponent: attrBytes(/ data-component="[^"]*"/g),
    dataComponentRoot: attrBytes(/ data-component-root="[^"]*"/g),
    dataSlotted: attrBytes(/ data-slotted=""/g),
    stampedElements: (html.match(/ data-component="/g) ?? []).length,
  };
});
r.provenanceShare = `${(((r.dataComponent + r.dataComponentRoot + r.dataSlotted) / r.componentMarkupBytes) * 100).toFixed(1)}%`;
console.log(JSON.stringify(r, null, 1));
await browser.close();
