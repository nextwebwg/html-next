import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { JSDOM } from "jsdom";
import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { parseTypedValue } from "../src/type-system.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/interface-declarations.json", import.meta.url), "utf8")) as {
  valid: readonly { name: string; source: string; expected: string }[];
  invalid: readonly { name: string; source: string; reason: string }[];
};

describe("native and Node interface declaration fixtures", () => {
  it("retains scalar payload constraints for event and request consumers", () => {
    const event = parseComponent(fixtures.valid.find(entry => entry.name === "constrained-event")!.source).declarations!.find(entry => entry.kind === "event");
    assert.ok(event?.kind === "event" && event.shape !== undefined);
    assert.equal(parseTypedValue(1, event.shape, "$", "value").ok, true);
    assert.equal(parseTypedValue(3, event.shape, "$", "value").ok, false);
    const request = parseComponent(fixtures.valid.find(entry => entry.name === "constrained-request")!.source).contract.requests!.find;
    assert.equal(parseTypedValue("okay", request!.type, "$", "value").ok, true);
    assert.equal(parseTypedValue("x", request!.type, "$", "value").ok, false);
  });

  it.each(fixtures.valid)("validates $name without rendering declarations", async ({ name, source, expected }) => {
    const { html } = await renderComponents("<x-interface></x-interface>", { definitions: [parseComponent(source, name + ".html")] });
    const dom = new JSDOM(html);
    try {
      const root = dom.window.document.body.firstElementChild!;
      for (let index = root.attributes.length - 1; index >= 0; index--) {
        const name = root.attributes[index]!.name;
        if (["component", "data-html-next-instance", "data-valid"].includes(name) || name.startsWith("data-x-interface-prop-")) root.removeAttribute(name);
      }
      assert.equal(root.outerHTML, expected);
    } finally { dom.window.close(); }
  });

  it.each(fixtures.invalid)("rejects $name during compilation", ({ name, source, reason }) => {
    assert.throws(() => parseComponent(source, name + ".html"), new RegExp(reason, "i"));
  });
});
