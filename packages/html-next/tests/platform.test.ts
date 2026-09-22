import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import {
  getDomInterface,
  resolveDomProperty,
} from "../src/platform.js";

describe("generated DOM property contracts", () => {
  it("maps HTML tags to their platform interfaces", () => {
    assert.equal(getDomInterface("button"), "HTMLButtonElement");
    assert.equal(getDomInterface("h1"), "HTMLHeadingElement");
    assert.equal(getDomInterface("input"), "HTMLInputElement");
  });

  it("resolves lowercase keys to exact inherited DOM property spelling", () => {
    assert.equal(resolveDomProperty("button", "disabled"), "disabled");
    assert.equal(resolveDomProperty("button", "formaction"), "formAction");
    assert.equal(resolveDomProperty("button", "innerhtml"), "innerHTML");
    assert.equal(resolveDomProperty("h1", "textcontent"), "textContent");
    assert.equal(resolveDomProperty("input", "value"), "value");
  });

  it("normalizes lookup spelling once and returns undefined for unknowns", () => {
    assert.equal(resolveDomProperty("button", "FORMaction"), "formAction");
    assert.equal(resolveDomProperty("BUTTON", "innerHTML"), "innerHTML");
    assert.equal(resolveDomProperty("button", "definitelyMissing"), undefined);
    assert.equal(resolveDomProperty("unknown-tag", "value"), undefined);
  });

  it("uses generated static data rather than runtime prototype reflection", async () => {
    const source = await readFile(new URL("../src/platform.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /Object\.get(?:OwnPropertyNames|PrototypeOf)/);
  });
});

