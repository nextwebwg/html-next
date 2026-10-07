import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type CDPSession, type Page } from "playwright";

import { parseComponent } from "../src/source-parser.js";
import { compileComponentStylesForBuild } from "../src/component-styles-build.js";

// All browser work is serial. Raw Chromium traces are DevTools Performance-compatible JSON.
const argument = (name: string, fallback: string): string =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = resolve(argument("out", ".context/compound-engineering/ce-optimize/style-delivery/results"));
const definitions = Number(argument("definitions", "24"));
const instances = Number(argument("instances", "8"));
const background = Number(argument("background", "3000"));
const samples = Number(argument("samples", "7"));
const warmups = Number(argument("warmups", "2"));
const traceSamples = Number(argument("traces", "1"));
const engineNames = argument("engines", "chromium,firefox,webkit").split(",");
for (const value of [definitions, instances, background, samples, warmups, traceSamples]) {
  assert(Number.isInteger(value) && value >= 0);
}
assert(definitions > 0 && instances > 0 && samples > 0);

const variants = [
  "initial-live", "initial-live-aa", "initial-fragment", "initial-merged", "initial-preloaded",
  "ssr-live", "ssr-owned", "ssr-preloaded",
  "late-live", "late-preloaded", "late-live-validity", "late-live-frames",
  "native-batch", "native-frames", "native-forced", "native-style-containment",
  "native-layout-paint", "native-strict", "native-preloaded",
] as const;
type Variant = typeof variants[number];
const selected = argument("variants", "").split(",").filter(Boolean);
const cases = variants.filter((variant) => selected.length === 0 || selected.includes(variant));
assert(cases.length > 0);

const sources = Array.from({ length: definitions }, (_, index) => {
  const css = [
    `:host { display: block; box-sizing: border-box; width: 240px; height: 96px; padding: 8px; border: 1px solid rgb(20, 30, 40); background: rgb(${200 + index % 30}, 220, 240); }`,
    "h2 { font-size: 16px; margin: 0; } .cell { display: inline-block; padding: 2px; }",
    ...Array.from({ length: 8 }, (_, cell) => `.cell[data-cell="${cell}"] { color: rgb(${20 + cell}, 40, 60); }`),
    ":host:has(.cell) { border-radius: 4px; }",
    // Exercise validity rewriting as well as ordinary component CSS.
    ".cell:invalid { outline: 1px solid red; }",
  ].join("\n");
  const markup = `<article class="card"><h2>Card ${index}</h2>` +
    Array.from({ length: 8 }, (_, cell) => `<span class="cell" data-cell="${cell}">Cell ${cell}</span>`).join("") + "</article>";
  return `<template component="bench-card-${index}" status="experimental" summary="Style delivery measurement.">${markup}<style>${css}</style></template>`;
});
const compiled = sources.map((source) => {
  const definition = parseComponent(source);
  return compileComponentStylesForBuild(definition.css, definition).css;
});
const withoutStyles = sources.map((source) => source.replace(/<style>[\s\S]*?<\/style>/, ""));
const invocations = sources.map((_, index) =>
  Array.from({ length: instances }, () => `<bench-card-${index}></bench-card-${index}>`).join(""));
const nativeRoots = sources.map((source, index) => {
  const markup = source.match(/<article[\s\S]*?<\/article>/)![0]
    .replace('<article class="card">', `<article class="card" data-component="bench-card-${index}">`);
  return markup.repeat(instances);
}).join("");
const backdrop = Array.from({ length: background }, (_, index) =>
  `<div class="background"><span>Background ${index}</span><span>Text</span></div>`).join("");
const baseCSS = "body{margin:0;font-family:sans-serif}main{display:grid;grid-template-columns:repeat(4,240px);gap:4px}.background{display:block;height:16px}";

interface Result {
  readonly operation_ms: number;
  readonly settled_ms: number;
  readonly style_nodes_added: number;
  readonly style_text_writes: number;
  readonly connected_cssom_reads: number;
  readonly constructed_sheet_replacements: number;
  readonly companion_bytes: number;
  readonly root_count: number;
  readonly style_nodes: number;
  readonly color: string;
  readonly width: string;
  readonly height: string;
}
interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly args?: { readonly elementCount?: number; readonly beginData?: { readonly dirtyObjects?: number; readonly totalObjects?: number } };
}
interface Trace {
  readonly traceEvents: readonly TraceEvent[];
}

