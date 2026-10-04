import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { htmlNextFramework, measureFramework, type FrameworkResult } from "./reactivity-benchmark.js";
import { assessRegression, type ComparisonSample } from "./reactivity-regression.js";

const samplePath = process.argv.find((arg) => arg.startsWith("--sample="))?.slice(9);
if (samplePath !== undefined) {
  const runtime = await import(pathToFileURL(samplePath).href) as typeof import("../src/reactivity.js");
  process.stdout.write(`${JSON.stringify(measureFramework(() => htmlNextFramework(runtime), 40))}\n`);
} else {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const base = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7) ?? "origin/main";
  const revision = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  const directory = mkdtempSync(join(tmpdir(), "html-next-performance-"));
  try {
    const baseline = join(directory, "baseline");
    mkdirSync(baseline);
    const archive = execFileSync("git", ["archive", revision, "packages/html-next/src"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
    const entries = [join(baseline, "packages/html-next/src/reactivity.ts"), join(root, "packages/html-next/src/reactivity.ts")];
    const bundles = entries.map((_, index) => join(directory, `${index}.mjs`));
    for (const [index, entry] of entries.entries()) await build({
      entryPoints: [entry], outfile: bundles[index]!, bundle: true, platform: "node", format: "esm", target: "node22",
    });
    const measure = (index: number): FrameworkResult => JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), `--sample=${bundles[index]!}`],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] })) as FrameworkResult;
    const attempts: Array<{ assessment: ReturnType<typeof assessRegression>; samples: ComparisonSample[] }> = [];
    // One bounded retry handles a noisy host; a regression is never retried to obtain a pass.
    for (let attempt = 0; attempt < 2; attempt++) {
      const samples: ComparisonSample[] = [];
      for (let round = 0; round < 9; round++) {
        // Rotate the candidate's position instead of consistently giving it a warmer/cooler CPU.
        const order = round % 3 === 0 ? [1, 0, 0] : round % 3 === 1 ? [0, 1, 0] : [0, 0, 1];
        const values = order.map(measure);
        const controls = values.filter((_, index) => order[index] === 0);
        samples.push({ before: controls[0]!, candidate: values[order.indexOf(1)]!, after: controls[1]! });
      }
      const assessment = assessRegression(samples);
      attempts.push({ assessment, samples });
      if (assessment.status !== "inconclusive") break;
    }
    const assessment = attempts.at(-1)!.assessment;
    const report = {
      status: assessment.status, baselineRevision: revision,
      candidateRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      candidateDirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim() !== "",
      measuredAt: new Date().toISOString(), node: process.version, icu: process.versions.icu,
      platform: `${process.platform}-${process.arch}`, osRelease: release(), cpu: cpus()[0]?.model,
      iterationScale: 40,
      sourceHashes: bundles.map((file) => createHash("sha256").update(readFileSync(file)).digest("hex")),
      lockfileHash: createHash("sha256").update(readFileSync(join(root, "pnpm-lock.yaml"))).digest("hex"), attempts,
    };
    const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
    if (output !== undefined) writeFileSync(resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // Inconclusive data fails the gate too; it needs a quieter rerun, not a claim of no regression.
    if (report.status !== "pass") process.exitCode = 1;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
