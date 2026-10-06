/** Scoring for the pinned keyed js-framework-benchmark sweep; see docs/framework-benchmark.md. */

export const IDS = [
  "01_run1k", "02_replace1k", "03_update10th1k_x16", "04_select1k", "05_swap1k",
  "06_remove-one-1k", "07_create10k", "08_create1k-after1k_x2", "09_clear1k_x8",
] as const;
export type WorkloadId = (typeof IDS)[number];
export const WEIGHTS: Readonly<Record<WorkloadId, number>> = {
  "01_run1k": 0.64280248137063,
  "02_replace1k": 0.5607178150466176,
  "03_update10th1k_x16": 0.5643800750716564,
  "04_select1k": 0.1925635870170522,
  "05_swap1k": 0.13200612879341714,
  "06_remove-one-1k": 0.5277091212292658,
  "07_create10k": 0.5644449600965534,
  "08_create1k-after1k_x2": 0.5508359820582848,
  "09_clear1k_x8": 0.4225836631419211,
};
export const CONTROLS = ["react-hooks", "vue", "svelte", "solid"] as const;
/** The owner's target: the Vite-compiled entry at or below 0.99x each of these. Svelte is reported only. */
export const GATED_CONTROLS = ["solid", "vue", "react-hooks"] as const;
export const TARGET = 0.99;
/** Summary prefix for each HTML Next candidate entry directory. */
export const MODES = { vite: "html-next-vite-candidate", live: "html-next-live-candidate" } as const;
/**
 * Gate limits: aggregate noise allowance and the repository's 25% hot-path threshold. The gate is
 * deliberately stricter than that rule: it does not apply the rule's 1 KB / 5% gzip savings
 * exemption, so a size-saving trade fails here and goes to owner review with both bundle sizes.
 */
export const LIMITS = { weighted: 1.03, workload: 1.25 } as const;
/** No bundle bloat: the Vite-compiled entry may not grow by more than 1 KB gzip or by more than 5%. */
export const SIZE_LIMITS = { gzipBytes: 1024, ratio: 0.05 } as const;
export type Status = "pass" | "regression" | "inconclusive";