function summarizeTrace(trace: Trace): Record<string, unknown> {
  const start = trace.traceEvents.find((event) => event.name === "style-delivery-start");
  const end = trace.traceEvents.find((event) => event.name === "style-delivery-end");
  assert(start !== undefined && end !== undefined, "Trace needs both measurement marks");
  const events = trace.traceEvents.filter((event) => event.ph === "X" &&
    event.pid === start.pid && event.tid === start.tid && event.ts >= start.ts && event.ts < end.ts);
  const names = ["UpdateLayoutTree", "RecalculateStyles", "Layout", "Paint", "ParseAuthorStyleSheet"];
  const summary: Record<string, unknown> = {};
  for (const name of names) {
    const matching = events.filter((event) => event.name === name);
    summary[name] = {
      count: matching.length,
      total_ms: matching.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000,
      elements: matching.reduce((total, event) => total + (event.args?.elementCount ?? 0), 0),
      dirty_objects: matching.reduce((total, event) => total + (event.args?.beginData?.dirtyObjects ?? 0), 0),
    };
  }
  summary.renderer_ms = events.filter((event) => ["UpdateLayoutTree", "RecalculateStyles", "Layout", "Paint"].includes(event.name))
    .reduce((total, event) => total + (event.dur ?? 0), 0) / 1000;
  return summary;
}

async function stopTrace(session: CDPSession): Promise<Trace> {
  const complete = new Promise<{ stream?: string }>((done) => session.once("Tracing.tracingComplete", done));
  await session.send("Tracing.end");
  const { stream } = await complete;
  assert(stream !== undefined, "Tracing did not return a stream");
  let source = "";
  for (;;) {
    const chunk = await session.send("IO.read", { handle: stream }) as { data: string; eof: boolean; base64Encoded?: boolean };
    source += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
    if (chunk.eof) break;
  }
  await session.send("IO.close", { handle: stream });
  return JSON.parse(source) as Trace;
}

