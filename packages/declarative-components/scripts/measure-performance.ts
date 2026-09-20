import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface MatrixEntry {
  readonly name: string;
  readonly rank: number;
  readonly score: number;
  readonly workloads_ns_per_iteration: Readonly<Record<string, number>>;
}

interface ReactivityReport {
  readonly excluded: readonly { readonly name: string; readonly reason: string }[];
  readonly html_next_matrix_rank: number;
  readonly html_next_matrix_score: number;
  readonly matrix: readonly MatrixEntry[];
  readonly matrix_aa_max_relative_spread: number;
  readonly matrix_aa_score_relative_spread: number;
  readonly matrix_checks_pass: number;
  readonly matrix_excluded_count: number;
  readonly matrix_node_version: string;
  readonly matrix_platform: string;
  readonly matrix_process_samples_per_framework: number;
  readonly matrix_ranked_count: number;
  readonly matrix_revision: string;
  readonly matrix_revision_dirty: number;
  readonly [key: string]: unknown;
}

interface SizeMeasurement {
  readonly bytes: number;
  readonly gzip: number;
}

interface RuntimeReport {
  readonly live_distributable: {
    readonly bundle: SizeMeasurement;
    readonly capabilityProfile: {
      readonly complete: boolean;
      readonly missingModules: readonly string[];
    };
    readonly forbiddenServerModules: {
      readonly generatedDomPropertyInventory: number;
      readonly parse5: number;
    };
    readonly moduleBytes: Readonly<Record<string, number>>;
    readonly subsystemInventory: {
      readonly subsystemBytes: Readonly<Record<string, number>>;
      readonly unclassifiedModules: readonly string[];
    };
  };
  readonly native_build: {
    readonly capabilityFixtures: Readonly<Record<string, SizeMeasurement & {
      readonly fullRuntimeModules: number;
      readonly parserModules: number;
      readonly targetGzip: number | null;
      readonly targetMet: boolean;
    }>>;
  };
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

function measure<T>(scriptName: string): T {
  const script = fileURLToPath(new URL(scriptName, import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "tsx", script], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output) as T;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function words(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

const workloadDescriptions: Readonly<Record<string, string>> = {
  "signal-write-read": "Write one signal, flush any work, then read it back.",
  "effect-propagation": "Write one signal observed by one effect and verify the effect sees it.",
  "computed-chain": "Update the source of ten chained computed values observed by one effect.",
  diamond: "Update one source feeding two computed branches that join before one effect.",
  "dynamic-dependencies": "Switch a computed between two source branches, then update the active branch.",
  "fan-out-32": "Update one source observed by 32 independent effects.",
};

function renderReport(runtime: RuntimeReport, reactivity: ReactivityReport): string {
  const live = runtime.live_distributable;
  const workloads = Object.keys(reactivity.matrix[0]?.workloads_ns_per_iteration ?? {});
  const matrixRows = reactivity.matrix.map((framework) => `
    <tr class="${framework.name === "HTML Next" ? "highlight" : ""}">
      <td>${framework.rank}</td>
      <th scope="row">${escapeHtml(framework.name)}</th>
      <td>${formatNumber(framework.score, 3)}×</td>
      ${workloads.map((workload) => `<td>${formatNumber(framework.workloads_ns_per_iteration[workload]!)}</td>`).join("")}
    </tr>`).join("");
  const subsystemRows = Object.entries(live.subsystemInventory.subsystemBytes)
    .sort((left, right) => right[1] - left[1])
    .map(([name, bytes]) => `<tr><th scope="row">${escapeHtml(words(name))}</th><td>${formatBytes(bytes)}</td><td>${formatNumber(bytes / live.bundle.bytes * 100, 1)}%</td></tr>`)
    .join("");
  const moduleRows = Object.entries(live.moduleBytes)
    .sort((left, right) => right[1] - left[1])
    .map(([name, bytes]) => `<tr><th scope="row"><code>${escapeHtml(name.replace("packages/declarative-components/src/", "src/"))}</code></th><td>${formatBytes(bytes)}</td><td>${formatNumber(bytes / live.bundle.bytes * 100, 1)}%</td></tr>`)
    .join("");
  const fixtureRows = Object.entries(runtime.native_build.capabilityFixtures)
    .map(([name, fixture]) => `<tr><th scope="row">${escapeHtml(words(name))}</th><td>${formatBytes(fixture.bytes)}</td><td>${formatBytes(fixture.gzip)}</td><td>${fixture.fullRuntimeModules}</td><td>${fixture.parserModules}</td><td>${fixture.targetGzip === null ? "—" : formatBytes(fixture.targetGzip)}</td><td>${fixture.targetMet ? "Yes" : "No"}</td></tr>`)
    .join("");
  const excludedRows = reactivity.excluded.length === 0
    ? '<tr><td colspan="2">None</td></tr>'
    : reactivity.excluded.map(({ name, reason }) => `<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(reason)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HTML Next performance report</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e8ecf6; }
    body { margin: 0; padding: 2rem; }
    main { max-width: 1500px; margin: 0 auto; }
    h1 { margin-bottom: .35rem; font-size: clamp(2rem, 5vw, 4rem); letter-spacing: -.04em; }
    h2 { margin-top: 2.5rem; }
    p { color: #acb7d0; line-height: 1.55; max-width: 80ch; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; margin: 2rem 0; }
    .card { padding: 1rem 1.2rem; border: 1px solid #263452; border-radius: 14px; background: #111a2e; }
    .card span { display: block; color: #91a0be; font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; }
    .card strong { display: block; margin-top: .35rem; font-size: 1.8rem; }
    .table-wrap { overflow-x: auto; border: 1px solid #263452; border-radius: 14px; }
    table { width: 100%; border-collapse: collapse; background: #111a2e; font-variant-numeric: tabular-nums; }
    th, td { padding: .7rem .85rem; border-bottom: 1px solid #263452; text-align: right; white-space: nowrap; }
    th[scope="row"] { text-align: left; }
    thead th { position: sticky; top: 0; background: #18233c; color: #bdc7dc; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
    tbody tr:last-child > * { border-bottom: 0; }
    .highlight > * { background: #173d39; color: #d9fff7; font-weight: 700; }
    code { color: #c9d5ff; }
    .meta { color: #7483a4; font-size: .85rem; }
  </style>
</head>
<body>
<main>
  <h1>Performance report</h1>
  <p>The reported rank is HTML Next’s overall position after normalizing each of six workloads against the fastest implementation for that workload, then taking their geometric mean. A score of 1.000× would mean fastest in every workload.</p>
  <div class="cards">
    <div class="card"><span>Reactive rank</span><strong>${reactivity.html_next_matrix_rank} of ${reactivity.matrix_ranked_count}</strong></div>
    <div class="card"><span>Normalized score</span><strong>${formatNumber(reactivity.html_next_matrix_score, 3)}×</strong></div>
    <div class="card"><span>Live minified</span><strong>${formatBytes(live.bundle.bytes)} B</strong></div>
    <div class="card"><span>Live gzip</span><strong>${formatBytes(live.bundle.gzip)} B</strong></div>
  </div>

  <h2>Reactive framework matrix</h2>
  <p>Workload cells are nanoseconds per benchmark iteration; lower is better. Each framework is measured through its direct signal, computed, and effect primitives. The score is relative to the best result in each column, so it summarizes balanced performance rather than rewarding one unusually fast workload.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Rank</th><th>Framework</th><th>Score</th>${workloads.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead>
    <tbody>${matrixRows}</tbody>
  </table></div>

  <h2>What each reactive workload measures</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Workload</th><th>Measured operation</th></tr></thead>
    <tbody>${workloads.map((name) => `<tr><th scope="row"><code>${escapeHtml(name)}</code></th><td>${escapeHtml(workloadDescriptions[name] ?? "")}</td></tr>`).join("")}</tbody>
  </table></div>

  <h2>Live runtime by subsystem</h2>
  <div class="table-wrap"><table><thead><tr><th>Subsystem</th><th>Minified bytes</th><th>Share</th></tr></thead><tbody>${subsystemRows}</tbody></table></div>

  <h2>Live runtime by module</h2>
  <div class="table-wrap"><table><thead><tr><th>Module</th><th>Minified bytes</th><th>Share</th></tr></thead><tbody>${moduleRows}</tbody></table></div>

  <h2>Generated capability fixtures</h2>
  <div class="table-wrap"><table><thead><tr><th>Fixture</th><th>Minified bytes</th><th>Gzip bytes</th><th>Full runtime modules</th><th>Parser modules</th><th>Gzip target</th><th>Target met</th></tr></thead><tbody>${fixtureRows}</tbody></table></div>

  <h2>Excluded implementations</h2>
  <div class="table-wrap"><table><thead><tr><th>Framework</th><th>Reason</th></tr></thead><tbody>${excludedRows}</tbody></table></div>

  <h2>Measurement details</h2>
  <div class="table-wrap"><table><tbody>
    <tr><th scope="row">Revision</th><td><code>${escapeHtml(reactivity.matrix_revision)}</code>${reactivity.matrix_revision_dirty === 1 ? " (dirty)" : ""}</td></tr>
    <tr><th scope="row">Node / platform</th><td>${escapeHtml(reactivity.matrix_node_version)} · ${escapeHtml(reactivity.matrix_platform)}</td></tr>
    <tr><th scope="row">Process samples per framework</th><td>${reactivity.matrix_process_samples_per_framework}</td></tr>
    <tr><th scope="row">HTML Next A/A score spread</th><td>${formatNumber(reactivity.matrix_aa_score_relative_spread * 100, 2)}%</td></tr>
    <tr><th scope="row">Maximum A/A workload spread</th><td>${formatNumber(reactivity.matrix_aa_max_relative_spread * 100, 2)}%</td></tr>
    <tr><th scope="row">Complete live capability profile</th><td>${live.capabilityProfile.complete ? "Yes" : "No"}</td></tr>
    <tr><th scope="row">Unclassified live modules</th><td>${live.subsystemInventory.unclassifiedModules.length}</td></tr>
    <tr><th scope="row">Forbidden parse5 / generated DOM modules</th><td>${live.forbiddenServerModules.parse5} / ${live.forbiddenServerModules.generatedDomPropertyInventory}</td></tr>
  </tbody></table></div>
  <p class="meta">Generated ${escapeHtml(new Date().toISOString())}. This file is self-contained and makes no network requests.</p>
</main>
</body>
</html>`;
}

const runtime = measure<RuntimeReport>("measure-runtime-size.ts");
const reactivity = measure<ReactivityReport>("measure-reactivity-matrix.ts");
const live = runtime.live_distributable;
const performanceChecksPass = Number(
  reactivity.matrix_checks_pass === 1 &&
  live.capabilityProfile.complete &&
  live.capabilityProfile.missingModules.length === 0 &&
  live.subsystemInventory.unclassifiedModules.length === 0 &&
  live.forbiddenServerModules.parse5 === 0 &&
  live.forbiddenServerModules.generatedDomPropertyInventory === 0,
);
const report = {
  performance_checks_pass: performanceChecksPass,
  live_distributable_bytes: live.bundle.bytes,
  live_distributable_gzip: live.bundle.gzip,
  html_next_matrix_rank: reactivity.html_next_matrix_rank,
  html_next_matrix_score: reactivity.html_next_matrix_score,
  matrix_aa_score_relative_spread: reactivity.matrix_aa_score_relative_spread,
  matrix_aa_max_relative_spread: reactivity.matrix_aa_max_relative_spread,
  matrix_ranked_count: reactivity.matrix_ranked_count,
  matrix_excluded_count: reactivity.matrix_excluded_count,
  runtime_report: runtime,
  reactivity_report: reactivity,
};

const htmlArgument = process.argv.find((argument) => argument === "--html" || argument.startsWith("--html="));
if (htmlArgument !== undefined) {
  const requestedPath = htmlArgument.includes("=") ? htmlArgument.slice(htmlArgument.indexOf("=") + 1) : ".context/performance-report.html";
  const htmlPath = resolve(repositoryRoot, requestedPath);
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, renderReport(runtime, reactivity));
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (performanceChecksPass !== 1) process.exitCode = 1;
