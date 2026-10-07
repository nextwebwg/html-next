/**
 * Paired Chromium measurement of the live runtime rendering a 10,000-row keyed list: time for each
 * operation and the V8 heap the rendered rows retain after garbage collection. Compares the working
 * tree against `--base=<git ref>` (default HEAD), or against `--base-src=<directory>`, a copy of
 * `packages/html-next/src`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { parseComponent } from "../src/source-parser.js";

const option = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const rounds = Number(option("rounds") ?? 7);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const definition = parseComponent(`<template component="list-memory"><defs>
  <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state>
  <state name="selected" type="number" nullable></state>
  </defs><table><tbody><tr $each="row of rows" $key="row.id" from:data-id="row.id" class:danger="row.id = selected">
  <td $value="row.id"></td><td><a $value="row.label"></a></td></tr></tbody></table></template>`);

const pageSetup = `(serialized) => {
  const runtime = window.BareRuntime;
  const root = document.querySelector("#case");
  runtime.manageComponentLifecycle(root, JSON.parse(serialized));
  const host = runtime.getComponentHost(root);
  let nextId = 1;
  const rows = (count) => Array.from({ length: count }, () => ({ id: nextId, label: "row " + nextId++ }));
  const time = async (change) => {
    const start = performance.now();
    change();
    await Promise.resolve();
    return performance.now() - start;
  };
  window.bench = {
    create: () => time(() => { host.state.rows = rows(10000); }),
    update: () => time(() => { const list = host.state.rows; for (let index = 0; index < list.length; index += 10) list[index].label += " !!!"; }),
    swap: () => time(() => { const list = host.state.rows; const second = list[1]; list[1] = list[998]; list[998] = second; }),
    select: () => time(() => { host.state.selected = 5000; }),
    clear: () => time(() => { host.state.rows = []; }),
    count: () => root.querySelectorAll("tr").length,
  };
}`;

const directory = mkdtempSync(join(tmpdir(), "html-next-list-memory-"));
try {
  let baseSource = option("base-src");
  if (baseSource === undefined) {
    const revision = option("base") ?? "HEAD";
    const archive = execFileSync("git", ["archive", revision, "packages/html-next/src"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    mkdirSync(join(directory, "base"));
    execFileSync("tar", ["-xf", "-", "-C", join(directory, "base")], { input: archive });
    baseSource = join(directory, "base/packages/html-next/src");
  }
  const sources = { base: resolve(baseSource), candidate: join(root, "packages/html-next/src") };
  const bundles: Record<string, string> = {};
  for (const [name, source] of Object.entries(sources)) {
    bundles[name] = join(directory, `${name}.js`);
    await build({
      entryPoints: [join(source, "runtime.ts")], bundle: true, format: "iife", globalName: "BareRuntime",
      outfile: bundles[name], platform: "browser", target: ["es2022"], minify: true,
    });
  }

  const browser = await chromium.launch({ headless: true });
  const samples: Record<string, Record<string, number[]>> = { base: {}, candidate: {} };
  try {
    for (let round = 0; round < rounds; round += 1) {
      // Alternate which entry runs first so neither always gets the warmer process.
      for (const name of round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) {
        const page = await browser.newPage();
        const cdp = await page.context().newCDPSession(page);
        const heap = async (): Promise<number> => {
          await cdp.send("HeapProfiler.collectGarbage");
          return (await cdp.send("Runtime.getHeapUsage")).usedSize;
        };
        await page.setContent('<table id="case"></table>');
        await page.addScriptTag({ path: bundles[name]! });
        // A string, not a function: tsx would inject its `__name` helper, which the page lacks.
        await page.addScriptTag({ content: `(${pageSetup})(${JSON.stringify(JSON.stringify(definition))});` });
        const record = (metric: string, value: number): void => { (samples[name]![metric] ??= []).push(value); };
        const empty = await heap();
        record("create10k ms", await page.evaluate<number>("window.bench.create()"));
        if (await page.evaluate<number>("window.bench.count()") !== 10_000) throw new Error(`${name} did not render 10,000 rows.`);
        record("retained heap MB", ((await heap()) - empty) / 1024 / 1024);
        record("update10th ms", await page.evaluate<number>("window.bench.update()"));
        record("swap ms", await page.evaluate<number>("window.bench.swap()"));
        record("select ms", await page.evaluate<number>("window.bench.select()"));
        record("clear ms", await page.evaluate<number>("window.bench.clear()"));
        await page.close();
      }
    }
  } finally { await browser.close(); }

  const median = (values: number[]): number => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const rows = Object.keys(samples.base!).map((metric) => {
    const base = median(samples.base![metric]!);
    const candidate = median(samples.candidate![metric]!);
    return { metric, base: Number(base.toFixed(2)), candidate: Number(candidate.toFixed(2)), ratio: Number((candidate / base).toFixed(3)) };
  });
  console.table(rows);
} finally { rmSync(directory, { recursive: true, force: true }); }