async function prepare(page: Page, variant: Variant, bundle: string): Promise<void> {
  const native = variant.startsWith("native-");
  const preloaded = variant.endsWith("preloaded");
  const ssr = variant.startsWith("ssr-");
  const initial = variant.startsWith("initial-") || ssr;
  const containment = variant === "native-style-containment" ? "style" :
    variant === "native-layout-paint" ? "layout paint" : variant === "native-strict" ? "strict" : "none";
  const templates = preloaded ? withoutStyles : sources;
  const ownership = variant === "ssr-owned" ? ` data-html-next-component-styles="${sources.map((_, index) => `bench-card-${index}`).join(" ")}" data-html-next-style-states='{}'` : "";
  await page.setContent(`<!doctype html><html><head><style>${baseCSS}\n.card{contain:${containment};display:block;box-sizing:border-box;width:240px;height:96px}</style>` +
    (preloaded || ssr ? `<style${ownership}>${compiled.join("\n")}</style>` : "") +
    `</head><body>${initial ? templates.join("") : ""}<main>${native || ssr ? nativeRoots : initial ? invocations.join("") : ""}</main><aside>${backdrop}</aside></body></html>`);
  await page.addScriptTag({ path: bundle });
  // tsx preserves nested function names through this helper when serializing evaluate callbacks.
  await page.addScriptTag({ content: "window.__name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });" });
  await page.evaluate((observe) => {
    const runtime = (window as unknown as { HtmlRuntime: { observeDocument(): unknown; installValidityStyles?: (document: Document) => void; setElementValidity(element: Element, validity: { valid: boolean; errors: [] }): void } }).HtmlRuntime;
    if (observe === "late-live-validity") {
      // A saved baseline bundle exposes the removed scanner. Current bundles exercise validation.
      if (runtime.installValidityStyles !== undefined) runtime.installValidityStyles(document);
      else runtime.setElementValidity(document.createElement("div"), { valid: true, errors: [] });
    }
    if (observe.startsWith("late-")) runtime.observeDocument();
  }, variant);
  // Ensure setup has finished rendering. The measured region starts on a later frame.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function exercise(page: Page, variant: Variant): Promise<Result> {
  return page.evaluate(async ({ variant: mode, css, templates, uses }) => {
    const runtime = (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime;
    const counts = { added: 0, writes: 0, reads: 0, replacements: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof HTMLStyleElement) counts.writes += 1;
        for (const node of record.addedNodes) {
          if (node instanceof HTMLStyleElement) counts.added += 1;
        }
      }
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    const rules = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, "cssRules")!;
    Object.defineProperty(CSSStyleSheet.prototype, "cssRules", { ...rules, get(this: CSSStyleSheet) {
      if (this.ownerNode?.parentNode === document.head) counts.reads += 1;
      return rules.get!.call(this);
    } });
    const replace = CSSStyleSheet.prototype.replaceSync;
    CSSStyleSheet.prototype.replaceSync = function (text: string): void {
      counts.replacements += 1;
      replace.call(this, text);
    };
    const nextFrame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const appendStyle = (text: string): void => {
      const style = document.createElement("style");
      style.textContent = text;
      document.head.append(style);
    };
    performance.mark("style-delivery-start");
    const start = performance.now();
    if (mode.startsWith("initial-") || mode.startsWith("ssr-")) {
      if (mode === "initial-fragment" || mode === "initial-merged") {
        const append = document.head.append;
        const styles: HTMLStyleElement[] = [];
        document.head.append = function (...nodes: (Node | string)[]): void {
          for (const node of nodes) {
            if (node instanceof HTMLStyleElement) styles.push(node);
            else append.call(document.head, node);
          }
        };
        try { runtime.lowerDocument(); } finally { document.head.append = append; }
        if (mode === "initial-fragment") {
          const fragment = document.createDocumentFragment();
          fragment.append(...styles);
          document.head.append(fragment);
        } else appendStyle(styles.map((style) => style.textContent).join("\n"));
      } else runtime.lowerDocument();
    } else if (mode.startsWith("late-")) {
      if (mode === "late-live-frames") {
        for (const [index, template] of templates.entries()) {
          document.body.insertAdjacentHTML("beforeend", template);
          document.querySelector("main")!.insertAdjacentHTML("beforeend", uses[index]!);
          await nextFrame();
        }
      } else {
        document.body.insertAdjacentHTML("beforeend", templates.join(""));
        document.querySelector("main")!.insertAdjacentHTML("beforeend", uses.join(""));
      }
      // Let native MutationObservers run without yielding to an additional animation frame.
      await new Promise<void>((done) => queueMicrotask(() => queueMicrotask(done)));
    } else if (mode !== "native-preloaded") {
      for (const [index, text] of css.entries()) {
        appendStyle(text);
        if (mode === "native-frames") await nextFrame();
        else if (mode !== "native-batch") {
          // A deliberate application geometry read after each stylesheet; expose forced reflow.
          const root = document.querySelector(`[data-component="bench-card-${index}"]`) as HTMLElement;
          void root.offsetHeight;
        }
      }
    }
    const operation = performance.now() - start;
    await nextFrame();
    const settled = performance.now() - start;
    performance.mark("style-delivery-end");
    observer.disconnect();
    Object.defineProperty(CSSStyleSheet.prototype, "cssRules", rules);
    CSSStyleSheet.prototype.replaceSync = replace;
    const roots = document.querySelectorAll("main > article");
    const cell = roots[0]!.querySelector(".cell")!;
    cell.setAttribute("data-invalid", "");
    if (getComputedStyle(cell).outlineColor !== "rgb(255, 0, 0)") throw new Error("Compiled validity selectors stopped matching");
    const computed = getComputedStyle(roots[0]!);
    return {
      operation_ms: operation, settled_ms: settled,
      style_nodes_added: counts.added, style_text_writes: counts.writes,
      connected_cssom_reads: counts.reads, constructed_sheet_replacements: counts.replacements,
      companion_bytes: document.querySelector("[data-html-next-validity-styles]")?.textContent?.length ?? 0,
      root_count: roots.length, style_nodes: document.head.querySelectorAll("style").length,
      color: computed.backgroundColor, width: computed.width, height: computed.height,
    };
  }, { variant, css: compiled, templates: variant.endsWith("preloaded") ? withoutStyles : sources, uses: invocations });
}

function stats(values: readonly number[]): { median: number; min: number; max: number; p95: number } {
  const ordered = [...values].sort((left, right) => left - right);
  return { median: ordered[Math.floor(ordered.length / 2)]!, min: ordered[0]!, max: ordered.at(-1)!,
    p95: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]! };
}

