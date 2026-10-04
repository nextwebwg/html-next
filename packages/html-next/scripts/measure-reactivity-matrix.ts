import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { fileURLToPath } from "node:url";
import { thirdPartyFrameworks } from "./reactivity-matrix-frameworks.js";
import {
  aggregateFramework, geometricMean, htmlNextFramework, measureFramework,
  workloads, type FrameworkResult,
} from "./reactivity-benchmark.js";

const processSamples = 5;
// Longer timed sections reduce scheduler noise; stability is still established by comparing
// independent fresh-process matrix runs rather than these repeated in-process samples.
const iterationScaleArgument = process.argv.find((argument) =>
  argument.startsWith("--iteration-scale="));
const iterationScale = iterationScaleArgument === undefined
  ? 1
  : Number(iterationScaleArgument.slice("--iteration-scale=".length));
if (!Number.isSafeInteger(iterationScale) || iterationScale < 1) {
  throw new Error("Iteration scale must be a positive integer.");
}

const attempted = [() => htmlNextFramework(), ...thirdPartyFrameworks];
const frameworkIndexArgument = process.argv.find((argument) =>
  argument.startsWith("--framework-index="));

if (frameworkIndexArgument !== undefined) {
  const frameworkIndex = Number(frameworkIndexArgument.slice("--framework-index=".length));
  const create = attempted[frameworkIndex];
  if (create === undefined) throw new Error(`Unknown framework index ${frameworkIndex}.`);
  const result = measureFramework(create, iterationScale);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
} else {
  const script = fileURLToPath(import.meta.url);
  const measureInFreshProcess = (frameworkIndex: number): FrameworkResult => {
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      script,
      `--framework-index=${frameworkIndex}`,
      ...(iterationScaleArgument === undefined ? [] : [iterationScaleArgument]),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(output) as FrameworkResult;
  };
  const childError = (error: unknown): string => {
    if (typeof error === "object" && error !== null && "stderr" in error) {
      const stderr = String((error as { readonly stderr: unknown }).stderr);
      const message = stderr.match(/Error: Expected[^\n]*/)?.[0];
      if (message !== undefined) return message;
    }
    return error instanceof Error ? error.message : String(error);
  };
  const rotation = process.pid % attempted.length;
  const samples = new Map<number, FrameworkResult[]>();
  const htmlNextControlSamples: FrameworkResult[] = [];
  const excluded: Array<{ readonly name: string; readonly reason: string }> = [];
  const excludedIndexes = new Set<number>();
  for (let processSample = 0; processSample < processSamples; processSample += 1) {
    const roundRotation = (rotation + processSample * 5) % attempted.length;
    const measurementOrder = Array.from({ length: attempted.length }, (_, offset) =>
      (roundRotation + offset) % attempted.length);
    for (const frameworkIndex of measurementOrder) {
      if (excludedIndexes.has(frameworkIndex)) continue;
      const name = attempted[frameworkIndex]!().name;
      try {
        const result = measureInFreshProcess(frameworkIndex);
        const frameworkSamples = samples.get(frameworkIndex) ?? [];
        frameworkSamples.push(result);
        samples.set(frameworkIndex, frameworkSamples);
      } catch (error) {
        if (name === "HTML Next") throw error;
        excludedIndexes.add(frameworkIndex);
        samples.delete(frameworkIndex);
        excluded.push({ name, reason: childError(error) });
      }
    }
    htmlNextControlSamples.push(measureInFreshProcess(0));
  }

  const measured = [...samples.values()].map(aggregateFramework);
  const htmlNextControl = aggregateFramework(htmlNextControlSamples);
  const htmlNextMeasured = measured.find(({ name }) => name === "HTML Next")!;
  const aaRelativeSpreads = Object.fromEntries(workloads.map(({ name }) => {
    const ratio = htmlNextControl.workloads[name]! / htmlNextMeasured.workloads[name]!;
    return [name, Math.max(ratio, 1 / ratio) - 1];
  }));
  const aaScoreRatio = geometricMean(workloads.map(({ name }) =>
    htmlNextControl.workloads[name]! / htmlNextMeasured.workloads[name]!));
  const aaScoreRelativeSpread = Math.max(aaScoreRatio, 1 / aaScoreRatio) - 1;
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim() === "" ? 0 : 1;
  const bestByWorkload = Object.fromEntries(workloads.map(({ name }) => [
    name,
    Math.min(...measured.map((framework) => framework.workloads[name]!)),
  ]));
  const ranked = measured.map((framework) => ({
    ...framework,
    score: geometricMean(workloads.map(({ name }) =>
      framework.workloads[name]! / bestByWorkload[name]!
    )),
  })).sort((left, right) => left.score - right.score);
  const htmlNextIndex = ranked.findIndex(({ name }) => name === "HTML Next");
  const htmlNext = ranked[htmlNextIndex]!;
  const report = {
    matrix_checks_pass: ranked.length >= 11 && aaScoreRelativeSpread <= 0.05 ? 1 : 0,
    matrix_framework_count: attempted.length,
    matrix_third_party_count: thirdPartyFrameworks.length,
    matrix_ranked_count: ranked.length,
    matrix_excluded_count: excluded.length,
    matrix_process_isolation: 1,
    matrix_process_samples_per_framework: processSamples,
    matrix_rotation: rotation,
    matrix_revision: revision,
    matrix_revision_dirty: dirty,
    matrix_node_version: process.version,
    matrix_measured_at: new Date().toISOString(),
    matrix_cpu: cpus()[0]?.model,
    matrix_os_release: release(),
    matrix_icu_version: process.versions.icu,
    matrix_iteration_scale: iterationScale,
    matrix_lockfile_sha256: createHash("sha256").update(readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url))).digest("hex"),
    matrix_package_versions: Object.fromEntries([
      "@amadeus-it-group/tansu", "@angular/core", "@preact/signals-core", "@reactively/core",
      "@reatom/core", "@solidjs/signals", "@vue/reactivity", "alien-signals", "anod", "mobx",
      "pota", "s-js", "signal-polyfill", "solid-js", "svelte",
    ].map((name) => [name, (JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string }).version])),
    matrix_platform: `${process.platform}-${process.arch}`,
    matrix_aa_score_relative_spread: aaScoreRelativeSpread,
    matrix_aa_max_relative_spread: Math.max(...Object.values(aaRelativeSpreads)),
    matrix_aa_workloads_relative_spread: aaRelativeSpreads,
    html_next_matrix_rank: htmlNextIndex + 1,
    html_next_matrix_score: htmlNext.score,
    ...Object.fromEntries(Object.entries(htmlNext.workloads).map(([name, value]) => [
      `html_next_${name.replaceAll("-", "_")}_ns`, value,
    ])),
    matrix: ranked.map((framework, index) => ({
      name: framework.name,
      rank: index + 1,
      score: framework.score,
      workloads_ns_per_iteration: framework.workloads,
    })),
    excluded,
    matrix_samples: [...samples.values()],
    matrix_control_samples: htmlNextControlSamples,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(report.matrix_checks_pass === 1 ? 0 : 1));
}
