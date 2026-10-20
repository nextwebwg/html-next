import { describe, expect, it } from "vitest";
import { decodeHydrationValue, encodeHydrationValue } from "../../html-next/src/bindings.js";
import { privateReadBridge, type ServerReadContext } from "../src/private-readers.js";
import { readChannel } from "../src/read-channel.js";
import type { LoadContext } from "../src/types.js";

describe("private read channel", () => {
  it("cancels one parent operation while another read completes on the same bridge", async () => {
    const owner = new AbortController();
    const first = new AbortController();
    const second = new AbortController();
    const calls = new Map<string, { context: ServerReadContext; resolve(value: string): void }>();
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const request = new Request("https://example.test/page/");
    const context: LoadContext = {
      phase: "request", url: new URL(request.url), base: "/", params: {}, parent: {}, propNames: [],
      fetch, signal: owner.signal, request, cookies: new Map(), response: { status: 200, headers: new Headers() },
      navigation: async () => [], navigationTree: async () => [], breadcrumbs: async () => [],
      pager: async () => ({}), redirect() { throw new Error("Unused redirect"); }, notFound() { throw new Error("Unused notFound"); },
    };
    const bridge = await privateReadBridge({ shell: async () => ({ label: { load(input: string, operation: ServerReadContext) {
      return new Promise<string>(resolve => {
        calls.set(input, { context: operation, resolve });
        if (calls.size === 2) started();
      });
    } } }) }, context, {});
    const channel = readChannel(bridge.port, { decodeHydrationValue, encodeHydrationValue });
    const operation = (signal: AbortSignal) => ({ phase: "request" as const, signal, fetch, sample: null, services: {} });
    try {
      const cancelled = channel.read("shell", "label", "first", operation(first.signal));
      const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      const surviving = channel.read("shell", "label", "second", operation(second.signal));
      await reading;
      const stopped = new Promise<void>(resolve => calls.get("first")!.context.signal.addEventListener("abort", () => resolve(), { once: true }));
      first.abort();
      await rejected; await stopped;
      expect(calls.get("second")!.context.signal.aborted).toBe(false);
      expect(owner.signal.aborted).toBe(false);
      calls.get("first")!.resolve("Late cancelled result");
      calls.get("second")!.resolve("Surviving result");
      expect(await surviving).toBe("Surviving result");
      expect(calls.get("second")!.context.signal.aborted).toBe(false);
    } finally { channel.close(); bridge.close(); bridge.port.close(); }
  });
});
