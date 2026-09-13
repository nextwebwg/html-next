import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  classifyLiveRuntimeModules,
  liveRuntimeSubsystemModules,
} from "../scripts/live-runtime-inventory.js";

describe("live runtime subsystem inventory", () => {
  it("assigns each audited module to exactly one subsystem", () => {
    const paths = Object.values(liveRuntimeSubsystemModules).flat();
    assert.equal(new Set(paths).size, paths.length);

    const moduleBytes = Object.fromEntries(paths.map((path, index) => [path, index + 1]));
    const inventory = classifyLiveRuntimeModules(moduleBytes);
    assert.deepEqual(inventory.unclassifiedModules, []);
    assert.equal(
      Object.values(inventory.subsystemBytes).reduce((sum, bytes) => sum + bytes, 0),
      Object.values(moduleBytes).reduce((sum, bytes) => sum + bytes, 0),
    );
  });

  it("surfaces a new live dependency until its responsibility is audited", () => {
    const inventory = classifyLiveRuntimeModules({
      "packages/declarative-components/src/new-layer.ts": 42,
    });
    assert.deepEqual(inventory.unclassifiedModules, [
      "packages/declarative-components/src/new-layer.ts",
    ]);
  });
});
