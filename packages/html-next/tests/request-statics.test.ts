import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { RequestEvent } from "../src/requests.js";

/**
 * RequestEvent's static methods (javascript#outside-a-controller) on a plain EventTarget. They never
 * read `this`, so callers destructure them; the DOM paths run in request-parity.test.ts.
 */
describe("RequestEvent static methods", () => {
  const { respond, request, hasResponder } = RequestEvent;

  it("answer, check and ask when destructured", async () => {
    const target = new EventTarget();
    assert.equal(hasResponder(target, "upload"), false);
    const progress: string[] = [];
    const stop = respond<{ size: number }, { src: string }>(target, "upload", async ({ size }, init) => {
      init.progress(1, 2);
      return { src: `blob:${size}` };
    });
    assert.equal(hasResponder(target, "upload"), true);
    assert.deepEqual(await request(target, "upload", { size: 3 }, { progress: (loaded, total) => progress.push(`${loaded}/${total}`) }), { src: "blob:3" });
    assert.deepEqual(progress, ["1/2"]);
    stop();
    assert.equal(hasResponder(target, "upload"), false);
    assert.equal(await request(target, "upload", { size: 3 }), null);
  });

  it("is answered by a plain listener it cannot see, unchecked", async () => {
    const target = new EventTarget();
    target.addEventListener("title", (event) => (event as RequestEvent).respondWith(42));
    assert.equal(hasResponder(target, "title"), false);
    assert.equal(await request<string>(target, "title", "x"), 42);
  });

  it("rejects with the signal's reason and drops the late answer", async () => {
    const target = new EventTarget();
    let aborted = false;
    respond(target, "query", (_detail, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>((resolve) => setTimeout(() => resolve("late"), 20));
    });
    const controller = new AbortController();
    const pending = request(target, "query", null, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(aborted, true);
    await assert.rejects(request(target, "query", null, { signal: AbortSignal.abort() }), { name: "AbortError" });
  });
});
