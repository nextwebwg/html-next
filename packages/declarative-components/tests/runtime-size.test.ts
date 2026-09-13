import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, it } from "vitest";

const execute = promisify(execFile);
const packageRoot = new URL("../", import.meta.url);
const script = new URL("../scripts/measure-runtime-size.ts", import.meta.url);

async function measure(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execute(
    process.execPath,
    ["--import=tsx", script.pathname, ...args],
    { cwd: packageRoot },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("runtime size measurement", () => {
  it("separates complete live output from native-build capability attribution", async () => {
    const report = await measure();
    assert.deepEqual(Object.keys(report), ["live_distributable", "native_build"]);

    const live = report.live_distributable as {
      mode: string;
      graph: string;
      capabilityProfile: {
        complete: boolean;
        missingModules: string[];
        requiredModules: Record<string, string>;
      };
      subsystemInventory: {
        subsystemBytes: Record<string, number>;
        unclassifiedModules: string[];
      };
    };
    assert.equal(live.mode, "live-browser-distributable");
    assert.equal(live.graph, "open");
    assert.equal(live.capabilityProfile.complete, true);
    assert.deepEqual(live.capabilityProfile.missingModules, []);
    assert.deepEqual(live.subsystemInventory.unclassifiedModules, []);
    assert.ok(Object.keys(live.subsystemInventory.subsystemBytes).length > 1);
    assert.deepEqual(Object.keys(live.capabilityProfile.requiredModules).sort(), [
      "componentGraph",
      "controllerHost",
      "declaredData",
      "expressionEvaluation",
      "formEnhancement",
      "generalRuntime",
      "jsonSchema",
      "liveSource",
      "proposalParser",
      "reactivity",
      "sanitization",
      "scopedStyles",
      "typeSystem",
      "validation",
    ]);

    const native = report.native_build as {
      mode: string;
      graph: string;
      capabilityFixtures: Record<string, unknown>;
    };
    assert.equal(native.mode, "native-application-or-library-build");
    assert.equal(native.graph, "fixture-specific-attribution");
    assert.deepEqual(Object.keys(native.capabilityFixtures), [
      "static",
      "reactive",
      "prop",
      "computed",
      "keyed",
      "data",
      "form",
      "controller",
    ]);
  });

  it("provides a flat complete-live profile for the optimizer", async () => {
    const report = await measure("--profile=live-distributable");
    assert.deepEqual(Object.keys(report), [
      "live_distributable_gzip",
      "live_distributable_bytes",
      "live_distributable_complete_capability_profile",
      "live_distributable_missing_capability_modules",
      "live_distributable_unclassified_modules",
      "browser_parse5_modules",
      "browser_dom_property_inventory_modules",
    ]);
    assert.equal(report.live_distributable_complete_capability_profile, 1);
    assert.equal(report.live_distributable_unclassified_modules, 0);
    assert.deepEqual(report.live_distributable_missing_capability_modules, []);
  });
});
