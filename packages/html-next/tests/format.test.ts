import assert from "node:assert/strict";
import "@formatjs/intl-durationformat/polyfill.js";
import { describe, it } from "vitest";

import { formatValue } from "../src/format.js";

function countConstructors(name: string, run: (count: () => number) => void): void {
  const constructor = Reflect.get(Intl, name);
  let count = 0;
  Reflect.set(Intl, name, new Proxy(constructor, {
    construct(target, args) { count++; return Reflect.construct(target, args); },
  }));
  try { run(() => count); }
  finally { Reflect.set(Intl, name, constructor); }
}

describe("Intl formatter reuse", () => {
  it("shares equivalent settings across values, option order, selectors, ranges, and parts", () => {
    countConstructors("NumberFormat", (count) => {
      assert.equal(formatValue(1, "number", "format", "currency", { currency: "USD" }, "en-US"), "$1.00");
      assert.equal(formatValue(2, "number", "format", { currency: "USD", style: "currency", unused: undefined }, "en-US"), "$2.00");
      assert.equal(formatValue(3, "number", "format", { style: "currency", currency: "USD" }, "en-US"), "$3.00");
      assert.equal(typeof formatValue(1, "number", "formatRange", 3, "currency", { currency: "USD" }, "en-US"), "string");
      assert.equal(Array.isArray(formatValue(1, "number", "formatParts", "currency", { currency: "USD" }, "en-US")), true);
      assert.equal(count(), 1);
      formatValue(1, "number", "format", "currency", { currency: "EUR" }, "en-US");
      formatValue(1, "number", "format", "currency", { currency: "EUR" }, "fr-FR");
      assert.equal(count(), 3);
    });
  });

  it("reuses every Intl constructor, keeping plural messages and relative units outside its settings", () => {
    for (const [name, first, second] of [
      ["DateTimeFormat", ["2026-10-03", "date", "format", {}, "en-US"], ["2026-10-04", "date", "formatParts", {}, "en-US"]],
      ["RelativeTimeFormat", [-1, "number", "format", "relativeTime", { unit: "day" }, "en-US"], [-2, "number", "formatParts", "relativeTime", { unit: "hour" }, "en-US"]],
      ["ListFormat", [["Ada", "Lin"], "list", "format", {}, "en-US"], [["Bea", "Cy"], "list", "formatParts", {}, "en-US"]],
      ["DurationFormat", ["1500ms", "duration", "format", { style: "long" }, "en-US"], ["2500ms", "duration", "formatParts", { style: "long" }, "en-US"]],
      ["DisplayNames", ["CA", "string", "format", "displayName", { type: "region" }, "en-US"], ["US", "string", "format", "displayName", { type: "region" }, "en-US"]],
      ["PluralRules", [1, "number", "format", "plural", { forms: { one: "# item", other: "# items" } }, "en-US"], [2, "number", "format", "plural", { forms: { one: "# person", other: "# people" } }, "en-US"]],
    ] as const) {
      countConstructors(name, (count) => {
        for (const args of [first, second]) {
          const result = formatValue(args[0], args[1], args[2], ...args.slice(3));
          assert.notEqual(result, Symbol.for("html-next.invalid-result"));
        }
        assert.equal(count(), 1, name);
      });
    }
  });

  it("keeps native failures, absence, mutable option coercion, and constructor replacement observable", () => {
    countConstructors("NumberFormat", (count) => {
      const invalid = Symbol.for("html-next.invalid-result");
      for (let i = 0; i < 2; i++) assert.equal(formatValue(1, "number", "format", "currency", { currency: "INVALID" }, "en-US"), invalid);
      assert.equal(count(), 2);
      assert.equal(formatValue(null, "number", "format", "number", {}, "en-US"), undefined);
      assert.equal(formatValue(undefined, "number", "format", "number", {}, "en-US"), undefined);
      assert.equal(count(), 2);
      let digits = 1;
      const options = { minimumFractionDigits: { valueOf: () => digits } };
      assert.equal(formatValue(1, "number", "format", "number", options, "en-US"), "1.0");
      digits = 2;
      assert.equal(formatValue(1, "number", "format", "number", options, "en-US"), "1.00");
      assert.equal(count(), 4);
      assert.equal(formatValue(1, "number", "format", "number", { minimumFractionDigits: null }, "en-US"), "1");
      assert.equal(formatValue(1, "number", "format", "number", { minimumFractionDigits: NaN }, "en-US"), invalid);
      assert.equal(formatValue(1, "number", "format", "number", { minimumFractionDigits: Infinity }, "en-US"), invalid);
    });
    // A later native implementation or SSR polyfill must not receive an old constructor's instance.
    for (let i = 0; i < 2; i++) countConstructors("NumberFormat", (count) => {
      formatValue(1, "number", "format", "number", {}, "en-US");
      assert.equal(count(), 1);
    });
  });

  it("invalidates browser-default language entries and leaves implicit time zones uncached", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const navigator = { language: "en-US" };
    Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true });
    try {
      countConstructors("NumberFormat", (count) => {
        formatValue(1, "number", "format");
        formatValue(2, "number", "format");
        assert.equal(count(), 1);
        navigator.language = "fr-FR";
        formatValue(3, "number", "format");
        assert.equal(count(), 2);
      });
      countConstructors("DateTimeFormat", (count) => {
        for (let i = 0; i < 2; i++) formatValue("2026-10-03T13:45Z", "datetime", "format", { timeStyle: "short" }, "en-US");
        assert.equal(count(), 2);
        for (let i = 0; i < 2; i++) formatValue("2026-10-03T13:45Z", "datetime", "format", { timeStyle: "short", timeZone: "UTC" }, "en-US");
        assert.equal(count(), 3);
      });
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("bounds retained settings while continuing to format evicted entries", () => {
    countConstructors("NumberFormat", (count) => {
      const currency = (i: number): string => `X${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`;
      for (let i = 0; i < 129; i++) assert.equal(typeof formatValue(i, "number", "format", "currency", { currency: currency(i) }, "en-US"), "string");
      assert.equal(count(), 129);
      formatValue(1, "number", "format", "currency", { currency: currency(128) }, "en-US");
      assert.equal(count(), 129);
      formatValue(1, "number", "format", "currency", { currency: currency(0) }, "en-US");
      assert.equal(count(), 130);
    });
  });
});
