import { describe, expect, it, vi } from "vitest";
import { parseComponent } from "../../html-next/src/source-parser.js";
import { decodeHydrationValue, encodeHydrationValue } from "../../html-next/src/bindings.js";
import { privateReadResponse } from "../src/private-api.js";
import { requestReadContext } from "../src/server.js";
import { serverReaders } from "../src/private-readers.js";

describe("private reader input boundary", () => {
  it("leaves loader-only modules and their helper exports alone", () => {
    expect(serverReaders({ load: () => ({ props: {} }), create: () => ({ service: true }) }, "page.server.js")).toBeUndefined();
    expect(() => serverReaders({ props: { value: { input: () => 1, load: () => 1 } } }, "component.server.js")).toThrow(/selector and policy/);
    expect(() => serverReaders({ props: { value: { load: () => 1 } }, create: () => ({}) }, "component.server.js")).toThrow(/create belongs/);
  });
  it("uses typed state-selected props, sampled fields and the current enable condition", async () => {
    const definition = parseComponent(`<template component="private-typed"><defs>
      <state name="mode" type="keyword" values="text, number" value="text"></state>
      <state name="enabled" type="boolean" value="true"></state><state name="note" type="string" value="original"></state>
      <prop name="id">Lookup.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
      <prop name="value">Result.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
      </defs><output></output></template>`);
    const samples: unknown[] = [];
    const sources = new Map([["revision", { definition, common: async () => ({ props: { value: {
      input: (props: Readonly<Record<string, unknown>>) => props.id,
      when: (_props: unknown, { state }: { state: Readonly<Record<string, unknown>> }) => state.enabled,
      sample: (_props: unknown, { state }: { state: Readonly<Record<string, unknown>> }) => state.note,
    } } }), readers: async () => ({ value: { load(input: unknown, { sample }: { sample: unknown }) { samples.push(sample); return sample === "invalid-output" ? "3" : input; } } }) }]]);
    const send = async (props: Record<string, unknown>, state: Record<string, unknown>) => {
      const request = new Request("http://localhost/app/_htmlkit/read", { method: "POST", body: JSON.stringify({ version: 1,
        source: "revision", tag: "private-typed", name: "value", url: "http://localhost/app/", inputs: encodeHydrationValue({ props, state }),
      }) });
      return privateReadResponse(request, "/app/", sources, url => requestReadContext(request, url, "/app/", {}, undefined));
    };
    const fields = { mode: "number", enabled: true, note: "sample" };
    const response = await send({ id: 3 }, fields);
    expect(response.status).toBe(200);
    expect(decodeHydrationValue((await response.json()).value)).toBe(3);
    expect((await send({ id: "3" }, fields)).status).toBe(400);
    expect((await send({ id: 3 }, { ...fields, enabled: false })).status).toBe(409);
    expect((await send({ id: 3 }, { ...fields, mode: "forged" })).status).toBe(400);
    expect(samples).toEqual(["sample"]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invalidOutput = await send({ id: 3 }, { ...fields, note: "invalid-output" });
      expect(invalidOutput.status).toBe(500);
      expect(await invalidOutput.text()).toContain("Could not load component data.");
      expect(logged).toHaveBeenCalledOnce();
    } finally { logged.mockRestore(); }
  });
});
