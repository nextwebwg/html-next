/**
 * The cost of updating content projected into slots, in the live runtime and compiled output, against
 * a base revision (`--base=<ref>`, origin/main by default). Each scenario toggles `$if` content in many
 * component instances: content for a named slot with fallback (which switches between the two), content
 * for the default slot, the named scenario's DOM work as two default-slot `$if`s, and, as a control,
 * a `$if` outside any component. Each sample is a fresh page;
 * base and candidate alternate. The base revision's sources are extracted under the ignored
 * `.benchmark/slot-updates/` directory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const work = fileURLToPath(new URL("../.benchmark/slot-updates/", import.meta.url));
const base = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7) ?? "origin/main";
const revision = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const rows = 200;
const toggles = 40;
const samples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.slice(10) ?? 7);
// `--only=compiled:named,live:plain` measures just those target and scenario pairs.
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");

const row = `<template component="bench-row"><div><span class="meta"><slot name="meta">No meta</slot></span><span class="body"><slot></slot></span></div></template>`;
const list = (content: string): string => `<template component="bench-list"><defs>
  <state name="open" type="boolean" value="false"></state>
  <state name="rows" type="list(number)" value="[${Array.from({ length: rows }, (_, index) => index).join(", ")}]"></state>
  </defs><section>${content}</section></template>`;
const scenarios = {
  named: list(`<bench-row $each="row of $rows"><b slot="meta" $if="$open">Open</b></bench-row>`),
  default: list(`<bench-row $each="row of $rows"><b $if="$open">Open</b></bench-row>`),
  // The named scenario's DOM work, written as two default-slot `$if`s: its reference cost.
  pair: list(`<bench-row $each="row of $rows"><b $if="$open">Open</b><i $if="not $open">No meta</i></bench-row>`),
  plain: list(`<p $each="row of $rows"><b $if="$open">Open</b></p>`),
} as const;
type Scenario = keyof typeof scenarios;

/** The live runtime and each scenario's compiled modules, built from one source tree. */
async function bundles(source: string, label: string): Promise<{ live: string; compiled: Record<Scenario, string> }> {
  const out = join(work, label);
  mkdirSync(out, { recursive: true });
  const live = join(out, "live.js");
  await build({ entryPoints: [join(source, "live.ts")], outfile: live, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  const { parseComponent } = await import(join(source, "source-parser.ts")) as typeof import("../src/source-parser.js");
  const { generateComponent } = await import(join(source, "generate.ts")) as typeof import("../src/generate.js");
  const compiled = {} as Record<Scenario, string>;
  for (const scenario of Object.keys(scenarios) as Scenario[]) {
    const definitions = [row, scenarios[scenario]].map((text) => parseComponent(text));
    const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
    const modules = new Map(definitions.map((definition) => [`./${definition.contract.name}.js`,
      generateComponent(definition, { invocations }).find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!.content]));
    compiled[scenario] = join(out, `${scenario}.js`);
    await build({
      stdin: { contents: `import { createBenchList } from "./BenchList.js"; import { generatedHost } from "@nextwebwg/html-next/generated-runtime";
const element = createBenchList(); document.querySelector("main").append(element);
window.benchToggle = () => { const state = generatedHost(element).state; state.open = !state.open; };`, loader: "js", resolveDir: source },
      outfile: compiled[scenario], bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      define: { "import.meta.url": "document.baseURI" },
      alias: { "@nextwebwg/html-next/generated-runtime": join(source, "generated-runtime.ts") },
      plugins: [{ name: "generated", setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
        builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
        builder.onResolve({ filter: /^\.\/\w+\.js$/ }, (args) => modules.has(args.path) ? { path: args.path, namespace: "generated" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "generated" }, (args) => ({ contents: modules.get(args.path)!, loader: "js", resolveDir: source }));
      } }],
    });
  }
  return { live, compiled };
}

/** Milliseconds per toggle, each awaited until its DOM work and observers have run. */
async function sample(browser: Browser, target: "live" | "compiled", scenario: Scenario, built: Awaited<ReturnType<typeof bundles>>): Promise<number> {
  const page = await browser.newPage();
  try {
    if (target === "live") {
      await page.setContent(`${row}${scenarios[scenario]}<main><bench-list id="subject"></bench-list></main>`);
      await page.addScriptTag({ path: built.live });
      await page.evaluate(`(() => {
        HtmlRuntime.lowerDocument();
        const element = document.querySelector("main > *");
        window.benchToggle = () => { const state = HtmlRuntime.getComponentHost(element).state; state.open = !state.open; };
      })()`);
    } else {
      await page.setContent("<main></main>");
      await page.addScriptTag({ path: built.compiled[scenario] });
    }
    // A string, so the page runs it as written (tsx's helpers do not exist there).
    return await page.evaluate(`(async () => {
      const settle = () => new Promise((done) => { const channel = new MessageChannel(); channel.port1.onmessage = () => done(); channel.port2.postMessage(0); });
      for (let index = 0; index < 4; index += 1) { window.benchToggle(); await settle(); }
      const started = performance.now();
      for (let index = 0; index < ${toggles}; index += 1) { window.benchToggle(); await settle(); }
      return (performance.now() - started) / ${toggles};
    })()`) as number;
  } finally {
    await page.close();
  }
}

/**
 * `--profile=compiled:named` prints the candidate's heaviest functions by self time over many toggles
 * of that pair, from a Chromium CPU profile, to find where a regression's time goes.
 */
async function profile(browser: Browser, target: "live" | "compiled", scenario: Scenario, built: Awaited<ReturnType<typeof bundles>>): Promise<void> {
  const page = await browser.newPage();
  if (target === "live") {
    await page.setContent(`${row}${scenarios[scenario]}<main><bench-list id="subject"></bench-list></main>`);
    await page.addScriptTag({ path: built.live });
    await page.evaluate(`(() => { HtmlRuntime.lowerDocument(); const element = document.querySelector("main > *");
      window.benchToggle = () => { const state = HtmlRuntime.getComponentHost(element).state; state.open = !state.open; }; })()`);
  } else {
    await page.setContent("<main></main>");
    await page.addScriptTag({ path: built.compiled[scenario] });
  }
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 50 });
  await session.send("Profiler.start");
  await page.evaluate(`(async () => { const settle = () => new Promise((done) => { const c = new MessageChannel(); c.port1.onmessage = () => done(); c.port2.postMessage(0); });
    for (let index = 0; index < 1000; index += 1) { window.benchToggle(); await settle(); } })()`);
  const { profile: result } = await session.send("Profiler.stop") as { profile: { nodes: { id: number; callFrame: { functionName: string; lineNumber: number; url: string } }[]; samples: number[]; timeDeltas: number[] } };
  const self = new Map<string, number>();
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  result.samples.forEach((id, index) => {
    const frame = byId.get(id)!.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (result.timeDeltas[index] ?? 0));
  });
  const total = [...self.values()].reduce((sum, value) => sum + value, 0);
  for (const [key, time] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) process.stdout.write(`${(100 * time / total).toFixed(1).padStart(5)}%  ${key}\n`);
  await page.close();
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

