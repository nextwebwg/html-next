import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

interface SupportFeature {
  readonly id: string;
  readonly title: string;
  readonly status: "required" | "experimental" | "deferred";
  readonly spec: string;
  readonly owner: string;
}

interface SupportProfile {
  readonly revision: string;
  readonly features: readonly SupportFeature[];
}

const specRoot = new URL("../docs/spec/", import.meta.url);
const requiredModules = [
  "index.md",
  "delivery-modes.md",
  "live-browser-distributable.md",
  "native-application-build.md",
  "framework-conversion.md",
  "syntax.md",
  "components.md",
  "rendered-form.md",
  "expressions.md",
  "reactivity.md",
  "loading-and-security.md",
  "types-and-validation.md",
  "styling.md",
  "targets-and-conformance.md",
] as const;

const deliveryModules = [
  "live-browser-distributable.md",
  "native-application-build.md",
  "framework-conversion.md",
] as const;

const deliverySections = [
  "Inputs and graph boundary",
  "Capability contract",
  "Runtime ownership",
  "Output artifacts",
  "Failure behavior",
  "Optimization boundary",
  "Measurement contract",
  "Conformance scenarios",
] as const;

describe("normative support profile", () => {
  it("assigns every uniquely identified feature to an existing spec anchor", async () => {
    const profile = JSON.parse(
      await readFile(new URL("support.json", specRoot), "utf8"),
    ) as SupportProfile;

    assert.match(profile.revision, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(profile.features.length > 0);
    assert.equal(new Set(profile.features.map(({ id }) => id)).size, profile.features.length);

    const owners = new Map<string, string>();
    for (const feature of profile.features) {
      assert.match(feature.id, /^HN-[A-Z]+-\d{3}$/);
      assert.ok(feature.title.trim());
      assert.ok(requiredModules.includes(feature.spec as (typeof requiredModules)[number]));
      const source = await readFile(new URL(feature.spec, specRoot), "utf8");
      assert.match(source, new RegExp(`^## ${feature.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      assert.equal(owners.get(feature.id), undefined);
      owners.set(feature.id, `${feature.spec}#${feature.owner}`);
    }
  });

  it("keeps the complete normative module set linked from the index", async () => {
    const index = await readFile(new URL("index.md", specRoot), "utf8");
    for (const module of requiredModules.slice(1)) {
      await assert.doesNotReject(() => readFile(new URL(module, specRoot), "utf8"));
      assert.match(index, new RegExp(`\\(${module.replace(".", "\\.")}\\)`));
    }
  });

  it("requires every normative HTML example to state its expected outcome", async () => {
    for (const module of requiredModules) {
      const source = await readFile(new URL(module, specRoot), "utf8");
      const fences = [...source.matchAll(/^```html(?:\s+([^\n]+))?$/gm)];
      for (const [, disposition] of fences) {
        assert.match(disposition ?? "", /^(conforming|diagnostic HN-[A-Z]+-\d{3})$/);
      }
    }
  });

  it("keeps each delivery mode independently specified and linked", async () => {
    const overview = await readFile(new URL("delivery-modes.md", specRoot), "utf8");
    for (const module of deliveryModules) {
      const source = await readFile(new URL(module, specRoot), "utf8");
      assert.match(overview, new RegExp(`\\(${module.replace(".", "\\.")}\\)`));
      for (const section of deliverySections) {
        assert.match(source, new RegExp(`^## ${section}$`, "m"));
      }
    }
  });
});
