/**
 * Keyed rendering comparison on the pinned js-framework-benchmark fork; see docs/framework-benchmark.md.
 * Subcommands: setup [--force] | measure | compare (the verify:frameworks gate) | smoke.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { cpus, platform, release, type as osType } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type BuildOptions } from "esbuild";
import { chromium, type Browser } from "playwright";
import { parseComponent } from "../src/source-parser.js";
import { generateVanilla } from "../src/targets/vanilla.js";
import {
  IDS, assessComparison, collectMedians, compareSweep, entryName, summarize,
  type Medians, type ResultFile, type SweepComparison, type WorkloadId,
} from "./framework-benchmark-score.js";

const REPOSITORY = "https://github.com/nextwebwg/js-framework-benchmark";
const PIN = "f566154cc9a70400ca99024f32793f1e25a9eed8";
/** Control lockfiles at the pin; setup refuses a checkout whose dependencies differ. */
const LOCKFILES = {
  "react-hooks": "bee80a1ff6b695518e5f19961a408c9a6b8cbafa78143a9dc6d4252b4003bb62",
  vue: "7b04dd5631706be5c254647a2c4fe6aee7b8c9c359edaa44422cb3e44b7fdb82",
  svelte: "26f8c3a37e22b9c561f14944a4d5f797a235d4c57fc6dc4dfd8547569573613a",
  solid: "50878ee6d9d788bd5a8a7ef1cb0d61b81d1e95264ef8be0017b54311c01e75c8",
} as const;
const SPARSE = ["webdriver-ts", "server", "css", ...["html-next", "vanillajs", ...Object.keys(LOCKFILES)].map((name) => `frameworks/keyed/${name}`)];
const STEPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly string[]>]> = [
  ["webdriver-ts", [["ci", "--no-audit", "--no-fund"], ["run", "compile"]]],
  ["server", [["ci", "--no-audit", "--no-fund"]]],
  ...Object.keys(LOCKFILES).map((name) => [`frameworks/keyed/${name}`, [["ci", "--no-audit", "--no-fund"], ["run", "build-prod"]]] as const),
];
// ponytail: the pinned runner and server both hard-code this port, so it is not an option.
const PORT = 8080;
const LIVE = "html-next-live-candidate";
const COMPILED = "html-next-compiled-candidate";
const REFERENCE = "html-next-live-reference";
/** Neutral, equal-length entry names for the paired gate; the candidate alternates between them. */
const SLOTS = ["html-next-live-a", "html-next-live-b"] as const;
const DEFAULT_FRAMEWORKS = [LIVE, COMPILED, "vanillajs", "vue", "react-hooks", "svelte", "solid"];

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(packageRoot, "../..");
const src = join(packageRoot, "src");
const benchmarkRoot = join(packageRoot, ".benchmark");
const work = join(benchmarkRoot, "js-framework-benchmark");
const keyed = join(work, "frameworks/keyed");
const version = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

const [command = "", ...rest] = process.argv.slice(2);
const allowed: Record<string, readonly string[]> = {
  setup: ["force"],
  measure: ["frameworks", "benchmarks", "count", "reference", "record"],
  compare: ["base", "count", "output"],
  smoke: ["removals"],
};
if (allowed[command] === undefined) throw new Error(`Usage: framework-benchmark.ts ${Object.keys(allowed).join("|")} [options]`);
// Accepts `--name=value` and space-separated lists such as `--benchmarks 01_ 09_`.
const options = new Map<string, string[]>();
let current: string[] | undefined;
for (const arg of rest) {
  const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
  if (arg === "--") continue;
  if (match === null) {
    if (current === undefined) throw new Error(`Unexpected argument ${arg}.`);
    current.push(arg);
    continue;
  }
  if (!allowed[command]!.includes(match[1]!)) throw new Error(`Unknown option --${match[1]} for ${command}.`);
  options.set(match[1]!, current = match[2] === undefined ? [] : [match[2]]);
}
const one = (name: string): string | undefined => options.get(name)?.[0];
const count = options.has("count") ? Number(one("count")) : undefined;
if (count !== undefined && !(Number.isInteger(count) && count > 0)) throw new Error("--count must be a positive integer.");

const git = (args: readonly string[], cwd = root): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const stamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const marker = (directory: string): string => join(work, directory, ".html-next-setup");

function run(file: string, args: readonly string[], cwd: string): void {
  console.error(`$ ${file} ${args.join(" ")}   [${cwd}]`);
  if (spawnSync(file, args, { cwd, stdio: "inherit" }).status !== 0) throw new Error(`${file} ${args.join(" ")} failed in ${cwd}.`);
}

