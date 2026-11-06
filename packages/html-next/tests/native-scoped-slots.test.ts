import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/scoped-slots.json", import.meta.url), "utf8")) as {
  valid: readonly { name: string; source: string; expected: string }[];
  invalid: readonly { name: string; source: string; reason: string }[];
  renderInvalid: readonly { name: string; source: string; reason: string }[];
};

describe("native and Node scoped slot fixtures", () => {
  it.each(fixtures.valid)("renders $name", async ({ name, source, expected }) => {
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(visibleComponentHtml(html), expected);
  });

  it.each(fixtures.renderInvalid)("rejects $name during rendering", async ({ name, source, reason }) => {
    await assert.rejects(() => renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions }), new RegExp(reason, "i"));
  });

  it.each(fixtures.invalid)("rejects $name", ({ name, source, reason }) => {
    assert.throws(() => parseComponentResource(source, name + ".html"), new RegExp(reason, "i"));
  });
});
