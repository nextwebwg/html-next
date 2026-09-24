import assert from "node:assert/strict";
import { describe, it } from "vitest";

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

  it("adapts decoded responses before publishing them", async () => {
    const states: DataState[] = [];
    const resource = new DataResource({
      source: "/account",
      baseURL: "https://api.example/",
      adapt(value) {
        const record = value as { email?: unknown; age?: unknown };
        if (typeof record.email !== "string" || typeof record.age !== "number") {
          throw new TypeError("Invalid account response.");
        }
        return { email: record.email.trim(), age: Math.trunc(record.age) };
      },
      fetch: async () => new Response(JSON.stringify({ email: " ada@example.com ", age: 37.5 })),
      onState: (state) => states.push(state),
    });
    resource.update({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const final = states.at(-1)!;
    assert.equal(final.ok, true);
    assert.deepEqual(final.value, { email: "ada@example.com", age: 37 });
  });


  it("keeps the last resolved value bound through a refetch and a failure", async () => {
    const states: DataState[] = [];
    let attempt = 0;
    const resource = new DataResource({
      source: "/feed",
      baseURL: "https://api.example/",
      fetch: async () => {
        attempt += 1;
        if (attempt === 1) return new Response(JSON.stringify({ label: "first" }));
        throw new TypeError("offline");
      },
      onState: (state) => states.push(state),
    });

    resource.update({ page: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(states.at(-1), { pending: false, value: { label: "first" }, error: null, ok: true });

    resource.update({ page: 2 });
    // A read in flight reports pending without unbinding the value a template already shows.
    assert.deepEqual(states.at(-1)!.value, { label: "first" });
    assert.equal(states.at(-1)!.pending, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = states.at(-1)!;
    assert.deepEqual(
      { value: failed.value, ok: failed.ok, pending: failed.pending, failed: failed.error !== null },
      { value: { label: "first" }, ok: false, pending: false, failed: true },
    );
  });

});
