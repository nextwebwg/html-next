import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { it } from "vitest";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { plainSlotExpected } from "../../html-next/tests/fixtures/plain-slot-ownership.js";
import { plainSlotRendering } from "./fixtures/plain-slot-rendering.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const elements = (node: Node): Element[] => "childNodes" in node ? node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : []) : [];
const text = (node: Node): string => "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
const attribute = (element: Element, name: string): boolean => element.attrs.some(attribute => attribute.name === name);

for (const target of ["react", "preact"] as const) it(`${target} server output shares plain nodes and repeats lazy templates`, async () => {
  const { directory, html } = await plainSlotRendering(target);
  try {
    const tree = parseFragment(html);
    const articles = elements(tree).filter(element => attribute(element, "data-plain-case"));
    assert.deepEqual(articles.map(article => {
      const section = article.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "section")!;
      return section.childNodes.flatMap(node => "tagName" in node ? [[node.tagName, text(node)]] : []);
    }), plainSlotExpected);
    assert.equal(elements(tree).filter(element => element.tagName === "i" && text(element) === "Plain").length, 5);
    for (const [name, expected] of [["data-repeated-lazy", "Fresh"], ["data-default-lazy", "DefaultFresh"]]) {
      const section = elements(tree).find(element => attribute(element, name!))!;
      assert.deepEqual(elements(section).filter(element => element.tagName === "i").map(text), [expected, expected]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
