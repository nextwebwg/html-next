import { describe, expect, it } from "vitest";
import {
  IDS, assessComparison, assessSize, collectMedians, combineStatus, compareSweep, median, summarize,
  type ResultFile, type Rows, type WorkloadId,
} from "../scripts/framework-benchmark-score.js";

const file = (framework: string, benchmark: WorkloadId, values: number[]): ResultFile =>
  ({ framework, benchmark, type: "cpu", values: { total: { values } } });
const sweep = (framework: string, value: number, count = 3): ResultFile[] =>
  IDS.map((id) => file(framework, id, Array.from({ length: count + (id === "04_select1k" ? 10 : 0) }, () => value)));
const rows = (value: number, overrides: Rows = {}): Rows => ({ ...Object.fromEntries(IDS.map((id) => [id, value])), ...overrides });

describe("framework benchmark scoring", () => {
  it("takes the statistical median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("requires complete, positive, standard-sized samples", () => {
    expect(Object.keys(collectMedians(sweep("solid-v1.9.3-keyed", 10), 3))).toEqual(["solid-v1.9.3-keyed"]);
    expect(() => collectMedians(sweep("solid-v1.9.3-keyed", 10).slice(1), 3)).toThrow(/coverage/);
    expect(() => collectMedians(sweep("solid-v1.9.3-keyed", 10), 15)).toThrow(/expected 15/);
    expect(() => collectMedians(sweep("solid-v1.9.3-keyed", 0), 3)).toThrow(/invalid/);
    const duplicate = sweep("solid-v1.9.3-keyed", 10);
    expect(() => collectMedians([...duplicate, duplicate[0]!], 3)).toThrow(/Duplicate/);
    expect(Object.keys(collectMedians(sweep("solid-v1.9.3-keyed", 10), 3, ["01_run1k"]))).toHaveLength(1);
  });

  it("scores entries against the fastest per workload and divides scores for ratios", () => {
    const medians = collectMedians([
      ...sweep("html-next-live-candidate-v1+abc-keyed", 30),
      ...sweep("html-next-live-reference-v1+abc-keyed", 30),
      ...sweep("html-next-vite-candidate-v1+def-keyed", 24),
      ...sweep("solid-v1.9.3-keyed", 20),
      ...sweep("vue-v3.5.39-keyed", 25),
      ...sweep("react-hooks-v19.2.0-keyed", 27),
      ...sweep("svelte-v5.42.1-keyed", 16),
      ...sweep("vanillajs-keyed", 15),
    ], 3);
    const summary = summarize(medians);
    expect(summary["live_score"]).toBeCloseTo(2);
    expect(summary["live_vs_solid"]).toBeCloseTo(1.5);
    expect(summary["live_vs_vue"]).toBeCloseTo(1.2);
    expect(summary["live_vs_reference"]).toBeCloseTo(1);
    expect(summary["vite_vs_solid"]).toBeCloseTo(1.2);
    expect(summary["vite_vs_react_hooks"]).toBeCloseTo(24 / 27);
    expect(summary["vite_vs_svelte"]).toBeCloseTo(1.5);
    // The gated target is the largest ratio to Solid, Vue and React; Svelte is reported only.
    expect(summary["vite_vs_gated_max"]).toBeCloseTo(1.2);
    expect(summary["live_vs_gated_max"]).toBeCloseTo(1.5);
    expect(summary["vite_vs_fastest_competitor"]).toBeCloseTo(1.5);
    expect(summary["gated_target_met"]).toBe(false);
    expect(summary["controls"]).toEqual({
      "react-hooks": "react-hooks-v19.2.0-keyed", vue: "vue-v3.5.39-keyed", svelte: "svelte-v5.42.1-keyed", solid: "solid-v1.9.3-keyed",
    });
    const withoutSvelte = Object.fromEntries(Object.entries(medians).filter(([name]) => !name.startsWith("svelte-")));
    expect(summarize(withoutSvelte)).not.toHaveProperty("vite_vs_fastest_competitor");
    expect(summarize(withoutSvelte)["vite_vs_gated_max"]).toBeCloseTo(1.2);
    const withoutVue = Object.fromEntries(Object.entries(medians).filter(([name]) => !name.startsWith("vue-")));
    expect(summarize(withoutVue)).not.toHaveProperty("vite_vs_gated_max");
    expect(summarize(withoutVue)).not.toHaveProperty("gated_target_met");
    const fast = collectMedians([...sweep("html-next-vite-candidate-v1+def-keyed", 19), ...sweep("solid-v1.9.3-keyed", 20),
      ...sweep("vue-v3.5.39-keyed", 25), ...sweep("react-hooks-v19.2.0-keyed", 27)], 3);
    expect(summarize(fast)["gated_target_met"]).toBe(true);
  });

  it("fails the Vite entry for growth over 1 KB gzip or 5%", () => {
    expect(assessSize(40_000, 40_000).status).toBe("pass");
    expect(assessSize(41_024, 40_000).status).toBe("pass");
    expect(assessSize(41_025, 40_000)).toMatchObject({ status: "regression", growthBytes: 1025 });
    expect(assessSize(10_600, 10_000).status).toBe("regression");
    expect(assessSize(30_000, 40_000).status).toBe("pass");
  });

  it("passes the gate only when every part passes", () => {
    expect(combineStatus(["pass", "pass"])).toBe("pass");
    expect(combineStatus(["pass", "inconclusive"])).toBe("inconclusive");
    expect(combineStatus(["inconclusive", "regression"])).toBe("regression");
  });

  it("passes two clean sweeps and rejects a repeated aggregate or hot-path regression", () => {
    const clean = compareSweep(rows(10.2), rows(10));
    expect(assessComparison([clean, clean]).status).toBe("pass");
    const slower = compareSweep(rows(10.5), rows(10));
    expect(assessComparison([slower, slower]).status).toBe("regression");
    const hot = compareSweep(rows(10, { "05_swap1k": 13 }), rows(10));
    expect(hot.weightedRatio).toBeLessThan(1.03);
    expect(assessComparison([hot, hot])).toMatchObject({ status: "regression", repeatedFailures: ["05_swap1k"] });
  });

  it("needs a third sweep for disagreement and never turns a repeated failure into a pass", () => {
    const clean = compareSweep(rows(10), rows(10));
    const slower = compareSweep(rows(10.5), rows(10));
    const hot = compareSweep(rows(10, { "04_select1k": 13 }), rows(10));
    expect(assessComparison([clean, slower]).status).toBe("inconclusive");
    expect(assessComparison([clean, slower, clean]).status).toBe("pass");
    expect(assessComparison([clean, slower, slower]).status).toBe("regression");
    expect(assessComparison([slower, hot, clean]).status).toBe("inconclusive");
    expect(assessComparison([clean, slower, clean]).workloadMedianRatios["01_run1k"]).toBe(1);
  });
});