rmSync(work, { recursive: true, force: true });
const baseline = join(work, "baseline");
mkdirSync(baseline, { recursive: true });
execFileSync("tar", ["-xf", "-", "-C", baseline], { input: execFileSync("git", ["archive", revision, "packages/html-next/src"], { cwd: root, maxBuffer: 20 * 1024 * 1024 }) });
const built = {
  base: await bundles(join(baseline, "packages/html-next/src"), "base"),
  candidate: await bundles(fileURLToPath(new URL("../src/", import.meta.url)), "candidate"),
};
const browser = await chromium.launch({ headless: true });
const profiled = process.argv.find((arg) => arg.startsWith("--profile="))?.slice(10).split(":") as ["live" | "compiled", Scenario] | undefined;
if (profiled !== undefined) {
  for (const side of ["base", "candidate"] as const) {
    process.stdout.write(`${side}\n`);
    await profile(browser, profiled[0], profiled[1], built[side]);
  }
  await browser.close();
  process.exit(0);
}
const results: Record<string, { base: number; candidate: number; ratio: number }> = {};
try {
  for (const target of ["live", "compiled"] as const) {
    for (const scenario of Object.keys(scenarios) as Scenario[]) {
      if (only !== undefined && !only.includes(`${target}:${scenario}`)) continue;
      const times = { base: [] as number[], candidate: [] as number[] };
      for (let round = 0; round < samples; round += 1) {
        // Alternate which goes first, so neither always gets the warmer process.
        for (const side of round % 2 === 0 ? ["base", "candidate"] as const : ["candidate", "base"] as const) {
          times[side].push(await sample(browser, target, scenario, built[side]));
        }
      }
      const [before, after] = [median(times.base), median(times.candidate)];
      results[`${target} ${scenario}`] = { base: Number(before.toFixed(3)), candidate: Number(after.toFixed(3)), ratio: Number((after / before).toFixed(3)) };
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(`${JSON.stringify({ base: revision, rows, toggles, samples, msPerToggle: results }, null, 2)}\n`);
