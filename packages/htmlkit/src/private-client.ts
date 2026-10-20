import type { BindingOperation } from "@nextwebwg/html-next/bindings";
import type { ReadCodec } from "./read-channel.js";

/** Only selectors' typed prerequisites cross the wire; the server selects the actual reader input. */
export function privateReaders(codec: ReadCodec, base: string, source: string, tag: string, names: readonly string[], selectors: Readonly<Record<string, string>>) {
  return { props: Object.fromEntries(names.map(name => [name, { async load(_input: unknown, operation: BindingOperation) {
    if (operation.captureInputs === undefined) throw new TypeError("Private readers require the current HTML Next binding library.");
    const frame = operation.captureInputs();
    const discriminators = [...new Set([...Object.keys(frame.props), name].flatMap(name => selectors[name] === undefined ? [] : [selectors[name]!]))];
    const inputs = discriminators.length === 0 ? frame : operation.captureInputs(discriminators);
    const response = await fetch(base + "_htmlkit/read", { method: "POST", credentials: "same-origin", signal: operation.signal,
      headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ version: 1, source, tag, name, url: location.href, inputs: codec.encodeHydrationValue(inputs) }) });
    const result = await response.json() as { value?: unknown; error?: { name?: string; message?: string }; code?: string };
    if (!response.ok) throw Object.assign(new Error(result.error?.message ?? "Could not load component data."), { name: result.error?.name ?? "Error", status: response.status });
    return codec.decodeHydrationValue(result.value);
  } }])) };
}
