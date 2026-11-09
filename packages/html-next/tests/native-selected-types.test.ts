import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const cases = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/selected-types.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; entry: string; inputs: Record<string, unknown>; expected: string;
}[];

describe("native and Node selected input types", () => {
  it.each(cases)("renders $name", async ({ name, source, entry, inputs, expected }) => {
    const { html } = await renderComponents(`<${entry}></${entry}>`, {
      definitions: parseComponentResource(source, name + ".html").definitions, props: { [entry]: inputs },
    });
    assert.equal(visibleComponentHtml(html), expected);
  });
});
