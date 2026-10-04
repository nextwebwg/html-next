import { describe, expect, it } from "vitest";
import { assessRegression, type ComparisonSample } from "../scripts/reactivity-regression.js";
import { workloads } from "../scripts/reactivity-benchmark.js";

function samples(ratio: number, control = 1): ComparisonSample[] {
  const result = (value: number) => ({ name: "HTML Next", workloads: Object.fromEntries(workloads.map(({ name }) => [name, value])) });
  return Array.from({ length: 9 }, () => ({ before: result(100), candidate: result(100 * ratio), after: result(100 * control) }));
}

describe("reactive performance gate", () => {
  it("accepts unchanged performance and improvements", () => {
    expect(assessRegression(samples(1)).status).toBe("pass");
    expect(assessRegression(samples(0.8)).status).toBe("pass");
  });
  it("rejects a repeatable aggregate regression and a single hot-path regression", () => {
    expect(assessRegression(samples(1.15)).status).toBe("regression");
    const single = samples(1);
    for (const sample of single) sample.candidate.workloads["diamond"] = 130;
    const report = assessRegression(single);
    expect(report.status).toBe("regression");
    expect(report.score.regression).toBe(false);
  });
  it("does not treat a single slow sample or noisy controls as a proven regression", () => {
    const outlier = samples(1);
    outlier[0] = samples(3)[0]!;
    expect(assessRegression(outlier).status).toBe("pass");
    expect(assessRegression(samples(1.4, 1.2)).status).toBe("inconclusive");
  });
  it("requires complete positive measurements", () => {
    expect(() => assessRegression(samples(1).slice(1))).toThrow();
    expect(() => assessRegression(samples(NaN))).toThrow();
    expect(() => assessRegression(samples(0))).toThrow();
  });
});