function setup(force: boolean): void {
  const started = performance.now();
  mkdirSync(work, { recursive: true });
  if (!existsSync(join(work, ".git"))) {
    git(["init", "--quiet"], work);
    git(["remote", "add", "origin", REPOSITORY], work);
  }
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: work, encoding: "utf8" }).stdout.trim();
  if (force || head !== PIN) run("git", ["fetch", "--depth=1", "--filter=blob:none", "origin", PIN], work);
  git(["sparse-checkout", "set", ...SPARSE], work);
  if (force || head !== PIN) run("git", ["-c", "advice.detachedHead=false", "checkout", "--force", "--detach", PIN], work);
  verifyCheckout();
  // ponytail: the server lists keyed and non-keyed directories; the sparse checkout needs only keyed entries.
  mkdirSync(join(work, "frameworks/non-keyed"), { recursive: true });
  for (const [directory, commands] of STEPS) {
    if (!force && existsSync(marker(directory)) && readFileSync(marker(directory), "utf8") === PIN) {
      console.error(`${directory}: already set up for ${PIN.slice(0, 12)}`);
      continue;
    }
    for (const args of commands) run("npm", args, join(work, directory));
    writeFileSync(marker(directory), PIN);
  }
  console.error(`Setup finished in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
}

/** The pin, no edited tracked files (setup markers, builds and entries are untracked) and the control lockfiles. */
function verifyCheckout(): void {
  const repair = "run `pnpm setup:frameworks --force` to restore it";
  assert.equal(git(["rev-parse", "HEAD"], work), PIN, `Benchmark checkout is not at the pinned revision; ${repair}.`);
  const modified = git(["status", "--porcelain", "--untracked-files=no"], work);
  assert.equal(modified, "", `Benchmark checkout has modified tracked files; ${repair}.\n${modified}`);
  for (const [name, expected] of Object.entries(LOCKFILES)) {
    assert.equal(sha256(readFileSync(join(keyed, name, "package-lock.json"))), expected, `${name}/package-lock.json differs from the pin.`);
  }
}

async function assertPortFree(): Promise<void> {
  if (await portInUse()) {
    throw new Error(`Port ${PORT} is already in use. The pinned runner only connects to localhost:${PORT}; stop the other server first.`);
  }
}

/** Runs before any entry is rebuilt, so a refused run never touches directories a concurrent runner is loading. */
async function preflight(): Promise<void> {
  if (STEPS.some(([directory]) => !existsSync(marker(directory)) || readFileSync(marker(directory), "utf8") !== PIN)) {
    throw new Error("The benchmark checkout is not set up; run `pnpm setup:frameworks` first.");
  }
  verifyCheckout();
  const active = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => /[bB]enchmarkRunner/.test(line));
  if (active.length > 0) throw new Error(`Another js-framework-benchmark runner is active; measurements must be serial.\n${active.join("\n")}`);
  await assertPortFree();
}

function chromeBinary(): string {
  const path = chromium.executablePath();
  if (!existsSync(path)) throw new Error("Chromium is missing; run `pnpm --filter @nextwebwg/html-next exec playwright install chromium`.");
  return path;
}

async function environment() {
  const browser = await chromium.launch({ executablePath: chromeBinary() });
  const chrome = browser.version();
  await browser.close();
  return {
    chrome,
    cpu: cpus()[0]?.model ?? "unknown",
    os: platform() === "darwin" ? `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}` : `${osType()} ${release()}`,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    // Asserted against the checkout by verifyCheckout() in preflight().
    benchmark: { repository: REPOSITORY, revision: PIN, lockfileSha256: LOCKFILES },
    htmlNext: { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "" },
  };
}

interface Bundle { readonly sha256: string; readonly raw: number; readonly gzip: number; readonly revision?: string }
const bundleOptions = {
  bundle: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "none", minify: true,
} as const satisfies BuildOptions;

/** Writes one entry next to the fork's own html-next entry, from the same authored component and controller. */
async function buildEntry(name: string, mode: "live" | "compiled", source = src): Promise<Bundle> {
  const authored = join(keyed, "html-next");
  const destination = join(keyed, name);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination);
  for (const file of ["benchmark-app.html", "controller.js", "package-lock.json", ...(mode === "live" ? ["index.html", "bootstrap.js"] : [])]) {
    copyFileSync(join(authored, file), join(destination, file));
  }
  let output = join(destination, "browser-loader.bundle.js");
  if (mode === "live") {
    await build({ ...bundleOptions, entryPoints: [join(source, "browser.ts")], outfile: output });
  } else {
    const definition = parseComponent(readFileSync(join(authored, "benchmark-app.html"), "utf8"), join(destination, "benchmark-app.html"));
    const generated = generateVanilla({ ...definition, controller: join(destination, "controller.js") }, version, true);
    mkdirSync(join(destination, "vanilla"));
    mkdirSync(join(destination, "styles"));
    writeFileSync(join(destination, "vanilla/BenchmarkApp.js"), generated.module);
    writeFileSync(join(destination, "styles/benchmark-app.css"), "");
    writeFileSync(join(destination, "mount.js"), 'import { createBenchmarkApp } from "./vanilla/BenchmarkApp.js"; document.body.append(createBenchmarkApp());\n');
    output = join(destination, "app.js");
    await build({
      ...bundleOptions, entryPoints: [join(destination, "mount.js")], outfile: output,
      alias: {
        "@nextwebwg/html-next/runtime": join(source, "runtime.ts"),
        "@nextwebwg/html-next/generated-runtime": join(source, "generated-runtime.ts"),
      },
    });
    writeFileSync(join(destination, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HTML Next compiled native keyed</title><link href="/css/currentStyle.css" rel="stylesheet"></head><body><script type="module" src="./app.js"></script></body></html>\n');
  }
  const bytes = readFileSync(output);
  const bundle = { sha256: sha256(bytes), raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
  const metadata = JSON.parse(readFileSync(join(authored, "package.json"), "utf8")) as { name: string; "js-framework-benchmark": { frameworkVersion: string } };
  metadata.name = `js-framework-benchmark-${name}`;
  metadata["js-framework-benchmark"].frameworkVersion = `${version}+${bundle.sha256.slice(0, 12)}`;
  writeFileSync(join(destination, "package.json"), json(metadata));
  return bundle;
}

/** Another revision's `packages/html-next/src`, extracted for building its live entry. */
function extractRevision(ref: string): { readonly revision: string; readonly source: string } {
  const revision = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const directory = join(benchmarkRoot, "reference");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const archive = execFileSync("git", ["archive", revision, "packages/html-next/src"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
  return { revision, source: join(directory, "packages/html-next/src") };
}

const portInUse = (): Promise<boolean> => new Promise((done) => {
  const socket = connect(PORT, "localhost");
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
});

/** Runs a task against the fork's own server for this checkout, started here and always stopped. */
async function withServer<T>(directory: string, task: () => Promise<T> | T): Promise<T> {
  await assertPortFree();
  const log = join(directory, "server.log");
  const fd = openSync(log, "w");
  // File descriptors, not pipes: a synchronous runner must never stall the server on a full pipe.
  const server = spawn(process.execPath, ["--import", "tsx", "index.ts"], { cwd: join(work, "server"), stdio: ["ignore", fd, fd] });
  closeSync(fd);
  try {
    for (let waited = 0; !readFileSync(log, "utf8").includes(`Server running on port ${PORT}`); waited += 100) {
      if (server.exitCode !== null || waited > 60_000) throw new Error(`The benchmark server did not start; see ${log}.`);
      await delay(100);
    }
    return await task();
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
  }
}

/** One serial invocation of the unchanged upstream runner, with results and traces in `directory`. */
function runSweep(directory: string, frameworks: readonly string[], ids: readonly WorkloadId[]): Medians {
  mkdirSync(directory, { recursive: true });
  symlinkSync(join(work, "webdriver-ts/dist"), join(directory, "dist"), "dir");
  const args = [
    "dist/benchmarkRunner.js", "--framework", ...frameworks.map((name) => `keyed/${name}`), "--benchmark", ...ids,
    "--headless", "--chromeBinary", chromeBinary(), ...(count === undefined ? [] : ["--count", String(count)]),
  ];
  writeFileSync(join(directory, "command.json"), json({ command: [process.execPath, ...args], cwd: directory }));
  const log = join(directory, "runner.log");
  console.error(`Running serial benchmark; log: ${log}`);
  const fd = openSync(log, "w");
  const { status } = spawnSync(process.execPath, args, { cwd: directory, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const output = readFileSync(log, "utf8");
  if (status !== 0 || !output.includes("\nsuccessful run\n") || output.includes("The following benchmarks failed:")) {
    throw new Error(`The benchmark runner failed (exit ${status}); see ${log}.`);
  }
  const results = join(directory, "results");
  const files = readdirSync(results).filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(results, file), "utf8")) as ResultFile);
  const medians = collectMedians(files, count ?? 15, ids);
  for (const name of frameworks) if (entryName(medians, name) === undefined) throw new Error(`No results for ${name}.`);
  return medians;
}

async function measure(): Promise<void> {
  await preflight();
  const reference = one("reference");
  const frameworks = options.get("frameworks")?.length ? options.get("frameworks")! : [...DEFAULT_FRAMEWORKS];
  if (reference !== undefined && !frameworks.includes(REFERENCE)) frameworks.push(REFERENCE);
  if (reference === undefined && frameworks.includes(REFERENCE)) throw new Error(`Pass --reference=<git ref> to measure ${REFERENCE}.`);
  const prefixes = options.get("benchmarks") ?? [];
  for (const prefix of prefixes) if (!IDS.some((id) => id.includes(prefix))) throw new Error(`No workload matches ${prefix}.`);
  const ids = prefixes.length === 0 ? [...IDS] : IDS.filter((id) => prefixes.some((prefix) => id.includes(prefix)));
  const bundles: Record<string, Bundle> = {};
  for (const name of frameworks) {
    if (name === LIVE) bundles[name] = await buildEntry(name, "live");
    if (name === COMPILED) bundles[name] = await buildEntry(name, "compiled");
    if (name === REFERENCE) {
      const { revision, source } = extractRevision(reference!);
      bundles[name] = { ...(await buildEntry(name, "live", source)), revision };
    }
  }
  const measuredAt = stamp();
  const directory = join(benchmarkRoot, "runs", measuredAt);
  mkdirSync(directory, { recursive: true });
  const env = await environment();
  const medians = await withServer(directory, () => runSweep(directory, frameworks, ids));
  const standard = (count ?? 15) === 15;
  // Scores are relative to the fastest entry per workload, so a full run needs the whole default field.
  const full = standard && ids.length === IDS.length && DEFAULT_FRAMEWORKS.every((name) => frameworks.includes(name));
  const summary = {
    complete: true, runner_success: true, standard_samples: standard, cpu_samples: count ?? 15,
    protocol: full ? "full_standard" : "reduced",
    measuredAt, frameworks, benchmarks: ids, environment: env, bundles,
    live_gzip_bytes: bundles[LIVE]?.gzip, compiled_gzip_bytes: bundles[COMPILED]?.gzip,
    ...summarize(medians),
  };
  writeFileSync(join(directory, "summary.json"), json(summary));
  if (options.has("record")) {
    const ledger = join(packageRoot, "benchmarks/framework-results");
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, `${measuredAt}-${env.htmlNext.commit.slice(0, 7)}.json`), json(summary));
  }
  process.stdout.write(json({ ...summary, runDirectory: directory }));
}

async function compare(): Promise<void> {
  await preflight();
  const base = extractRevision(one("base") ?? "origin/main");
  const [first, second] = SLOTS;
  const bundles = { candidate: await buildEntry(first, "live"), reference: { ...(await buildEntry(second, "live", base.source)), revision: base.revision } };
  const directory = join(benchmarkRoot, "runs", `${stamp()}-compare`);
  mkdirSync(directory, { recursive: true });
  const env = await environment();
  const sweeps: Array<SweepComparison & { readonly directory: string; readonly candidateEntry: string; readonly medians: Medians }> = [];
  // Identical bytes cannot regress; skip the browser sweeps.
  const identical = bundles.candidate.sha256 === bundles.reference.sha256;
  if (!identical) await withServer(directory, async () => {
    // Two sweeps, plus one bounded extra sweep only when they disagree; a regression is never retried.
    while (sweeps.length < 2 || (sweeps.length < 3 && assessComparison(sweeps).status === "inconclusive")) {
      // The runner orders entries by directory listing, so alternate which slot holds the candidate.
      const [candidate, other] = sweeps.length % 2 === 0 ? [first, second] : [second, first];
      if (sweeps.length > 0) {
        await buildEntry(candidate, "live");
        await buildEntry(other, "live", base.source);
      }
      const sweep = join(directory, `sweep-${sweeps.length + 1}`);
      const medians = runSweep(sweep, SLOTS, IDS);
      sweeps.push({
        directory: sweep, candidateEntry: candidate, medians,
        ...compareSweep(medians[entryName(medians, candidate)!]!, medians[entryName(medians, other)!]!),
      });
    }
  });
  const assessment = identical ? undefined : assessComparison(sweeps);
  const report = {
    status: assessment?.status ?? "pass", identicalBundles: identical,
    baselineRevision: base.revision, candidateRevision: env.htmlNext.commit, candidateDirty: env.htmlNext.dirty,
    measuredAt: new Date().toISOString(), protocol: (count ?? 15) === 15 ? "full_standard" : "reduced", cpuSamples: count ?? 15,
    environment: env, bundles, assessment, sweeps,
  };
  const output = one("output");
  if (output !== undefined) writeFileSync(resolve(root, output), json(report));
  writeFileSync(join(directory, "report.json"), json(report));
  process.stdout.write(json(report));
  // Inconclusive data fails too; it needs a quieter rerun, not a claim of no regression.
  if (report.status !== "pass") process.exitCode = 1;
}

/** Functional check of both candidate entries: keyed identity, events, reconnect, cleanup, no warnings. */
async function smokeEntry(browser: Browser, name: string, removals: number): Promise<void> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const url = message.location().url;
    if (url && new URL(url).pathname === "/favicon.ico") return;
    if (["warning", "error"].includes(message.type())) errors.push(`${message.text()} ${url}`);
  });
  await page.goto(`http://localhost:${PORT}/frameworks/keyed/${name}/index.html`);
  const rows = page.locator("#tbody tr");
  const waitRows = (expected: number) => page.waitForFunction((n) => document.querySelectorAll("#tbody tr").length === n, expected);
  await page.locator("#run").click();
  await waitRows(1000);
  const label = await rows.first().locator("td").nth(1).textContent();
  await page.locator("#update").click();
  await page.waitForFunction((value) => document.querySelector("#tbody tr td:nth-child(2)")?.textContent === `${value} !!!`, label);
  await page.evaluate(() => {
    Reflect.set(window, "originalFirst", document.querySelector("#tbody tr"));
    Reflect.set(window, "originalSecond", document.querySelectorAll("#tbody tr")[1]);
  });
  await rows.nth(1).locator('[data-action="select"]').click();
  assert.equal(await rows.nth(1).getAttribute("class"), "danger");
  const secondId = await rows.nth(1).getAttribute("data-id");
  const lastId = await rows.nth(998).getAttribute("data-id");
  await page.locator("#swaprows").click();
  assert.equal(await rows.nth(1).getAttribute("data-id"), lastId);
  assert.equal(await rows.nth(998).getAttribute("data-id"), secondId);
  assert.equal(await page.evaluate(() => Reflect.get(window, "originalSecond") === document.querySelectorAll("#tbody tr")[998]), true);
  // Filtering controller-owned rows repeatedly must retain keyed DOM and reactive writes.
  for (let n = 0; n < removals; n += 1) {
    await rows.nth(10).locator('[data-action="remove"]').click();
    await waitRows(999 - n);
  }
  assert.equal(await page.evaluate(() => Reflect.get(window, "originalFirst") === document.querySelector("#tbody tr")), true);
  await page.locator("#update").click();
  await page.waitForFunction((value) => document.querySelector("#tbody tr td:nth-child(2)")?.textContent === `${value} !!! !!!`, label);
  await page.locator("#add").click();
  await waitRows(2000 - removals);
  await page.evaluate(async () => {
    const component = document.querySelector('[data-component="benchmark-app"]')!;
    component.remove();
    await new Promise((done) => setTimeout(done, 0));
    document.body.prepend(component);
    await new Promise((done) => setTimeout(done, 0));
  });
  await page.locator("#add").click();
  await waitRows(3000 - removals);
  const ids = await rows.evaluateAll((all) => all.map((row) => (row as HTMLElement).dataset["id"]));
  assert.equal(new Set(ids).size, ids.length);
  await page.locator("#clear").click();
  await waitRows(0);
  await page.locator("#runlots").click();
  await waitRows(10000);
  await page.locator("#clear").click();
  await waitRows(0);
  assert.deepEqual(errors, []);
  console.log(`PASS ${name}: create, update, select, keyed swap/filter, ${removals} removals, append, reconnect, unique IDs, clear, 10k rows; no warnings/errors`);
  await page.close();
}

async function smoke(): Promise<void> {
  const removals = Number(one("removals") ?? "20");
  if (!(Number.isInteger(removals) && removals >= 0 && removals < 990)) throw new Error("--removals must be an integer from 0 to 989.");
  await preflight();
  await buildEntry(LIVE, "live");
  await buildEntry(COMPILED, "compiled");
  const directory = join(benchmarkRoot, "runs", `${stamp()}-smoke`);
  mkdirSync(directory, { recursive: true });
  await withServer(directory, async () => {
    const browser = await chromium.launch({ executablePath: chromeBinary() });
    try {
      for (const name of [LIVE, COMPILED]) await smokeEntry(browser, name, removals);
    } finally {
      await browser.close();
    }
  });
}

if (command === "setup") setup(options.has("force"));
else if (command === "measure") await measure();
else if (command === "compare") await compare();
else await smoke();
