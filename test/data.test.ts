import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DataResource, type DataState } from "../src/data.js";

describe("declared data resource", () => {
  it("expands URI parameters, appends query values, and exposes state transitions", async () => {
    const states: DataState[] = [];
    let requested = "";
    const resource = new DataResource({
      source: "/users/{id}",
      baseURL: "https://api.example/app/",
      fetch: async (input) => {
        requested = String(input);
        return new Response(JSON.stringify({ name: "Ada" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      onState: (state) => states.push(state),
    });
    resource.update({ id: 7, include: ["team", "role"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requested, "https://api.example/users/7?include=team&include=role");
    assert.deepEqual(states.map(({ pending, ok }) => ({ pending, ok })), [
      { pending: true, ok: false },
      { pending: false, ok: true },
    ]);
    assert.deepEqual(states.at(-1)?.value, { name: "Ada" });
  });

  it("aborts stale work, debounces with the owned clock, polls, and stops on disconnect", async () => {
    const callbacks: Array<() => void> = [];
    const aborted: boolean[] = [];
    let requests = 0;
    const resource = new DataResource({
      source: "/search",
      baseURL: "https://api.example/",
      debounce: 10,
      poll: 20,
      setTimer: (callback) => { callbacks.push(callback); return callback; },
      clearTimer: (handle) => {
        const index = callbacks.indexOf(handle as () => void);
        if (index >= 0) callbacks.splice(index, 1);
      },
      fetch: async (_input, init) => {
        requests += 1;
        init?.signal?.addEventListener("abort", () => aborted.push(true));
        return new Response("{}", { status: 200 });
      },
      onState() {},
    });
    resource.update({ q: "a" });
    resource.update({ q: "b" });
    assert.equal(callbacks.length, 1);
    callbacks.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests, 1);
    assert.equal(callbacks.length, 1);
    resource.disconnect();
    assert.equal(callbacks.length, 0);
    assert.deepEqual(aborted, []);
  });
});
