/**
 * Whole-application proof for the two browser delivery modes.
 *
 * The `examples/pantry` app is a data-driven pantry list: purely declarative components
 * (`ui-badge`, `ui-stat`, `pantry-shell`, `pantry-item`) plus one controller-backed component
 * (`pantry-app`). The same component sources are delivered two ways:
 *
 *  - live: the page links one root and the browser parses the graph at runtime;
 *  - pre-compiled: a Vite build parses the graph and ships only the definitions.
 *
 * One scenario script drives both and every step must observe the same DOM, which is the
 * delivery-mode agreement required by docs/spec/delivery-modes.md. Engine coverage is the
 * conformance suite's job; this test is about the two deliveries agreeing, so it uses Chromium.
 *
 * Run with:  HTMLNEXT_BROWSER_TEST=1 pnpm exec vitest run --config vitest.browser.config.ts \
 *              packages/declarative-components/tests/pantry-app.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { build as viteBuild } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";

import { pantryPrecompile } from "../examples/pantry/precompile.mjs";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const example = new URL("../examples/pantry/", import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://pantry.test";

/** Source-tree aliases so the example builds against this checkout rather than a published copy. */
const alias = {
  "@nextwebwg/html-next/runtime": join(packageRoot, "src/runtime.ts"),
  "@nextwebwg/html-next": join(packageRoot, "src/index.ts"),
};

/** Reads everything the assertions care about out of the page. */
const snapshotScript = `(() => {
  const rows = Array.from(document.querySelectorAll("li.item")).map((row) => ({
    label: row.querySelector(".item__label").textContent,
    count: row.querySelector(".item__count").textContent,
    badge: row.querySelector(".badge").textContent,
    tone: row.querySelector(".badge").getAttribute("data-tone"),
    low: row.getAttribute("data-low"),
    decrementDisabled: row.querySelector(".item__step").disabled,
  }));
  const stats = Array.from(document.querySelectorAll(".stat")).map((stat) =>
    stat.querySelector(".stat__label").textContent + "=" + stat.querySelector(".stat__value").textContent);
  const notices = Array.from(document.querySelectorAll(".notice")).map((note) => note.textContent);
  return { rows, stats, notices };
})()`;

/**
 * Drives the app as a user would: real keystrokes and clicks, so native constraint validation
 * sees user-entered values. Identical for both deliveries.
 */
async function runScenario(page: Page): Promise<Record<string, unknown>> {
  const transcript: Record<string, unknown> = {};
  const settle = async () => { await page.waitForTimeout(150); };
  const snapshot = async (step: string) => { transcript[step] = await page.evaluate(snapshotScript); };
  const row = (label: string) => page.locator("li.item", { has: page.locator(`.item__label:text-is("${label}")`) });
  const retype = async (selector: string, value: string) => {
    const field = page.locator(selector);
    await field.click();
    await field.press("ControlOrMeta+a");
    if (value === "") await field.press("Backspace");
    else await field.pressSequentially(value);
    await settle();
  };

  await page.waitForSelector("li.item");
  await snapshot("loaded");

  // Search narrows the rendered rows without changing the underlying list.
  await retype('input[name="query"]', "oat");
  await snapshot("searched");
  await retype('input[name="query"]', "zzz");
  await snapshot("searchedEmpty");
  await retype('input[name="query"]', "");

  // A row's own buttons only dispatch events; the controller decides what they mean.
  await row("Basmati rice").locator(".item__step").nth(1).click();
  await settle();
  await snapshot("restocked");
  await row("Tomato passata").locator(".item__step").nth(0).click({ force: true });
  await settle();
  await snapshot("decrementedAtZero");
  await row("Ground coffee").locator(".item__discard").click();
  await settle();
  await snapshot("discarded");

  // The add form is a native <form>: the browser blocks the empty required field, not the app.
  await page.locator('.field--add button[type="submit"]').click();
  await settle();
  await snapshot("rejectedEmptyLabel");
  await retype('input[name="label"]', "Peanut butter");
  await retype('input[name="quantity"]', "2");
  await page.locator('.field--add button[type="submit"]').click();
  await settle();
  await snapshot("added");

  // A declared public method reaches the controller's named export through the lowered root.
  // The outermost element carrying the component's lineage is its lowered root.
  await page.evaluate(`document.querySelector('[data-component~="pantry-app"]').restockAll()`);
  await settle();
  await snapshot("restockedAll");

  return transcript;
}

async function transcriptFor(browser: Browser, serve: (path: string) => Promise<string | undefined>) {
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  const requested: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    const body = await serve(path);
    if (body === undefined) return route.fulfill({ status: 404, body: "" });
    const type = path.endsWith(".json")
      ? "application/json"
      : path.endsWith(".js") || path.endsWith(".mjs")
        ? "text/javascript"
        : path.endsWith(".html") || path === "/"
          ? "text/html"
          : "text/plain";
    return route.fulfill({ status: 200, contentType: type, body });
  });
  await page.goto(`${origin}/`);
  const transcript = await runScenario(page);
  await page.close();
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  return { transcript, requested };
}