await mkdir(output, { recursive: true });
const bundle = resolve(argument("runtime-bundle", resolve(output, "live-runtime.js")));
const validityEntry = resolve(output, "entry.ts");
await writeFile(validityEntry, `export * from ${JSON.stringify(new URL("../src/live.ts", import.meta.url).pathname)};\nexport { setElementValidity } from ${JSON.stringify(new URL("../src/validity.ts", import.meta.url).pathname)};\n`);
if (argument("runtime-bundle", "") === "") {
  await build({ entryPoints: [validityEntry], outfile: bundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
}
await writeFile(resolve(output, "navigation-fixture.json"), JSON.stringify({ compiled, nativeRoots, backdrop, baseCSS }));
const report: { metadata: Record<string, unknown>; runs: Record<string, Record<string, Result[]>>; traces: Record<string, unknown>; summary: Record<string, unknown> } = {
  metadata: { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runtime_bundle_sha256: createHash("sha256").update(await readFile(bundle)).digest("hex"),
    script_sha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    platform: process.platform, architecture: process.arch, node: process.version,
    definitions, instances_per_definition: instances, background_rows: background, warmups, samples, traceSamples,
    stylesheet_bytes: compiled.join("\n").length, stylesheet_gzip_bytes: gzipSync(compiled.join("\n")).length,
    browser_versions: {}, ordering: "rotated per round; one page at a time", tracing: "separate from timing samples; unthrottled headless Chromium" },
  runs: {}, traces: {}, summary: {},
};
const persist = async (): Promise<void> => {
  const path = resolve(output, "results.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report);
};
await persist();
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
for (const engineName of engineNames) {
  assert(engines[engineName] !== undefined, `Unknown engine: ${engineName}`);
  const browser = await engines[engineName]!.launch({ headless: true });
  try {
    (report.metadata.browser_versions as Record<string, string>)[engineName] = browser.version();
    const engineRuns: Record<string, Result[]> = {};
    report.runs[engineName] = engineRuns;
    for (const variant of cases) engineRuns[variant] = [];
    for (let round = 0; round < warmups + samples; round += 1) {
      const ordering = [...cases.slice(round % cases.length), ...cases.slice(0, round % cases.length)];
      for (const variant of ordering) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
        try {
          await prepare(page, variant, bundle);
          const result = await exercise(page, variant);
          assert.equal(result.root_count, definitions * instances, `${engineName}/${variant}: roots`);
          assert.equal(result.color, "rgb(200, 220, 240)", `${engineName}/${variant}: CSS applied`);
          assert.equal(result.width, "240px");
          assert.equal(result.height, "96px");
          if (round >= warmups) { engineRuns[variant]!.push(result); await persist(); }
        } finally { await page.close(); }
      }
      process.stderr.write(`${engineName}: timing round ${round + 1}/${warmups + samples}\n`);
    }
    report.summary[engineName] = Object.fromEntries(cases.map((variant) => [variant, {
      operation_ms: stats(engineRuns[variant]!.map((run) => run.operation_ms)),
      settled_ms: stats(engineRuns[variant]!.map((run) => run.settled_ms)),
      counts: engineRuns[variant]![0],
    }]));
    await persist();
    if (engineName === "chromium") {
      for (const variant of cases) {
        const summaries = [];
        for (let index = 0; index < traceSamples; index += 1) {
          const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
          try {
            await prepare(page, variant, bundle);
            const session = await page.context().newCDPSession(page);
            await session.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.invalidationTracking", transferMode: "ReturnAsStream" });
            const result = await exercise(page, variant);
            const trace = await stopTrace(session);
            const tracePath = resolve(output, `${variant}-${index + 1}.trace.json`);
            await writeFile(tracePath, JSON.stringify(trace));
            const summary = summarizeTrace(JSON.parse(await readFile(tracePath, "utf8")) as Trace);
            summaries.push({ file: tracePath, result, rendering: summary });
            report.traces[variant] = summaries;
            await persist();
            await session.detach();
          } finally { await page.close(); }
        }
        process.stderr.write(`chromium: traced ${variant}\n`);
      }
    }
  } finally { await browser.close(); }
}
process.stdout.write(`${JSON.stringify({ output, summary: report.summary, traces: report.traces }, null, 2)}\n`);
