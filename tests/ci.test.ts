import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { affectedPackages, createPlan } from "../scripts/ci-plan.js";

describe("affected CI", () => {
  it("keeps an HTMLKit fix out of compiler and framework tests", () => {
    expect(affectedPackages(["packages/htmlkit/src/routes.ts"])).toEqual(["htmlkit"]);
    const plan = createPlan(["packages/htmlkit/src/routes.ts"]);
    expect(plan.node.every((job) => job.package === "htmlkit")).toBe(true);
    expect(plan.browser.every((job) => job.files.every((file) => file.startsWith("packages/htmlkit/")))).toBe(true);
    expect(plan.packages).toEqual(["htmlkit"]);
  });

  it("follows transitive workspace consumers", () => {
    expect(affectedPackages(["packages/html-next/src/reactivity.ts"])).toEqual([
      "html-next", "html-next-converter", "html-next-unplugin", "htmlkit",
    ]);
    expect(affectedPackages(["packages/html-next-converter/src/vue.ts"])).toEqual([
      "html-next-converter", "html-next-unplugin",
    ]);
    expect(affectedPackages(["packages/html-next-unplugin/tests/check.test.ts"])).toEqual(["html-next-unplugin"]);
  });

  it("skips documentation and includes shared build inputs and removed package files", () => {
    expect(affectedPackages(["README.md", "CHANGELOG.md", "docs/guide/install.md", "packages/htmlkit/docs/client-navigation.md"])).toEqual([]);
    expect(affectedPackages(["packages/html-next-converter/src/deleted.ts"])).toEqual(["html-next-converter", "html-next-unplugin"]);
    expect(affectedPackages(["pnpm-lock.yaml"])).toHaveLength(4);
    expect(affectedPackages(["vitest.browser.config.ts"])).toHaveLength(4);
    expect(affectedPackages(["scripts/ci-plan.ts"])).toHaveLength(4);
  });

  it("keeps every browser regression and partitions long specs", () => {
    const plan = createPlan(["pnpm-lock.yaml"]);
    const files = new Set(plan.browser.flatMap((job) => job.files));
    expect(files.has("packages/html-next/tests/runtime.test.ts")).toBe(true);
    expect(files.has("packages/html-next-converter/tests/svelte-public-conformance-parity.test.ts")).toBe(true);
    expect(files.has("packages/html-next-unplugin/tests/framework.test.ts")).toBe(true);
    expect(plan.browser.every((job) => job.seconds <= 180)).toBe(true);
    const runtime = plan.browser.filter((job) => job.files.includes("packages/html-next/tests/runtime.test.ts"));
    expect(runtime).toHaveLength(3);
    for (const name of ["Chromium renders", "Firefox renders", "WebKit renders", "shared regression"]) {
      expect(runtime.filter((job) => new RegExp(job.pattern!).test(name))).toHaveLength(1);
    }
  });

  it("does not import browser-only specs into Node test jobs", () => {
    const plan = createPlan(["pnpm-lock.yaml"]);
    expect(plan.node.flatMap((job) => job.files).some((file) =>
      file === "packages/html-next/tests/runtime.test.ts" || file.includes("-parity.test.ts"))).toBe(false);
    expect(plan.browser).toEqual(createPlan(["pnpm-lock.yaml"]).browser);
  });

  it("emits an empty GitHub matrix and explicit skip flags for an unchanged revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "html-next-ci-"));
    const output = join(directory, "outputs");
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/ci-plan.ts", import.meta.url))], {
        env: { ...process.env, CI_BASE: "HEAD", GITHUB_OUTPUT: output },
      });
      const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      expect(values.node).toBe('{"include":[]}');
      expect(values.browser).toBe('{"include":[]}');
      expect(values.packages).toBe("[]");
      expect(values.has_node).toBe("false");
      expect(values.has_browser).toBe("false");
      expect(values.has_packages).toBe("false");
      expect(values.playwright).toMatch(/^\d+\.\d+\.\d+$/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
