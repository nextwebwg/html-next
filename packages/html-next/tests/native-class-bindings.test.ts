import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { carrierHtml, visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/class-bindings.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string; carrier?: string; error?: string;
}[];

describe("native and Node class fixtures", () => {
  it.each(fixtures)("renders $name", async ({ name, source, expected, carrier, error }) => {
    const result = renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    if (error !== undefined) { await assert.rejects(result, new RegExp(error)); return; }
    const { html } = await result;
    assert.equal(visibleComponentHtml(html), expected);
    if (carrier !== undefined) assert.equal(carrierHtml(html, "x-unused"), carrier);
  });
});
