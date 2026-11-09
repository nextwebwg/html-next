import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { carrierHtml, visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/invocation-attributes.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string; carrier?: string;
}[];

describe("native and Node invocation attributes", () => {
  it.each(fixtures)("forwards $name", async ({ name, source, expected, carrier }) => {
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(visibleComponentHtml(html), expected);
    if (carrier !== undefined) assert.equal(carrierHtml(html, "x-unused"), carrier);
  });
});
