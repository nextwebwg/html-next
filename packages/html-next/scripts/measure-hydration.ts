import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

const rows = 250;
const warmups = 2;
const samples = 7;
const runtimeURL = new URL("../src/live.ts", import.meta.url);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-hydration-"));
const bundlePath = join(temporaryDirectory, "runtime.js");

const definition = `<template component="hydration-row" status="experimental" summary="Hydration benchmark.">
  <defs><prop name="label" type="string" default="Default">Label.</prop></defs>
  <article><h2 $value="label"></h2><input .value="label"><slot></slot></article>
</template>`;

function invocation(index: number): string {
  return `<hydration-row label="Row ${index}"><span>Projected ${index}</span></hydration-row>`;
}

/**
 * The server markup to adopt, captured by lowering the authored instances once and serializing the
 * result. Hand-written markup goes stale the moment the rendered form changes — it did, and this
 * benchmark measured nothing for as long as it was wrong. A real lowering pass is the only honest
 * source of "what a server would have sent".
 */
async function captureServerMarkup(page: Page): Promise<string> {
  const authored = Array.from({ length: rows }, (_, index) => invocation(index)).join("");
  await page.setContent(`${definition}<main>${authored}</main>`);
  await page.addScriptTag({ path: bundlePath });
  return page.evaluate(() => {
    (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
    return document.querySelector("main")!.innerHTML;
  });
}

interface RunResult {
  readonly duration: number;
  readonly focused: boolean;
  readonly inputIdentity: boolean;
  readonly lowered: number;
  readonly rootIdentity: boolean;
  readonly selection: readonly [number | null, number | null];
  readonly value: string;
}

async function measurePage(page: Page, hydration: boolean, serverMarkup: string): Promise<RunResult> {
  const instances = hydration
    ? serverMarkup
    : Array.from({ length: rows }, (_, index) => invocation(index)).join("");
  await page.setContent(`${definition}<main>${instances}</main>`);
  await page.addScriptTag({ path: bundlePath });
  return page.evaluate((adopt) => {
    const main = document.querySelector("main")!;
    const beforeRoots = adopt ? Array.from(main.children) : [];
    const beforeInput = adopt ? beforeRoots[0]?.querySelector("input") ?? null : null;
    if (beforeInput instanceof HTMLInputElement) {
      beforeInput.value = "user edit";
      beforeInput.focus();
      beforeInput.setSelectionRange(2, 6);
    }
    const start = performance.now();
    const lowered = (window as unknown as {
      HtmlRuntime: { lowerDocument(): number };
    }).HtmlRuntime.lowerDocument();
    const duration = performance.now() - start;
    const afterRoots = Array.from(main.children);
    const afterInput = afterRoots[0]?.querySelector("input") ?? null;
    return {
      duration,
      focused: adopt ? document.activeElement === beforeInput : true,
      inputIdentity: adopt ? afterInput === beforeInput : true,
      lowered,
      rootIdentity: adopt
        ? afterRoots.every((root, index) => root === beforeRoots[index])
        : afterRoots.every((root) => root.localName === "article"),
      selection: adopt && beforeInput instanceof HTMLInputElement
        ? [beforeInput.selectionStart, beforeInput.selectionEnd] as const
        : [null, null] as const,
      value: adopt && beforeInput instanceof HTMLInputElement ? beforeInput.value : "user edit",
    };
  }, hydration);
}

function summary(values: readonly number[]): { readonly median: number; readonly p95: number } {
  const ordered = [...values].sort((left, right) => left - right);
  const median = ordered[Math.floor(ordered.length / 2)]!;
  const p95 = ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]!;
  return { median, p95 };
}

async function measureEngine(engine: BrowserType): Promise<Record<string, unknown>> {
  const browser = await engine.launch({ headless: true });
  try {
    const capture = await browser.newPage();
    let serverMarkup = "";
    try {
      serverMarkup = await captureServerMarkup(capture);
    } finally {
      await capture.close();
    }
    const run = async (hydration: boolean): Promise<readonly number[]> => {
      const durations: number[] = [];
      for (let index = 0; index < warmups + samples; index += 1) {
        const page = await browser.newPage();
        try {
          const result = await measurePage(page, hydration, serverMarkup);
          assert.equal(result.lowered, rows);
          assert.equal(result.rootIdentity, true);
          assert.equal(result.inputIdentity, true);
          assert.equal(result.focused, true);
          assert.equal(result.value, "user edit");
          assert.deepEqual(result.selection, hydration ? [2, 6] : [null, null]);
          if (index >= warmups) durations.push(result.duration);
        } finally {
          await page.close();
        }
      }
      return durations;
    };
    const adoption = await run(true);
    const lowering = await run(false);
    return {
      adoption_ms: summary(adoption),
      adoption_ms_per_root: summary(adoption.map((duration) => duration / rows)),
      lowering_ms: summary(lowering),
      lowering_ms_per_root: summary(lowering.map((duration) => duration / rows)),
    };
  } finally {
    await browser.close();
  }
}

try {
  await build({
    entryPoints: [runtimeURL.pathname],
    outfile: bundlePath,
    bundle: true,
    format: "iife",
    globalName: "HtmlRuntime",
    platform: "browser",
    target: ["es2022"],
  });
  const results: Record<string, unknown> = {
    rows,
    samples,
    warmups,
  };
  for (const [name, engine] of [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ] as const) {
    results[name] = await measureEngine(engine);
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
