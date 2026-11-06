import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { JSDOM } from "jsdom";
import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";

interface AttributeFixture {
  readonly name: string;
  readonly source: string;
  readonly model: Readonly<Record<string, unknown>>;
  readonly expected: string;
}

const fixtures: readonly AttributeFixture[] = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/attribute-bindings.json", import.meta.url), "utf8"));

describe("native and Node attribute binding fixtures", () => {
  it.each(fixtures)("matches $name", async ({ name, source, model, expected }) => {
    const rendered = await renderComponents("<x-attributes></x-attributes>", {
      definitions: [parseComponent(source, `https://example.test/${name}.html`)], props: { "x-attributes": model },
    });
    const dom = new JSDOM(rendered.html);
    try {
      const root = dom.window.document.body.firstElementChild!;
      root.removeAttribute("component");
      root.removeAttribute("data-html-next-instance");
      root.removeAttribute("data-valid");
      for (let index = root.attributes.length - 1; index >= 0; index--) {
        const name = root.attributes[index]!.name;
        if (name.startsWith("data-x-attributes-prop-")) root.removeAttribute(name);
      }
      assert.equal(dom.window.document.body.innerHTML, expected);
    } finally { dom.window.close(); }
  });
});
