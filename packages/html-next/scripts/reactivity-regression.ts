import { geometricMean, median, workloads, type FrameworkResult } from "./reactivity-benchmark.js";

export interface ComparisonSample {
  readonly before: FrameworkResult;
  readonly candidate: FrameworkResult;
  readonly after: FrameworkResult;
}

/** Nine paired fresh-process samples: the second smallest is a 98% one-sided sign bound. */
export function assessRegression(samples: readonly ComparisonSample[]) {
  if (samples.length !== 9) throw new Error("Nine comparison samples are required.");
  for (const sample of samples) for (const result of [sample.before, sample.candidate, sample.after]) {
    for (const { name } of workloads) {
      if (!(result.workloads[name]! > 0) || !Number.isFinite(result.workloads[name])) {
        throw new Error(`Missing or invalid timing for ${name}.`);
      }
    }
  }
  const relativeSpread = (ratio: number): number => Math.max(ratio, 1 / ratio) - 1;
  const controls = workloads.map(({ name }) => ({
    name,
    ratio: median(samples.map((sample) => sample.after.workloads[name]!)) /
      median(samples.map((sample) => sample.before.workloads[name]!)),
  }));
  const controlScoreSpread = relativeSpread(geometricMean(controls.map(({ ratio }) => ratio)));
  const controlMaxSpread = Math.max(...controls.map(({ ratio }) => relativeSpread(ratio)));
  const ratios = (name: string): number[] => samples.map(({ before, candidate, after }) =>
    candidate.workloads[name]! / Math.sqrt(before.workloads[name]! * after.workloads[name]!));
  const assess = (name: string, values: readonly number[], limit: number) => {
    const lowerBound = [...values].sort((a, b) => a - b)[1]!;
    return { name, medianRatio: median(values), lowerBound, limit, regression: lowerBound > limit };
  };
  const timings = workloads.map(({ name }) => assess(name, ratios(name), 1.25));
  const score = assess("geometric-mean", samples.map((_, index) =>
    geometricMean(workloads.map(({ name }) => ratios(name)[index]!))), 1.10);
  const stable = controlScoreSpread <= 0.05 && controlMaxSpread <= 0.10;
  return {
    status: !stable ? "inconclusive" : score.regression || timings.some(({ regression }) => regression) ? "regression" : "pass",
    controlScoreSpread, controlMaxSpread, controls, score, workloads: timings,
  };
}
