import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { carrierHtml, visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/deferred-components.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; carrier: string;
}[];

const placed = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/invocation-props.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string;
}[];

describe("native and Node deferred component content", () => {
  it.each(placed)("binds placed $name", async ({ name, source, expected }) => {
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(visibleComponentHtml(html), expected);
  });

  it.each(fixtures)("renders $name in its unused carrier", async ({ name, source, carrier }) => {
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(carrierHtml(html, "x-unused"), carrier);
  });
});
