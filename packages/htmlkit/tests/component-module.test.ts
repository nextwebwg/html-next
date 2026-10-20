import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { componentModule, connectModules } from "../src/component-module.js";

describe("component module composition", () => {
  it("closes completed hooks on abort and disposes a later asynchronous setup exactly once", async () => {
    const signal = new AbortController();
    const events: string[] = [];
    let complete!: (cleanup: () => void) => void;
    const later = new Promise<() => void>(resolve => { complete = resolve; });
    const connect = connectModules(() => { events.push("common"); return () => events.push("stop-common"); },
      () => { events.push("client"); return later; })!;
    const pending = connect({ props: {} }, { signal: signal.signal, refresh: async () => {} });
    assert.deepEqual(events, ["common", "client"]);
    await Promise.resolve();
    signal.abort();
    assert.deepEqual(events, ["common", "client", "stop-common"]);
    complete(() => events.push("stop-client"));
    const stop = await pending;
    stop?.();
    assert.deepEqual(events, ["common", "client", "stop-common", "stop-client"]);
  });

  it("cleans the other setup when one hook fails and refuses activation with an aborted signal", async () => {
    const signal = new AbortController(); let stopped = 0;
    const connect = connectModules(() => () => { stopped += 1; }, () => { throw new Error("Client setup failed"); })!;
    await assert.rejects(Promise.resolve(connect({ props: {} }, { signal: signal.signal, refresh: async () => {} })), /Client setup failed/);
    assert.equal(stopped, 1);
    signal.abort();
    assert.throws(() => connect({ props: {} }, { signal: signal.signal, refresh: async () => {} }), { name: "AbortError" });
    assert.equal(stopped, 1);
  });

  it("rejects malformed companion factories and patches instead of retaining a silently ignored reader", () => {
    const invalid = [{ props: { label: 42 } }, { props: {}, create: () => ({}) }, { create: () => Promise.reject(new Error("Async factory")) }];
    for (const local of invalid) {
      const module = componentModule({ props: { label: { input: () => 1, load: value => value } } }, local as never);
      assert.throws(() => module.create!(), TypeError);
    }
  });
});
