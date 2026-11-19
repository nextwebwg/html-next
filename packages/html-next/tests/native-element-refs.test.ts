import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { inertCarrierReferences, visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/element-references.json", import.meta.url), "utf8")) as {
  valid: readonly { name: string; source: string; expected: string; inertRefs: string[] }[];
  invalid: readonly { name: string; source: string; reason: string }[];
};

describe("native and Node element reference fixtures", () => {
  it.each(fixtures.valid)("consumes $name", async ({ name, source, expected, inertRefs }) => {
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(visibleComponentHtml(html), expected);
    assert.deepEqual(inertCarrierReferences(html), inertRefs);
  });

  it.each(fixtures.invalid)("rejects $name", ({ name, source, reason }) => {
    assert.throws(() => parseComponentResource(source, name + ".html"), new RegExp(reason, "i"));
  });
});