export type Rows = Partial<Record<WorkloadId, number>>;
export type Medians = Record<string, Rows>;
export interface ResultFile {
  readonly framework: string;
  readonly benchmark: string;
  readonly type: string;
  readonly values?: { readonly total?: { readonly values?: readonly number[] } };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Median total duration per entry and workload; selection runs ten extra samples. */
export function collectMedians(files: readonly ResultFile[], count: number, ids: readonly WorkloadId[] = IDS): Medians {
  const medians: Medians = {};
  for (const file of files) {
    const id = file.benchmark as WorkloadId;
    if (file.type !== "cpu" || !ids.includes(id)) continue;
    const rows = (medians[file.framework] ??= {});
    if (rows[id] !== undefined) throw new Error(`Duplicate result for ${file.framework} ${id}.`);
    const samples = file.values?.total?.values ?? [];
    const expected = count + (id === "04_select1k" ? 10 : 0);
    if (samples.length !== expected) throw new Error(`${file.framework} ${id}: expected ${expected} samples, found ${samples.length}.`);
    if (!samples.every((value) => Number.isFinite(value) && value > 0)) throw new Error(`${file.framework} ${id}: invalid sample.`);
    rows[id] = median(samples);
  }
  if (Object.keys(medians).length === 0) throw new Error("No CPU results.");
  for (const [name, rows] of Object.entries(medians)) {
    if (ids.some((id) => rows[id] === undefined)) throw new Error(`Incomplete workload coverage for ${name}.`);
  }
  return medians;
}

/** Weighted geometric mean of per-workload ratios over the workloads both rows measured. */
export function weightedRatio(numerator: Rows, denominator: Rows): number {
  let sum = 0;
  let total = 0;
  for (const id of IDS) {
    const value = numerator[id];
    if (value === undefined) continue;
    sum += WEIGHTS[id] * Math.log(value / denominator[id]!);
    total += WEIGHTS[id];
  }
  return Math.exp(sum / total);
}

/** Each entry's weighted ratio to the fastest entry per workload in the same sweep. */
export function scores(medians: Medians): Record<string, number> {
  const rows = Object.values(medians);
  const fastest: Rows = Object.fromEntries(IDS.filter((id) => rows[0]![id] !== undefined)
    .map((id) => [id, Math.min(...rows.map((row) => row[id]!))]));
  return Object.fromEntries(Object.entries(medians).map(([name, row]) => [name, weightedRatio(row, fastest)]));
}

/** Resolves an entry directory to its versioned result name, e.g. `solid` to `solid-v1.9.3-keyed`. */
export function entryName(medians: Medians, directory: string): string | undefined {
  const matches = Object.keys(medians).filter((name) => name.startsWith(`${directory}-v`) || name === `${directory}-keyed`);
  if (matches.length > 1) throw new Error(`Ambiguous entry ${directory}: ${matches.join(", ")}.`);
  return matches[0];
}

/**
 * Flat metrics: `<mode>_score`, `<mode>_vs_<control>` for each control that ran, `<mode>_vs_gated_max`
 * (the largest ratio to Solid, Vue and React), `<mode>_vs_fastest_competitor` (all four controls) and
 * `gated_target_met`. `live_*` names match the pre-tracking evaluator, so older summaries stay comparable.
 */
export function summarize(medians: Medians): Record<string, unknown> {
  const score = scores(medians);
  const controls: Partial<Record<(typeof CONTROLS)[number], string>> = Object.fromEntries(CONTROLS.flatMap((control) => {
    const name = entryName(medians, control);
    return name === undefined ? [] : [[control, name]];
  }));
  const ran = (all: readonly (typeof CONTROLS)[number][]): string[] | undefined =>
    all.every((control) => controls[control] !== undefined) ? all.map((control) => controls[control]!) : undefined;
  const summary: Record<string, unknown> = { median_ms: medians, scores: score, controls };
  for (const [mode, directory] of Object.entries(MODES)) {
    const name = entryName(medians, directory);
    if (name === undefined) continue;
    const ratio = (control: string): number => score[name]! / score[control]!;
    summary[`${mode}_score`] = score[name];
    for (const [control, entry] of Object.entries(controls)) summary[`${mode}_vs_${control.replace("-", "_")}`] = ratio(entry);
    // The fastest control has the lowest score, so it gives the largest ratio. "Fastest competitor"
    // means the fastest of all four controls, never of a partial field.
    const gated = ran(GATED_CONTROLS);
    if (gated !== undefined) summary[`${mode}_vs_gated_max`] = Math.max(...gated.map(ratio));
    const all = ran(CONTROLS);
    if (all !== undefined) summary[`${mode}_vs_fastest_competitor`] = Math.max(...all.map(ratio));
  }
  if (typeof summary["vite_vs_gated_max"] === "number") summary["gated_target_met"] = summary["vite_vs_gated_max"] <= TARGET;
  const live = entryName(medians, MODES.live);
  const reference = entryName(medians, "html-next-live-reference");
  if (live !== undefined && reference !== undefined) summary["live_vs_reference"] = weightedRatio(medians[live]!, medians[reference]!);
  return summary;
}

export interface SweepComparison {
  readonly weightedRatio: number;
  readonly workloads: Rows;
}

export function compareSweep(candidate: Rows, reference: Rows): SweepComparison {
  const workloads: Rows = Object.fromEntries(IDS.filter((id) => candidate[id] !== undefined)
    .map((id) => [id, candidate[id]! / reference[id]!]));
  return { weightedRatio: weightedRatio(candidate, reference), workloads };
}

/**
 * A verdict needs two agreeing sweeps: the same failed limit in two sweeps is a regression and
 * two clean sweeps pass. Anything else is inconclusive; the caller may add one sweep, never more.
 */
export function assessComparison(sweeps: readonly SweepComparison[]) {
  const failures = sweeps.map((sweep) => [
    ...(sweep.weightedRatio > LIMITS.weighted ? ["weighted"] : []),
    ...IDS.filter((id) => sweep.workloads[id]! > LIMITS.workload),
  ]);
  const repeated = [...new Set(failures.flat())].filter((limit) => failures.filter((failed) => failed.includes(limit)).length >= 2);
  const passes = failures.filter((failed) => failed.length === 0).length;
  const measured = IDS.filter((id) => sweeps[0]?.workloads[id] !== undefined);
  return {
    status: repeated.length > 0 ? "regression" : passes >= 2 ? "pass" : "inconclusive",
    limits: LIMITS,
    repeatedFailures: repeated,
    sweepFailures: failures,
    medianWeightedRatio: median(sweeps.map((sweep) => sweep.weightedRatio)),
    workloadMedianRatios: Object.fromEntries(measured.map((id) => [id, median(sweeps.map((sweep) => sweep.workloads[id]!))])),
  } as const;
}

/** The Vite-compiled entry's gzip growth against the base build; see SIZE_LIMITS. */
export function assessSize(candidateGzip: number, baseGzip: number) {
  const growth = candidateGzip - baseGzip;
  return {
    status: growth > SIZE_LIMITS.gzipBytes || growth > baseGzip * SIZE_LIMITS.ratio ? "regression" : "pass",
    limits: SIZE_LIMITS,
    candidateGzip,
    baseGzip,
    growthBytes: growth,
    growthRatio: growth / baseGzip,
  } as const;
}

/** The gate passes only when every part passes; any regression outranks an inconclusive part. */
export function combineStatus(statuses: readonly Status[]): Status {
  return statuses.includes("regression") ? "regression" : statuses.includes("inconclusive") ? "inconclusive" : "pass";
}
