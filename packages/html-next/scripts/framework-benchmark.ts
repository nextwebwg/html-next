/**
 * Keyed rendering comparison on the pinned js-framework-benchmark fork; see docs/framework-benchmark.md.
 * Subcommands: setup [--force] | measure | compare (the verify:frameworks gate) | smoke.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { cpus, platform, release, type as osType } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type BuildOptions } from "esbuild";
import { chromium, type Browser } from "playwright";
import { build as viteBuild, type PluginOption } from "vite";
import {
  IDS, assessComparison, assessSize, collectMedians, combineStatus, compareSweep, entryName, summarize,
  type Medians, type ResultFile, type SweepComparison, type WorkloadId,
} from "./framework-benchmark-score.js";

const REPOSITORY = "https://github.com/nextwebwg/js-framework-benchmark";
const PIN = "1c5c091eb0dbc2316f4ad3b23658fe2be617747e";
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
/** The JavaScript each fixed entry ships, for size receipts: a file, or every `.js` file in a directory. */
const SHIPPED: Readonly<Record<string, string>> = {
  "html-next": "browser-loader.bundle.js",
  vanillajs: "src/Main.js",
  solid: "dist/main.js",
  svelte: "dist/main.js",
  vue: "dist/assets",
  "react-hooks": "dist/main.js",
};
// ponytail: the pinned runner and server both hard-code this port, so it is not an option.
const PORT = 8080;
const VITE = "html-next-vite-candidate";
const LIVE = "html-next-live-candidate";
const REFERENCE = "html-next-live-reference";
const DEFAULT_FRAMEWORKS = [VITE, LIVE, "vanillajs", "solid", "vue", "react-hooks", "svelte"];
type Mode = "vite" | "live";
const MODES: readonly Mode[] = ["vite", "live"];
/** Neutral, equal-length entry names for the paired gate; the candidate alternates between them. */
const slots = (mode: Mode): readonly [string, string] => [`html-next-${mode}-a`, `html-next-${mode}-b`];

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(packageRoot, "../..");
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
/** Each step's pinned tree id. A marker holds it, so a repin rebuilds only the directories it changed. */
const pinnedTrees = (): string[] => git(["rev-parse", ...STEPS.map(([directory]) => `${PIN}:${directory}`)], work).split("\n");
const isSetUp = (directory: string, tree: string): boolean => existsSync(marker(directory)) && readFileSync(marker(directory), "utf8") === tree;

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
  const migrating = force || head !== PIN;
  if (migrating) run("git", ["fetch", "--depth=1", "--filter=blob:none", "origin", PIN], work);
  git(["sparse-checkout", "set", ...SPARSE], work);
  if (migrating) run("git", ["-c", "advice.detachedHead=false", "checkout", "--force", "--detach", PIN], work);
  verifyCheckout();
  // Entries this tool generates are untracked and rebuilt by every command; drop any from an earlier pin or harness.
  // Only when migrating, so a no-op setup never deletes the slots a running sweep is loading.
  if (migrating) for (const name of readdirSync(keyed)) if (name.startsWith("html-next-")) rmSync(join(keyed, name), { recursive: true, force: true });
  // ponytail: the server lists keyed and non-keyed directories; the sparse checkout needs only keyed entries.
  mkdirSync(join(work, "frameworks/non-keyed"), { recursive: true });
  const trees = pinnedTrees();
  for (const [index, [directory, commands]] of STEPS.entries()) {
    if (!force && isSetUp(directory, trees[index]!)) {
      console.error(`${directory}: already set up for tree ${trees[index]!.slice(0, 12)}`);
      continue;
    }
    for (const args of commands) run("npm", args, join(work, directory));
    writeFileSync(marker(directory), trees[index]!);
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
  const missing = "The benchmark checkout is not set up for this pin; run `pnpm setup:frameworks` first.";
  if (!existsSync(join(work, ".git"))) throw new Error(missing);
  verifyCheckout();
  const trees = pinnedTrees();
  if (STEPS.some(([directory], index) => !isSetUp(directory, trees[index]!))) throw new Error(missing);
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

/** SHA-256 of the shipped JavaScript in file order, its raw bytes, and the sum of each file's gzip (level 6) bytes. */
function receipt(path: string): Bundle {
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((file) => file.endsWith(".js")).sort().map((file) => join(path, file))
    : [path];
  const contents = files.map((file) => readFileSync(file));
  return {
    sha256: sha256(Buffer.concat(contents)),
    raw: contents.reduce((total, bytes) => total + bytes.byteLength, 0),
    gzip: contents.reduce((total, bytes) => total + gzipSync(bytes).byteLength, 0),
  };
}

type HtmlNextVite = (options: { readonly entries: readonly string[] }) => PluginOption;
const plugins = new Map<string, Promise<HtmlNextVite>>();

/**
 * A tree's html-next-unplugin, bundled with that tree's `@nextwebwg/html-next` and converter sources
 * (the workspace packages export an unbuilt dist/). Other packages stay external, resolved from the
 * working tree's installs for the owning package, so an extracted revision needs no node_modules.
 */
function vitePlugin(tree: string): Promise<HtmlNextVite> {
  let loaded = plugins.get(tree);
  if (loaded !== undefined) return loaded;
  const outfile = join(benchmarkRoot, "plugins", `${plugins.size}.mjs`);
  const packages = join(tree, "packages");
  loaded = build({
    entryPoints: [join(packages, "html-next-unplugin/src/index.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "error",
    plugins: [{
      name: "html-next-sources",
      setup(bundler) {
        bundler.onResolve({ filter: /^[^./]/ }, async ({ path, importer, kind, pluginData }) => {
          if (pluginData === "external" || path.startsWith("node:")) return undefined;
          if (path === "@nextwebwg/html-next" || path === "@nextwebwg/html-next-converter") {
            return { path: join(packages, path.slice("@nextwebwg/".length), "src/index.ts") };
          }
          const owner = relative(packages, importer).split(sep)[0]!;
          const resolved = await bundler.resolve(path, { kind, resolveDir: join(root, "packages", owner), pluginData: "external" });
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path, external: true };
        });
      },
    }],
  }).then(async () => ((await import(pathToFileURL(outfile).href)) as { htmlNext: { vite: HtmlNextVite } }).htmlNext.vite);
  plugins.set(tree, loaded);
  return loaded;
}

/**
 * Writes one entry next to the fork's own html-next entry, from the same authored component and
 * controller, built from `tree` (the working tree or an extracted revision).
 */
async function buildEntry(name: string, mode: Mode, tree = root): Promise<Bundle> {
  const authored = join(keyed, "html-next");
  const destination = join(keyed, name);
  const source = join(tree, "packages/html-next/src");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination);
  for (const file of ["benchmark-app.html", "controller.js", "package-lock.json", ...(mode === "live" ? ["index.html", "bootstrap.js"] : [])]) {
    copyFileSync(join(authored, file), join(destination, file));
  }
  if (mode === "live") {
    await build({
      bundle: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "none", minify: true,
      entryPoints: [join(source, "browser.ts")], outfile: join(destination, "browser-loader.bundle.js"),
    } satisfies BuildOptions);
  } else {
    // A Vite app laid out like the fork's Vue entry: sources at its root, the production build in dist/.
    writeFileSync(join(destination, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HTML Next Vite keyed</title><link href="/css/currentStyle.css" rel="stylesheet"></head><body><script type="module" src="./main.js"></script></body></html>\n');
    writeFileSync(join(destination, "main.js"), 'import { createBenchmarkApp } from "virtual:html-next/components";\n\ndocument.body.append(createBenchmarkApp());\n');
    await viteBuild({
      root: destination, base: "./", configFile: false, logLevel: "error",
      plugins: [(await vitePlugin(tree))({ entries: ["benchmark-app.html"] })],
      resolve: {
        alias: {
          "@nextwebwg/html-next/runtime": join(source, "runtime.ts"),
          "@nextwebwg/html-next/generated-runtime": join(source, "generated-runtime.ts"),
        },
      },
      build: { target: "es2022" },
    });
  }
  const bundle = receipt(join(destination, mode === "live" ? "browser-loader.bundle.js" : "dist/assets"));
  const metadata = JSON.parse(readFileSync(join(authored, "package.json"), "utf8")) as {
    name: string; "js-framework-benchmark": { frameworkVersion: string; customURL?: string };
  };
  metadata.name = `js-framework-benchmark-${name}`;
  metadata["js-framework-benchmark"].frameworkVersion = `${version}+${bundle.sha256.slice(0, 12)}`;
  if (mode === "vite") metadata["js-framework-benchmark"].customURL = "/dist";
  writeFileSync(join(destination, "package.json"), json(metadata));
  return bundle;
}

/** Another revision's html-next, plugin and converter sources, extracted for building its entries. */
function extractRevision(ref: string): { readonly revision: string; readonly tree: string } {
  const revision = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const tree = join(benchmarkRoot, "reference");
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  const paths = ["html-next", "html-next-unplugin", "html-next-converter"].map((name) => `packages/${name}/src`);
  const archive = execFileSync("git", ["archive", revision, ...paths], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", tree], { input: archive });
  return { revision, tree };
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
    if (name === VITE) bundles[name] = await buildEntry(name, "vite");
    else if (name === LIVE) bundles[name] = await buildEntry(name, "live");
    else if (name === REFERENCE) {
      const { revision, tree } = extractRevision(reference!);
      bundles[name] = { ...(await buildEntry(name, "live", tree)), revision };
    } else if (SHIPPED[name] !== undefined) bundles[name] = receipt(join(keyed, name, SHIPPED[name]));
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
    vite_gzip_bytes: bundles[VITE]?.gzip, live_gzip_bytes: bundles[LIVE]?.gzip,
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

/** Paired gate for both modes: each sweep runs the candidate and base builds of every undecided mode. */
async function compare(): Promise<void> {
  await preflight();
  const base = extractRevision(one("base") ?? "origin/main");
  const directory = join(benchmarkRoot, "runs", `${stamp()}-compare`);
  mkdirSync(directory, { recursive: true });
  const env = await environment();
  const comparisons: Record<Mode, Array<SweepComparison & { readonly sweep: number; readonly candidateEntry: string }>> = { vite: [], live: [] };
  // The runner orders entries by directory listing, so the candidate alternates between the slots.
  const order = (mode: Mode): readonly [string, string] => {
    const [first, second] = slots(mode);
    return comparisons[mode].length % 2 === 0 ? [first, second] : [second, first];
  };
  const place = async (mode: Mode) => {
    const [candidate, other] = order(mode);
    return { candidate: await buildEntry(candidate, mode), base: { ...(await buildEntry(other, mode, base.tree)), revision: base.revision } };
  };
  const bundles = { vite: await place("vite"), live: await place("live") };
  // Identical bytes cannot regress; such a mode needs no browser sweeps.
  const identical = (mode: Mode): boolean => bundles[mode].candidate.sha256 === bundles[mode].base.sha256;
  // Two sweeps, plus one bounded extra sweep only for a mode whose two disagree; a regression is never retried.
  const pending = (): Mode[] => MODES.filter((mode) => !identical(mode) && (comparisons[mode].length < 2 ||
    (comparisons[mode].length < 3 && assessComparison(comparisons[mode]).status === "inconclusive")));
  const sweeps: Array<{ readonly directory: string; readonly frameworks: readonly string[]; readonly medians: Medians }> = [];
  if (pending().length > 0) await withServer(directory, async () => {
    for (let modes = pending(); modes.length > 0; modes = pending()) {
      for (const mode of modes) if (comparisons[mode].length > 0) await place(mode);
      const frameworks = modes.flatMap(slots);
      const sweep = join(directory, `sweep-${sweeps.length + 1}`);
      const medians = runSweep(sweep, frameworks, IDS);
      sweeps.push({ directory: sweep, frameworks, medians });
      for (const mode of modes) {
        const [candidate, other] = order(mode);
        comparisons[mode].push({
          sweep: sweeps.length, candidateEntry: candidate,
          ...compareSweep(medians[entryName(medians, candidate)!]!, medians[entryName(medians, other)!]!),
        });
      }
    }
  });
  const modes = Object.fromEntries(MODES.map((mode) => {
    const assessment = identical(mode) ? undefined : assessComparison(comparisons[mode]);
    // No bundle bloat: only the Vite-compiled entry has a size limit; the live sizes are reported.
    const size = mode === "vite" ? assessSize(bundles.vite.candidate.gzip, bundles.vite.base.gzip) : undefined;
    const status = combineStatus([assessment?.status ?? "pass", size?.status ?? "pass"]);
    return [mode, { status, identicalBundles: identical(mode), bundles: bundles[mode], size, assessment, comparisons: comparisons[mode] }];
  }));
  const report = {
    status: combineStatus(Object.values(modes).map((result) => result.status)),
    baselineRevision: base.revision, candidateRevision: env.htmlNext.commit, candidateDirty: env.htmlNext.dirty,
    measuredAt: new Date().toISOString(), protocol: (count ?? 15) === 15 ? "full_standard" : "reduced", cpuSamples: count ?? 15,
    environment: env, modes, sweeps,
  };
  const output = one("output");
  if (output !== undefined) writeFileSync(resolve(root, output), json(report));
  writeFileSync(join(directory, "report.json"), json(report));
  process.stdout.write(json(report));
  // Inconclusive data fails too; it needs a quieter rerun, not a claim of no regression.
  if (report.status !== "pass") process.exitCode = 1;
}

/**
 * Functional check of one entry: keyed identity, events, reconnect, cleanup, no warnings. Returns the
 * component's markup at each checkpoint; labels are seeded, so entries can be compared.
 */
async function smokeEntry(browser: Browser, name: string, removals: number): Promise<string[]> {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    let seed = 1;
    Math.random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const url = message.location().url;
    if (url && new URL(url).pathname === "/favicon.ico") return;
    if (["warning", "error"].includes(message.type())) errors.push(`${message.text()} ${url}`);
  });
  const metadata = JSON.parse(readFileSync(join(keyed, name, "package.json"), "utf8")) as { "js-framework-benchmark": { customURL?: string } };
  await page.goto(`http://localhost:${PORT}/frameworks/keyed/${name}${metadata["js-framework-benchmark"].customURL ?? ""}/index.html`);
  const markup: string[] = [];
  const checkpoint = async (): Promise<void> => {
    markup.push(await page.evaluate(() => document.querySelector('[data-component="benchmark-app"]')!.innerHTML));
  };
  const rows = page.locator("#tbody tr");
  const waitRows = (expected: number) => page.waitForFunction((n) => document.querySelectorAll("#tbody tr").length === n, expected);
  await page.locator("#run").click();
  await waitRows(1000);
  const label = await rows.first().locator("td").nth(1).textContent();
  await page.locator("#update").click();
  await page.waitForFunction((value) => document.querySelector("#tbody tr td:nth-child(2)")?.textContent === `${value} !!!`, label);
  await checkpoint();
  await page.evaluate(() => {
    Reflect.set(window, "originalFirst", document.querySelector("#tbody tr"));
    Reflect.set(window, "originalSecond", document.querySelectorAll("#tbody tr")[1]);
  });
  await rows.nth(1).locator('[data-action="select"]').click();
  assert.equal(await rows.nth(1).getAttribute("class"), "danger");
  await checkpoint();
  const secondId = await rows.nth(1).getAttribute("data-id");
  const lastId = await rows.nth(998).getAttribute("data-id");
  await page.locator("#swaprows").click();
  assert.equal(await rows.nth(1).getAttribute("data-id"), lastId);
  assert.equal(await rows.nth(998).getAttribute("data-id"), secondId);
  assert.equal(await page.evaluate(() => Reflect.get(window, "originalSecond") === document.querySelectorAll("#tbody tr")[998]), true);
  await checkpoint();
  // Filtering controller-owned rows repeatedly must retain keyed DOM and reactive writes.
  for (let n = 0; n < removals; n += 1) {
    await rows.nth(10).locator('[data-action="remove"]').click();
    await waitRows(999 - n);
  }
  assert.equal(await page.evaluate(() => Reflect.get(window, "originalFirst") === document.querySelector("#tbody tr")), true);
  await page.locator("#update").click();
  await page.waitForFunction((value) => document.querySelector("#tbody tr td:nth-child(2)")?.textContent === `${value} !!! !!!`, label);
  await checkpoint();
  await page.locator("#add").click();
  await waitRows(2000 - removals);
  await checkpoint();
  await page.evaluate(async () => {
    const component = document.querySelector('[data-component="benchmark-app"]')!;
    component.remove();
    await new Promise((done) => setTimeout(done, 0));
    document.body.prepend(component);
    await new Promise((done) => setTimeout(done, 0));
  });
  await page.locator("#add").click();
  await waitRows(3000 - removals);
  await checkpoint();
  const ids = await rows.evaluateAll((all) => all.map((row) => (row as HTMLElement).dataset["id"]));
  assert.equal(new Set(ids).size, ids.length);
  await page.locator("#clear").click();
  await waitRows(0);
  await checkpoint();
  await page.locator("#runlots").click();
  await waitRows(10000);
  await page.locator("#clear").click();
  await waitRows(0);
  assert.deepEqual(errors, []);
  console.log(`PASS ${name}: create, update, select, keyed swap/filter, ${removals} removals, append, reconnect, unique IDs, clear, 10k rows; no warnings/errors`);
  await page.close();
  return markup;
}

async function smoke(): Promise<void> {
  const removals = Number(one("removals") ?? "20");
  if (!(Number.isInteger(removals) && removals >= 0 && removals < 990)) throw new Error("--removals must be an integer from 0 to 989.");
  await preflight();
  await buildEntry(VITE, "vite");
  await buildEntry(LIVE, "live");
  const directory = join(benchmarkRoot, "runs", `${stamp()}-smoke`);
  mkdirSync(directory, { recursive: true });
  await withServer(directory, async () => {
    const browser = await chromium.launch({ executablePath: chromeBinary() });
    try {
      const vite = await smokeEntry(browser, VITE, removals);
      const live = await smokeEntry(browser, LIVE, removals);
      const differs = live.findIndex((markup, index) => markup !== vite[index]);
      assert.equal(differs, -1, `${VITE} and ${LIVE} render different component markup at checkpoint ${differs + 1}.`);
      console.log(`PASS ${VITE} and ${LIVE} render identical component markup at all ${live.length} checkpoints`);
    } finally {
      await browser.close();
    }
  });
}

if (command === "setup") setup(options.has("force"));
else if (command === "measure") await measure();
else if (command === "compare") await compare();
else await smoke();