describe.skipIf(!enabled)("pantry example across delivery modes", () => {
  let browser: Browser;
  let directory = "";
  let loaderBundle = "";
  let compiledDirectory = "";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    directory = await mkdtemp(join(tmpdir(), "html-next-pantry-"));

    // Live delivery: the public browser loader, built from this checkout.
    const built = await esbuild({
      entryPoints: [join(packageRoot, "src/browser-loader.ts")],
      bundle: true, format: "esm", platform: "browser", target: ["es2022"], write: false,
    });
    loaderBundle = built.outputFiles[0]!.text;

    // Pre-compiled delivery: the same sources, parsed by the build.
    compiledDirectory = join(directory, "compiled");
    await viteBuild({
      root: fileURLToPath(new URL("compiled/", example)),
      logLevel: "silent",
      plugins: [pantryPrecompile(fileURLToPath(new URL("components/pantry-app.html", example)))],
      resolve: { alias },
      build: { outDir: compiledDirectory, emptyOutDir: true, minify: false },
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("renders and behaves identically when parsed live and when pre-compiled", async () => {
    const data = await readFile(new URL("api/pantry.json", example), "utf8");

    const liveRun = await transcriptFor(browser, async (path) => {
      if (path === "/") return readFile(new URL("index.html", example), "utf8");
      if (path === "/dist/browser-loader.bundle.js") return loaderBundle;
      if (path === "/api/pantry.json") return data;
      if (path.startsWith("/components/") || path === "/live.js") {
        return readFile(new URL(`.${path}`, example), "utf8").catch(() => undefined);
      }
      return undefined;
    });

    const compiledRun = await transcriptFor(browser, async (path) => {
      if (path === "/api/pantry.json") return data;
      const file = path === "/" ? "index.html" : path.slice(1);
      return readFile(join(compiledDirectory, file), "utf8").catch(() => undefined);
    });

    // Both deliveries must agree at every step, and must have actually done the work.
    const { transcript: live } = liveRun;
    for (const step of Object.keys(live)) {
      assert.deepEqual(compiledRun.transcript[step], live[step], `delivery modes disagree at step \`${step}\``);
    }

    // The deliveries differ only in where parsing happened: the live page fetches component
    // sources, the pre-compiled bundle carries them. Both still fetch the declared data.
    const sources = (paths: string[]) => paths.filter((path) => path.startsWith("/components/"));
    assert.ok(sources(liveRun.requested).length >= 5, "live delivery fetches component sources");
    assert.deepEqual(sources(compiledRun.requested), []);
    assert.ok(liveRun.requested.includes("/api/pantry.json"));
    assert.ok(compiledRun.requested.includes("/api/pantry.json"));

    const steps = live as Record<string, { rows: { label: string; count: string; badge: string }[]; stats: string[]; notices: string[] }>;
    assert.deepEqual(steps.loaded!.rows.map((row) => row.label), [
      "Basmati rice", "Black beans", "Ground coffee", "Olive oil", "Rolled oats", "Tomato passata",
    ]);
    assert.deepEqual(steps.loaded!.stats, ["Items=6", "Low=2"]);
    assert.deepEqual(steps.searched!.rows.map((row) => row.label), ["Rolled oats"]);
    assert.deepEqual(steps.searchedEmpty!.rows, []);
    assert.deepEqual(steps.searchedEmpty!.notices, ["Nothing matches that search."]);

    const rice = (step: keyof typeof steps) =>
      steps[step]!.rows.find((row) => row.label === "Basmati rice")!;
    assert.deepEqual(
      { count: rice("loaded").count, badge: rice("loaded").badge },
      { count: "1 kg", badge: "Low" },
    );
    assert.deepEqual(
      { count: rice("restocked").count, badge: rice("restocked").badge },
      { count: "2 kg", badge: "Stocked" },
    );

    // A zero-quantity row cannot go negative: its decrement control is disabled.
    const passata = steps.decrementedAtZero!.rows.find((row) => row.label === "Tomato passata")!;
    assert.equal(passata.count, "0 jars");

    assert.ok(!steps.discarded!.rows.some((row) => row.label === "Ground coffee"));
    // A required field left empty submits nothing: the row count is unchanged.
    assert.equal(steps.rejectedEmptyLabel!.rows.length, steps.discarded!.rows.length);
    assert.deepEqual(
      steps.added!.rows.find((row) => row.label === "Peanut butter"),
      // `:data-low` removes the attribute when false, which is the ordinary attribute semantic.
      { label: "Peanut butter", count: "2 pcs", badge: "Stocked", tone: "neutral", low: null, decrementDisabled: false },
    );
    assert.ok(steps.restockedAll!.rows.every((row) => row.badge === "Stocked"));
    assert.deepEqual(steps.restockedAll!.stats, ["Items=6", "Low=0"]);
  }, 180_000);

  it("carries the parsed graph in the pre-compiled bundle", async () => {
    const page = await readFile(join(compiledDirectory, "index.html"), "utf8");
    const asset = page.match(/src="([^"]+\.js)"/)?.[1] ?? "";
    const bundle = await readFile(join(compiledDirectory, asset.replace(/^\//, "")), "utf8");

    // The build resolved the graph: every component's contract is already in the bundle, and the
    // page needs no <link rel="component">.
    assert.match(bundle, /registerComponentDefinitions/);
    for (const tag of ["pantry-app", "pantry-item", "pantry-shell", "ui-badge", "ui-stat"]) {
      assert.match(bundle, new RegExp(`"tag":\\s*"${tag}"`), `${tag} is pre-parsed into the bundle`);
    }
    assert.doesNotMatch(page, /<link[^>]*rel="component"/);

    // Known gap: the general runtime still imports the browser parser for inline <template
    // component> discovery, so pre-compiling does not yet drop the parser from the bundle.
    assert.match(bundle, /parseComponentNodes/);
  }, 60_000);
});
