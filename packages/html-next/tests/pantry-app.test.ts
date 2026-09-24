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
 * One scenario drives both, and every step must observe the same DOM: the proposal requires the
 * delivery modes to agree on the observable result (https://nextwebwg.org/html-next/). Engine
 * coverage is the conformance suite's job, so this test uses Chromium.
 *
 * Run with:  HTMLNEXT_BROWSER_TEST=1 pnpm exec vitest run --config vitest.browser.config.ts \
 *              packages/html-next/tests/pantry-app.test.ts
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
  const suggestions = Array.from(document.querySelectorAll("li.suggestion")).map((hit) =>
    hit.querySelector(".suggestion__label").textContent + " (" + hit.querySelector(".suggestion__unit").textContent + ")");
  return { rows, stats, notices, suggestions };
})()`;

/**
 * Drives the app as a user would: real keystrokes and clicks, so native constraint validation
 * sees user-entered values. Identical for both deliveries.
 */
async function runScenario(page: Page): Promise<Record<string, unknown>> {
  const transcript: Record<string, unknown> = {};
  const settle = async () => { await page.waitForTimeout(150); };
  // Declared reads are debounced and asynchronous, so snapshots wait for them to settle rather
  // than racing them.
  const settleReads = async () => {
    // Wait past the 150ms debounce so a queued read has started, then for it to finish.
    await page.waitForTimeout(300);
    await page.waitForFunction(
      `!Array.from(document.querySelectorAll(".notice")).some((note) => note.textContent.includes("Searching"))`,
    );
    await settle();
  };
  // Every snapshot waits for declared reads first: a debounced read in flight would otherwise be
  // captured in one delivery and not the other, purely on timing.
  const snapshot = async (step: string) => {
    await settleReads();
    transcript[step] = await page.evaluate(snapshotScript);
  };
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

  // A declared <data> read sends state to the endpoint as query parameters and renders the JSON
  // that comes back. Typing re-requests; the debounce coalesces the keystrokes.
  await retype('input[name="catalog-query"]', "oli");
  await page.waitForFunction(`document.querySelectorAll("li.suggestion").length > 0`);
  await snapshot("catalogSearched");
  // "Green olives" is not stocked yet; "Olive oil" already is, which the controller de-duplicates.
  await page.locator("li.suggestion", { has: page.locator('.suggestion__label:text-is("Green olives")') })
    .locator("button").click();
  await snapshot("catalogAdded");

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

async function transcriptFor(browser: Browser, serve: (url: URL) => Promise<string | undefined>) {
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  const requested: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    requested.push(`${url.pathname}${url.search}`);
    const body = await serve(url);
    const path = url.pathname;
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
      // The example's own vite.config.mjs imports the package by name, which needs a built dist.
      // This build supplies the plugin and source aliases itself, so skip config discovery.
      configFile: false,
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
    // The same JSON endpoints the example's dev server provides, including the catalog's
    // reactive query parameters.
    const stock = await readFile(new URL("api/pantry.json", example), "utf8");
    const catalog = JSON.parse(await readFile(new URL("api/catalog.json", example), "utf8")) as
      { id: string; label: string; unit: string }[];
    const endpoints = async (url: URL): Promise<string | undefined> => {
      if (url.pathname === "/api/pantry") return stock;
      if (url.pathname === "/api/catalog") {
        const needle = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const limit = Number(url.searchParams.get("limit") ?? 5);
        const hits = needle === "" ? [] : catalog.filter((entry) => entry.label.toLowerCase().includes(needle));
        return JSON.stringify(hits.slice(0, limit));
      }
      return undefined;
    };

    const liveRun = await transcriptFor(browser, async (url) => {
      const served = await endpoints(url);
      if (served !== undefined) return served;
      if (url.pathname === "/") return readFile(new URL("index.html", example), "utf8");
      if (url.pathname === "/dist/browser-loader.bundle.js") return loaderBundle;
      if (url.pathname.startsWith("/components/") || url.pathname === "/live.js") {
        return readFile(new URL(`.${url.pathname}`, example), "utf8").catch(() => undefined);
      }
      return undefined;
    });

    const compiledRun = await transcriptFor(browser, async (url) => {
      const served = await endpoints(url);
      if (served !== undefined) return served;
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
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

    // Both deliveries make the same declared requests: the typed read on connection, and the
    // catalog read carrying the search state as serialized query parameters.
    for (const run of [liveRun, compiledRun]) {
      assert.ok(run.requested.includes("/api/pantry"), "declared read runs on connection");
      const catalogReads = run.requested.filter((path) => path.startsWith("/api/catalog"));
      // The state travels as serialized query parameters, and every param change re-reads:
      // once for the typed search, and again when choosing a hit clears the box.
      assert.ok(catalogReads.includes("/api/catalog?q=oli&limit=5"), catalogReads.join(" "));
      assert.equal(catalogReads.at(-1), "/api/catalog?q=&limit=5");
      // 150ms of debounce coalesces the three keystrokes into a single search read.
      const searches = catalogReads.filter((path) => !path.includes("q=&"));
      assert.ok(searches.length <= 2, `debounced catalog searches: ${searches.join(" ")}`);
    }

    interface Step {
      readonly rows: { label: string; count: string; badge: string }[];
      readonly stats: string[];
      readonly notices: string[];
      readonly suggestions: string[];
    }
    const steps = live as Record<string, Step>;
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

    // The endpoint filtered the catalog; the component rendered exactly what came back.
    assert.deepEqual(steps.catalogSearched!.suggestions, ["Olive oil (bottles)", "Green olives (jars)"]);
    assert.deepEqual(
      steps.catalogAdded!.rows.find((row) => row.label === "Green olives"),
      // A true boolean binding renders as the empty attribute value, like `disabled`.
      { label: "Green olives", count: "1 jars", badge: "Low", tone: "warning", low: "", decrementDisabled: false },
    );
    // The already-stocked hit was not duplicated or reset.
    assert.equal(steps.catalogAdded!.rows.filter((row) => row.label === "Olive oil").length, 1);
    // Choosing a hit clears the search, so the suggestion list empties.
    assert.deepEqual(steps.catalogAdded!.suggestions, []);
    // A required field left empty submits nothing: the row count is unchanged.
    assert.equal(steps.rejectedEmptyLabel!.rows.length, steps.catalogAdded!.rows.length);
    assert.deepEqual(
      steps.added!.rows.find((row) => row.label === "Peanut butter"),
      // `:data-low` removes the attribute when false, which is the ordinary attribute semantic.
      { label: "Peanut butter", count: "2 pcs", badge: "Stocked", tone: "neutral", low: null, decrementDisabled: false },
    );
    assert.ok(steps.restockedAll!.rows.every((row) => row.badge === "Stocked"));
    assert.deepEqual(steps.restockedAll!.stats, ["Items=7", "Low=0"]);
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
