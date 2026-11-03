// @vitest-environment jsdom
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import ts from "typescript-compiler";
import { describe, it } from "vitest";

import { holdController, pendingControllers, RequestEvent } from "../src/requests.js";
import { REQUEST_HOST_SOURCE } from "../src/targets/request-host-source.js";

const convertedHold = new Function(ts.transpile(REQUEST_HOST_SOURCE + "\nreturn holdController;"))() as typeof holdController;

describe("controller startup", () => {
  it("delivers a request after native and converted owners both finish", async () => {
    const root = document.createElement("button");
    const native = holdController(root), converted = convertedHold(root);
    const delivered: string[] = [];
    const stop = RequestEvent.respond(root, "ready", () => { delivered.push("ready"); return "answer"; });
    const response = RequestEvent.request(root, "ready");
    converted();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(delivered, []);
    native();
    assert.equal(await response, "answer");
    assert.deepEqual(delivered, ["ready"]);
    stop();
  });

  it("collects only controllers inside the requested subtree", async () => {
    const { document } = new JSDOM('<main><button></button></main><aside></aside>').window;
    const root = document.querySelector("main")!;
    const releaseRoot = holdController(root);
    const releaseChild = holdController(root.querySelector("button")!);
    const releaseOther = holdController(document.querySelector("aside")!);
    assert.equal(pendingControllers(root).length, 2);
    assert.equal(pendingControllers(document).length, 3);
    const tasks = pendingControllers(root);
    releaseChild(); releaseRoot();
    await Promise.all(tasks);
    assert.deepEqual(pendingControllers(root), []);
    assert.equal(pendingControllers(document).length, 1);
    releaseOther();
    assert.deepEqual(pendingControllers(document), []);
  });

  for (const [name, hold] of [["native", holdController], ["converted", convertedHold]] as const) {
    for (const order of [[0, 1], [1, 0]]) {
      it(`${name} retains every controller on a collapsed root when ${order[0]} finishes first`, async () => {
        const { document } = new JSDOM('<button></button>').window;
        const root = document.querySelector("button")!;
        const release = [hold(root), hold(root)];
        const tasks = pendingControllers(root);
        let ready = false;
        const finished = Promise.all(tasks).then(() => { ready = true; });
        release[order[0]!]!();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(ready, false);
        assert.equal(pendingControllers(root).length, 1);
        release[order[1]!]!();
        await finished;
        assert.deepEqual(pendingControllers(root), []);
      });
    }
  }
});
