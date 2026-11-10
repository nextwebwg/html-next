import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "vitest";
import { bindModule, encodeHydrationValue, decodeHydrationValue } from "../../html-next/src/bindings.js";
import { createInputPort, INPUT_PORT } from "../../html-next/src/component-inputs.js";
import { parseComponent, parseTypedValue, selectedPropType } from "@nextwebwg/html-next";
import { prepareModule, type PreparationRequest, type PreparationService } from "./looma-preparation.js";

const require = createRequire(new URL("../../html-next/package.json", import.meta.url));
const signals = await import(require.resolve("@preact/signals-core"));
const contract = parseComponent('<template component="x-read"><defs><prop name="rows" type="list(integer)">Rows.</prop></defs><output>{$rows.length}</output></template>').contract;
const encoded = (value: unknown) => JSON.stringify(encodeHydrationValue(value));

function fixture(value: unknown, supplied = false) {
  let active = 0;
  let loads = 0;
  const service: PreparationService = { ...signals, createInputPort, INPUT_PORT, encodeHydrationValue, decodeHydrationValue, parseTypedValue, selectedPropType,
    contracts: { "x-read": contract }, modules: { "x-read": bindModule({
      props: { rows: { input: (_props, { state }) => state.current, async load() { loads++; return value; } } },
      connect() { throw new Error("Server preparation called browser connection."); },
    }) },
    effect(run) { active++; const stop = signals.effect(run); return () => { active--; stop(); }; },
  };
  const request: PreparationRequest = { tag: "x-read", source: "revision", readNames: ["rows", "current", "unused"], supplied: supplied ? ["rows"] : [],
    values: { rows: { value: encoded(supplied ? [7] : null), ready: supplied } } };
  return { service, request, counts: () => ({ active, loads }) };
}

it("prepares actual providers with lazy native state reads and disposes their observations", async () => {
  const { service, request, counts } = fixture([1, 2, 3]);
  const requested: string[] = [];
  const result = await prepareModule(service, request, async names => {
    requested.push(...names);
    assert.deepEqual(names, ["current"]);
    return { current: { value: encoded(3), ready: true } };
  }, new AbortController().signal);
  assert.deepEqual(requested, ["current"]);
  assert.deepEqual(result, { source: "revision", reads: { rows: { input: encoded(3), value: encoded([1, 2, 3]) } } });
  assert.deepEqual(counts(), { active: 0, loads: 1 });
});

it("keeps native caller inputs ahead of producer preparation", async () => {
  const { service, request, counts } = fixture([1, 2, 3], true);
  const result = await prepareModule(service, request, async () => { throw new Error("Caller-owned rows evaluated a producer input."); }, new AbortController().signal);
  assert.deepEqual(result.reads, {});
  assert.deepEqual(counts(), { active: 0, loads: 0 });
});

it("reports a refused producer output and disposes its observations", async () => {
  const { service, request, counts } = fixture("wrong");
  await assert.rejects(prepareModule(service, request, async () => ({ current: { value: encoded(3), ready: true } }), new AbortController().signal), /outside its declared type/);
  assert.deepEqual(counts(), { active: 0, loads: 1 });
});
